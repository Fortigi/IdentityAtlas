// The three steps against an in-memory stand-in for the database and the ingest.
// The stand-in answers the feature's queries by the table they read and applies
// ingest batches the way the engine does for these tables (a full contexts sync
// keeps exactly the batch for the system; a full members sync likewise), so these
// tests check the ORCHESTRATION: which batches are sent, in which mode, with which
// ids. The SQL itself is the contract test's (contract-tests/contextUpload).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { analyzeUpload, previewUpload, applyUpload, UploadError, ingestAll as all } from './service.js';
import { contextIdFor } from './records.js';
import { ROOT_KEY } from './plan.js';

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ctx-upl-svc-')); process.env.UPLOAD_ROOT = root; });
afterEach(async () => { delete process.env.UPLOAD_ROOT; await rm(root, { recursive: true, force: true }); });

function fakeStore() {
  const s = {
    systems: [], contexts: [], members: [], uploads: [], ingests: [],
    principals: [
      { id: 'P-ann', email: 'ann@x.nl', upn: null, employeeId: null, externalId: null, displayName: 'Ann' },
      { id: 'P-bob', email: 'bob@x.nl', upn: null, employeeId: null, externalId: null, displayName: 'Bob' },
    ],
    resources: [{ id: 'R-g1', externalId: 'G1', displayName: 'G1' }],
  };
  const sysRow = (id) => s.systems.find(x => x.id === Number(id));
  const lastUpload = (id) => s.uploads.filter(u => u.systemId === id).at(-1);
  s.db = {
    queryOne: vi.fn(async (sql, p) => {
      if (sql.includes('INSERT INTO "ContextUploads"')) {
        const row = { id: `u${s.uploads.length + 1}`, systemId: p[0], rootContextId: p[1], fileName: p[2], mapping: JSON.parse(p[5]), created: p[7], updated: p[8], unchanged: p[9], removed: p[10] };
        s.uploads.push(row);
        return { id: row.id, uploadedAt: new Date() };
      }
      if (sql.includes('WHERE s.id = $1')) {
        const sys = sysRow(p[0]);
        if (!sys || sys.systemType !== p[1]) return null;
        const u = lastUpload(sys.id);
        return { id: sys.id, displayName: sys.displayName, mapping: u?.mapping ?? null, fileName: u?.fileName, rootContextId: u?.rootContextId };
      }
      if (sql.includes('"displayName" = $2')) return s.systems.find(x => x.systemType === p[0] && x.displayName === p[1]) ?? null;
      throw new Error(`unexpected queryOne: ${sql}`);
    }),
    query: vi.fn(async (sql, p) => {
      if (sql.includes('FROM "Principals"')) return { rows: s.principals };
      if (sql.includes('FROM "Resources"')) return { rows: s.resources };
      if (sql.includes('FROM "Identities"')) return { rows: [] };
      if (sql.includes('FROM "ContextMembers" cm JOIN')) {
        return { rows: s.members.filter(m => p[0].includes(m.contextId)).map(m => ({ contextId: m.contextId, memberId: m.memberId, memberType: m.memberType })) };
      }
      if (sql.includes('FROM "Contexts" WHERE "scopeSystemId"')) return { rows: s.contexts.filter(c => c.scopeSystemId === p[0]) };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  s.runIngest = vi.fn(async (entity, body) => {
    s.ingests.push({ entity, syncMode: body.syncMode, scope: body.scope, count: body.records.length });
    if (entity === 'systems') {
      const id = s.systems.length + 11;
      s.systems.push({ id, ...body.records[0] });
      return { status: 201, body: { systemIds: [id] } };
    }
    if (entity === 'contexts') {
      s.contexts = [...s.contexts.filter(c => c.scopeSystemId !== body.systemId), ...body.records.map(r => ({ ...r }))];
      return { status: 201, body: { inserted: body.records.length, accountable: { set: 1, replaced: 0, removed: 0, unresolved: 0 } } };
    }
    const owned = new Set(s.contexts.filter(c => c.scopeSystemId === body.systemId).map(c => c.id));
    s.members = [...s.members.filter(m => !owned.has(m.contextId)), ...body.records];
    return { status: 201, body: {} };
  });
  s.insertRoleRows = vi.fn(async (rows) => ({ inserted: rows.length, skipped: 0 }));
  s.insertRelationshipRows = vi.fn(async (rows) => ({ inserted: rows.length, skipped: 0 }));
  s.refreshMemberCounts = vi.fn(async () => {});
  return s;
}

const KLANTEN = 'Klantnummer;Naam;Sector;Eigenaar;Gebruikers;Applicaties\n'
  + 'K1;Acme;Zorg;ann@x.nl;ann@x.nl; bob@x.nl;G1\n'
  + 'K2;Beta;Bouw;bob@x.nl;ghost@x.nl;G1\n';
// The members cell above holds a semicolon, so it has to be quoted.
const csvOf = (text) => Buffer.from(text.replace(/;ann@x\.nl; bob@x\.nl;/, ';"ann@x.nl; bob@x.nl";'));

async function analyzed(s, text = KLANTEN, fileName = 'klanten.csv', listId = null) {
  return analyzeUpload({ buffer: csvOf(text), fileName, uploadedBy: 'analyst@x.nl', listId }, { db: s.db, refine: async ({ guess }) => ({ mapping: guess, aiUsed: false, aiFields: [] }) });
}

describe('analyzeUpload', () => {
  it('stores the file as a draft and returns its columns with the heuristic guess', async () => {
    const s = fakeStore();
    const a = await analyzed(s);
    expect(a.rowCount).toBe(2);
    expect(a.columns.map(c => c.header)).toEqual(['Klantnummer', 'Naam', 'Sector', 'Eigenaar', 'Gebruikers', 'Applicaties']);
    expect(a.guess).toMatchObject({ listName: 'Klanten', keyColumn: 'Klantnummer', ownerColumn: 'Eigenaar' });
    expect(a.existingList).toBeNull();
    expect(await readdir(join(root, 'context-uploads'))).toContain(`${a.uploadDraftId}.data`);
  });

  it('an unknown listId is a 404, not a new list', async () => {
    await expect(analyzed(fakeStore(), KLANTEN, 'k.csv', 99)).rejects.toMatchObject({ status: 404 });
  });
});

describe('previewUpload', () => {
  it('counts a first upload as all new and reports the member matches', async () => {
    const s = fakeStore();
    const a = await analyzed(s);
    const p = await previewUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, { db: s.db });
    // Two trees (accounts, resources), each a root plus two customers.
    expect(p.contexts).toEqual({ created: 6, updated: 0, unchanged: 0, notInFile: 0 });
    expect(p.trees).toEqual([{ name: 'Klanten', kind: 'Principal' }, { name: 'Klanten · Resources', kind: 'Resource' }]);
    // Distinct values: ann, bob and G1 match (G1 counted once), ghost does not.
    expect(p.members).toMatchObject({ matched: 3, unmatched: 1, ambiguous: 0, unmatchedSamples: [{ kind: 'Principal', value: 'ghost@x.nl', reason: 'not found' }] });
    expect(s.runIngest).not.toHaveBeenCalled();
  });

  it('an expired draft is a 410 and a mapping naming a missing column a 400 with the reason', async () => {
    const s = fakeStore();
    await expect(previewUpload({ uploadDraftId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', mapping: {} }, { db: s.db })).rejects.toMatchObject({ status: 410 });
    const a = await analyzed(s);
    const err = await previewUpload({ uploadDraftId: a.uploadDraftId, mapping: { ...a.guess, ownerColumn: 'Boss' } }, { db: s.db }).catch(e => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual(['The owner column "Boss" is not in the file.']);
  });
});

describe('applyUpload — first upload', () => {
  it('registers the list, writes both trees, members, links and the run, and drops the draft', async () => {
    const s = fakeStore();
    const a = await analyzed(s);
    const r = await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, 'analyst@x.nl', s);
    expect(r.listId).toBe(11);
    expect(s.systems[0]).toMatchObject({ displayName: 'Klanten (upload)', systemType: 'Upload' });
    expect(r.rootContextId).toBe(contextIdFor(11, 'Principal', ROOT_KEY));
    expect(r.contexts).toEqual({ created: 6, updated: 0, unchanged: 0, removed: 0, notInFile: 0 });
    expect(s.ingests.map(i => [i.entity, i.syncMode])).toEqual([['systems', 'delta'], ['contexts', 'full'], ['context-members', 'full']]);
    expect(s.ingests[1].scope).toEqual({ variant: 'synced', scopeSystemId: 11 });
    // ann + bob on K1, bob's ghost unmatched on K2; G1 on both customers.
    expect(s.members.map(m => `${s.contexts.find(c => c.id === m.contextId).externalId}:${m.memberId}`).sort())
      .toEqual(['K1:P-ann', 'K1:P-bob', 'K1:R-g1', 'K2:R-g1']);
    expect(s.insertRelationshipRows.mock.calls[0][0]).toHaveLength(3);
    expect(r.accountable).toEqual({ set: 1, replaced: 0, removed: 0, unresolved: 0 });
    expect(s.uploads).toHaveLength(1);
    expect(s.uploads[0]).toMatchObject({ systemId: 11, fileName: 'klanten.csv', created: 6 });
    expect(await readdir(join(root, 'context-uploads'))).toEqual([]);
  });

  it('refuses a new list whose name was uploaded before (409) instead of merging into it', async () => {
    const s = fakeStore();
    const first = await analyzed(s);
    await applyUpload({ uploadDraftId: first.uploadDraftId, mapping: first.guess }, 'a', s);
    const second = await analyzed(s);
    expect(second.existingList).toMatchObject({ id: 11, listName: 'Klanten', lastFileName: 'klanten.csv' });
    await expect(applyUpload({ uploadDraftId: second.uploadDraftId, mapping: second.guess }, 'a', s)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses rows that cannot be imported, before writing anything', async () => {
    const s = fakeStore();
    const a = await analyzed(s, 'Code;Naam\nK1;A\nK1;B\n', 'x.csv');
    const err = await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: { ...a.guess, keyColumn: 'Code' } }, 'a', s).catch(e => e);
    expect(err.status).toBe(400);
    expect(err.details[0]).toMatch(/key "K1" is also on row 1/);
    expect(s.runIngest).not.toHaveBeenCalled();
  });

  it('a failing ingest batch surfaces as an error naming what was being written', async () => {
    const s = fakeStore();
    s.runIngest.mockResolvedValueOnce({ status: 201, body: { systemIds: [11] } })
      .mockResolvedValueOnce({ status: 422, body: { error: 'Context hierarchy would create a cycle' } });
    const a = await analyzed(s);
    await expect(applyUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, 'a', s))
      .rejects.toMatchObject({ status: 422, message: 'Context hierarchy would create a cycle (contexts)' });
  });
});

describe('applyUpload — re-import of the same list', () => {
  const V2 = 'Klantnummer;Naam;Sector;Eigenaar;Gebruikers;Applicaties\n'
    + 'K1;Acme BV;Zorg;ann@x.nl;bob@x.nl;G1\n';

  async function twice(removeMissing) {
    const s = fakeStore();
    const a = await analyzed(s);
    await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, 'a', s);
    const idsBefore = s.contexts.map(c => c.id).sort();
    const b = await analyzed(s, V2, 'klanten-v2.csv', 11);
    const r = await applyUpload({ uploadDraftId: b.uploadDraftId, mapping: b.guess, listId: 11, removeMissing }, 'a', s);
    return { s, r, idsBefore, b };
  }

  it('starts from the list\'s saved mapping and keeps the list name', async () => {
    const { b } = await twice(false);
    expect(b.guess).toMatchObject({ listName: 'Klanten', keyColumn: 'Klantnummer' });
    expect(b.existingList.id).toBe(11);
  });

  it('updates in place: same ids, no second system, the renamed customer updated', async () => {
    const { s, r, idsBefore } = await twice(false);
    expect(s.systems).toHaveLength(1);
    expect(s.contexts.map(c => c.id).sort()).toEqual(idsBefore);
    expect(s.contexts.find(c => c.externalId === 'K1' && c.targetType === 'Principal').displayName).toBe('Acme BV');
    // K1 renamed in both trees; the roots unchanged; K2 is not in the file.
    expect(r.contexts).toMatchObject({ created: 0, updated: 2, unchanged: 2, removed: 0, notInFile: 2 });
  });

  it('by default keeps a context the file no longer has, with its members', async () => {
    const { s } = await twice(false);
    const k2 = s.contexts.find(c => c.externalId === 'K2' && c.targetType === 'Resource');
    expect(k2.displayName).toBe('Beta');
    expect(s.members.filter(m => m.contextId === k2.id).map(m => m.memberId)).toEqual(['R-g1']);
    // K1's members follow the file: ann is gone, bob stays.
    const k1 = contextIdFor(11, 'Principal', 'K1');
    expect(s.members.filter(m => m.contextId === k1).map(m => m.memberId)).toEqual(['P-bob']);
  });

  it('an existing list keeps its name, whatever name the mapping sends', async () => {
    const s = fakeStore();
    const a = await analyzed(s);
    await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, 'a', s);
    const b = await analyzed(s, V2, 'klanten-v2.csv', 11);
    const p = await previewUpload({ uploadDraftId: b.uploadDraftId, mapping: { ...b.guess, listName: 'Renamed' }, listId: 11 }, { db: s.db });
    expect(p.trees[0].name).toBe('Klanten');
  });

  it('with removeMissing the contexts not in the file are removed', async () => {
    const { s, r } = await twice(true);
    expect(s.contexts.some(c => c.externalId === 'K2')).toBe(false);
    expect(r.contexts).toMatchObject({ removed: 2, notInFile: 0 });
    expect(s.uploads.at(-1)).toMatchObject({ removed: 2, fileName: 'klanten-v2.csv' });
  });
});

describe('ingestAll', () => {
  const ok = (syncId) => vi.fn(async (_e, body) => ({ status: 201, body: { syncId, n: body.records.length } }));

  it('sends a batch at the limit as one plain call', async () => {
    const run = ok();
    await all(run, 'contexts', { systemId: 1, records: [1, 2] }, 2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual({ systemId: 1, records: [1, 2] });
  });

  it('one record over the limit becomes a session: start, then end with the rest', async () => {
    const run = ok('S');
    await all(run, 'contexts', { systemId: 1, records: [1, 2, 3] }, 2);
    expect(run.mock.calls.map(c => [c[1].syncSession, c[1].syncId, c[1].records])).toEqual([['start', undefined, [1, 2]], ['end', 'S', [3]]]);
  });

  it('continues in the middle and stops at the first failure', async () => {
    const run = ok('S');
    await all(run, 'contexts', { records: [1, 2, 3, 4, 5] }, 2);
    expect(run.mock.calls.map(c => c[1].syncSession)).toEqual(['start', 'continue', 'end']);
    const failing = vi.fn().mockResolvedValueOnce({ status: 201, body: { syncId: 'S' } }).mockResolvedValueOnce({ status: 429, body: { error: 'busy' } });
    expect(await all(failing, 'contexts', { records: [1, 2, 3, 4, 5] }, 2)).toEqual({ status: 429, body: { error: 'busy' } });
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe('a SharePoint export: lookup members and owners named by display name', () => {
  // Team is a SharePoint person column ("name;#id;#…"); Eigenaar holds names,
  // one written "Last, First | Org", one with a typo.
  const SHAREPOINT = 'Title;Eigenaar;Team\n'
    + 'Unit A;Example, Ann | Some Org;"Ann Example;#27;#Bo Sampel;#16"\n'
    + 'Unit B;Cy Tset;"Bo Sample;#16"\n';
  const store = () => {
    const s = fakeStore();
    s.principals = [
      { id: 'P-ann', email: 'ann@x.nl', displayName: 'Ann Example', principalType: 'User' },
      { id: 'P-bo', email: 'bo@x.nl', displayName: 'Bo Sample', principalType: 'User' },
      { id: 'SP-bo', email: null, displayName: 'Bo Sample', principalType: 'ServicePrincipal' },
      { id: 'P-cy', email: 'cy@x.nl', displayName: 'Cy Test', principalType: 'User' },
    ];
    return s;
  };
  const sharepoint = async (s) => analyzeUpload({ buffer: Buffer.from(SHAREPOINT), fileName: 'teams.csv', uploadedBy: 'a' },
    { db: s.db, refine: async ({ guess }) => ({ mapping: guess, aiUsed: false, aiFields: [] }) });

  it('the preview counts every name of a lookup cell, by name and fuzzy apart, for members and owners', async () => {
    const s = store();
    const a = await sharepoint(s);
    expect(a.guess).toMatchObject({ nameColumn: 'Title', ownerColumn: 'Eigenaar', memberColumns: [{ column: 'Team', kind: 'Principal' }] });
    const p = await previewUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, { db: s.db });
    expect(p.members).toMatchObject({
      matched: 3, byName: 2, fuzzy: 1, unmatched: 0, ambiguous: 0,
      fuzzySamples: [{ kind: 'Principal', value: 'Bo Sampel', matched: 'Bo Sample' }],
    });
    expect(p.owners).toMatchObject({
      matched: 2, byName: 1, fuzzy: 1, unmatched: 0,
      fuzzySamples: [{ kind: 'Principal', value: 'Cy Tset', matched: 'Cy Test' }],
    });
    expect(p.sample.map(u => u.owner)).toEqual(['Example, Ann | Some Org', 'Cy Tset']);
  });

  it('apply writes the members it matched and each matched owner as the Accountable', async () => {
    const s = store();
    const a = await sharepoint(s);
    const r = await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, 'a', s);
    const keyOf = (id) => s.contexts.find(c => c.id === id).externalId;
    expect(s.members.map(m => `${keyOf(m.contextId)}:${m.memberId}`).sort()).toEqual(['Unit A:P-ann', 'Unit A:P-bo', 'Unit B:P-bo']);
    const accountable = s.insertRoleRows.mock.calls.flatMap(c => c[0]).filter(row => row.role === 'Accountable');
    expect(accountable.map(row => `${keyOf(row.contextId)}:${row.holderId}`)).toEqual(['Unit A:P-ann', 'Unit B:P-cy']);
    expect(r.owners).toMatchObject({ matched: 2, fuzzy: 1, written: 2 });
  });

  it('owners that match nobody write no Accountable and are counted as not found', async () => {
    const s = store();
    s.principals = s.principals.filter(p => p.id === 'P-bo');
    const a = await sharepoint(s);
    const r = await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, 'a', s);
    expect(r.owners).toMatchObject({ matched: 0, unmatched: 2, written: 0 });
    expect(s.insertRoleRows.mock.calls.flatMap(c => c[0]).filter(row => row.role === 'Accountable')).toEqual([]);
  });

  it('without an owner column nothing is written as Accountable and owners is null', async () => {
    const s = store();
    const a = await sharepoint(s);
    const r = await applyUpload({ uploadDraftId: a.uploadDraftId, mapping: { ...a.guess, ownerColumn: null, attributeColumns: ['Eigenaar'] } }, 'a', s);
    expect(r.owners).toBeNull();
    expect(s.insertRoleRows.mock.calls.flatMap(c => c[0]).filter(row => row.role === 'Accountable')).toEqual([]);
  });
});
