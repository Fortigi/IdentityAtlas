// The three steps against an in-memory stand-in for the database. The stand-in
// answers the feature's queries by the table they read, so these tests check
// the ORCHESTRATION: which rows land on which context, who they are matched to,
// what is replaced and what is written. The SQL itself is the contract test's
// (contract-tests/contextActivity.contract.test.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { analyzeActivity, previewActivity, applyActivity, MAX_ACTIVITY_ROWS } from './service.js';
import { UploadError } from '../upload/service.js';

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ctx-act-svc-')); process.env.UPLOAD_ROOT = root; });
afterEach(async () => { delete process.env.UPLOAD_ROOT; await rm(root, { recursive: true, force: true }); });

const ROOT = { id: '00000000-0000-4000-8000-000000000001', externalId: null, displayName: 'Customers', targetType: 'Identity', contextCategory: 'OrganizationalUnit', parentContextId: null };
const NORTHWIND = { id: '00000000-0000-4000-8000-0000000000a1', externalId: 'K-001', displayName: 'Northwind Traders', parentContextId: ROOT.id, depth: 1 };
const CONTOSO = { id: '00000000-0000-4000-8000-0000000000a2', externalId: 'K-002', displayName: 'Contoso Bakery', parentContextId: ROOT.id, depth: 1 };
// A project below Northwind: a grandchild of the root.
const PLATFORM = { id: '00000000-0000-4000-8000-0000000000b1', externalId: null, displayName: 'Platform Rebuild', parentContextId: NORTHWIND.id, depth: 2 };

function fakeDb({ contexts = [ROOT], below = [NORTHWIND, CONTOSO], previous = null, replaced = [] } = {}) {
  const s = { writes: [] };
  const client = {
    query: vi.fn(async (sql, p) => {
      s.writes.push({ sql, params: p });
      if (sql.includes('DELETE FROM "ContextActivity"')) return { rowCount: replaced.reduce((n, u) => n + u.rows, 0), rows: [] };
      if (sql.includes('INSERT INTO "ContextActivityUploads"')) return { rows: [{ id: 'U-new', uploadedAt: '2026-05-01T10:00:00Z' }] };
      return { rows: [], rowCount: p[2].length };
    }),
  };
  s.db = {
    queryOne: vi.fn(async (sql, p) => {
      if (sql.includes('FROM "Contexts" WHERE id = $1')) return contexts.find(c => c.id === p[0]) ?? null;
      if (sql.includes('FROM "ContextActivityUploads"')) return previous;
      throw new Error(`unexpected queryOne: ${sql}`);
    }),
    query: vi.fn(async (sql) => {
      if (sql.includes('WITH RECURSIVE below')) return { rows: below };
      if (sql.includes('JOIN "ContextActivity" a ON a."uploadId" = u.id')) return { rows: replaced };
      if (sql.includes('"IdentityMembers"')) return { rows: [{ principalId: 'P-tom', identityId: 'I-tom' }] };
      if (sql.includes('"primaryPrincipalId"')) return { rows: [] };
      if (sql.includes('"Principals"')) {
        return { rows: [
          { id: 'P-vera', email: 'vera@example.org', upn: null, employeeId: null, externalId: null, displayName: 'Vera Example', principalType: 'User' },
          { id: 'P-tom', email: null, upn: null, employeeId: null, externalId: null, displayName: 'Tom Sample', principalType: 'User' },
        ] };
      }
      if (sql.includes('"Identities"')) return { rows: [{ id: 'I-vera', email: 'vera@example.org', employeeId: null, displayName: 'Vera Example' }] };
      throw new Error(`unexpected query: ${sql}`);
    }),
    tx: vi.fn(async (fn) => fn(client)),
  };
  return s;
}

const HEAD = 'Project;Client;Description;Task;User;Email;Tags;Billable;Start Date;Start Time;End Date;End Time;Duration (h);Duration (decimal)';
const line = (client, user, email, date, hours) => `Platform;${client};Work;Build;${user};${email};;Yes;${date};09:00;${date};10:00;01:00:00;${hours}`;
const EXPORT = [
  HEAD,
  line('Northwind Traders', 'Vera Example', 'vera@example.org', '04/18/2026', '1.50'),
  line('Northwind Traders', 'Tom Sample', '', '04/02/2026', '2.00'),
  line('Contoso Bakery', 'Ghost Person', '', '03/30/2026', '0.50'),
  line('Unknown Ltd', 'Vera Example', 'vera@example.org', '01/15/2026', '3.00'),
  line('', 'Vera Example', 'vera@example.org', '02/01/2026', '1.00'),
  line('Contoso Bakery', 'Vera Example', 'vera@example.org', 'someday', '1.00'),
].join('\n');
const file = (text = EXPORT) => ({ buffer: Buffer.from(text), fileName: 'Clockify_Time_Report.csv', uploadedBy: 'analyst@example.org' });

async function analyzed(s, text) {
  return analyzeActivity({ ...file(text), contextId: ROOT.id }, { db: s.db });
}

describe('analyzeActivity', () => {
  it('keeps the file as a draft and guesses a Clockify mapping onto the sub-units', async () => {
    const s = fakeDb();
    const a = await analyzed(s);
    expect(a).toMatchObject({ fileName: 'Clockify_Time_Report.csv', rowCount: 6, hasChildren: true, subUnitCount: 2, aiUsed: false, previousUpload: null });
    expect(a.guess).toMatchObject({ sourceLabel: 'Clockify', contextColumn: 'Client', dateColumn: 'Start Date', dateOrder: 'mdy', amountColumn: 'Duration (decimal)' });
    expect(await readdir(join(root, 'context-uploads'))).toEqual(expect.arrayContaining([`${a.uploadDraftId}.data`]));
  });

  it('starts from the mapping of the previous upload of the same source when it still fits', async () => {
    const saved = { ...((await analyzed(fakeDb())).guess), contextColumn: 'Project' };
    const s = fakeDb({ below: [NORTHWIND, CONTOSO], previous: { id: 'U-old', fileName: 'march.csv', uploadedAt: '2026-04-01', mapping: saved } });
    const refine = vi.fn();
    const a = await analyzeActivity({ ...file(), contextId: ROOT.id }, { db: s.db, refine });
    expect(a.guess.contextColumn).toBe('Project');
    expect(a.previousUpload).toMatchObject({ id: 'U-old', mappingReused: true });
    expect(refine).not.toHaveBeenCalled();
  });

  it('a saved mapping that no longer fits the file is not reused', async () => {
    const s = fakeDb({ previous: { id: 'U-old', fileName: 'x.csv', uploadedAt: '2026-04-01', mapping: { sourceLabel: 'Clockify', dateColumn: 'Datum', subjectNameColumn: 'Wie' } } });
    const a = await analyzed(s);
    expect(a.guess.dateColumn).toBe('Start Date');
    expect(a.previousUpload.mappingReused).toBe(false);
  });

  it('refuses a context that does not exist or is not a unit or application', async () => {
    await expect(analyzeActivity({ ...file(), contextId: 'nope' }, { db: fakeDb().db })).rejects.toMatchObject({ status: 404 });
    const tag = { ...ROOT, contextCategory: 'Tag' };
    await expect(analyzeActivity({ ...file(), contextId: ROOT.id }, { db: fakeDb({ contexts: [tag] }).db })).rejects.toMatchObject({ status: 400 });
  });

  it('reads up to MAX_ACTIVITY_ROWS rows, ten times a list', () => {
    expect(MAX_ACTIVITY_ROWS).toBe(500_000);
  });
});

describe('previewActivity', () => {
  it('reports what lands where, who matched, what is skipped and what is replaced', async () => {
    const s = fakeDb({ replaced: [{ id: 'U-old', fileName: 'q1.csv', uploadedAt: '2026-04-01', rows: 7 }] });
    const a = await analyzed(s);
    const p = await previewActivity({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, ROOT.id, { db: s.db });
    expect(p).toMatchObject({
      rowCount: 6, readable: 5, skipped: { 'no date': 1, 'no amount': 0, 'no person': 0 },
      period: { start: '2026-01-15', end: '2026-04-18' }, unit: 'hours',
      rowsToImport: 4, rowsNotPlaced: 1, rowsUnknownPerson: 1, subUnitsReached: 3,
      replaces: { rows: 7, uploads: [{ id: 'U-old', fileName: 'q1.csv', uploadedAt: '2026-04-01', rows: 7 }] },
    });
    expect(p.contexts).toMatchObject({ matched: 2, unmatched: 1, emptyRows: 1 });
    // The row without a client lands on the root itself (the default).
    expect(p.distribution).toEqual({
      onSelf: 1, onSubUnits: 3, subUnits: 2, deepestLevel: 1, unmatched: 1, ambiguous: 0, empty: 1, emptyTo: 'self',
      unmatchedSamples: [{ value: 'Unknown Ltd', rows: 1 }], ambiguousSamples: [],
    });
    expect(p.contexts.unmatchedSamples).toEqual([{ kind: 'Context', value: 'Unknown Ltd', reason: 'not found', rows: 1 }]);
    expect(p.subjects).toMatchObject({ matched: 2, unmatched: 1 });
    expect(p.sample[0]).toEqual({ context: 'Northwind Traders', subject: 'Vera Example', date: '2026-04-18', amount: 1.5, kind: 'Build' });
    expect(s.db.tx).not.toHaveBeenCalled();
  });

  it('an unknown draft is gone (410); an incomplete mapping lists why (400)', async () => {
    const s = fakeDb();
    await expect(previewActivity({ uploadDraftId: '00000000-0000-4000-8000-00000000dead', mapping: {} }, ROOT.id, { db: s.db })).rejects.toMatchObject({ status: 410 });
    const a = await analyzed(s);
    const err = await previewActivity({ uploadDraftId: a.uploadDraftId, mapping: { ...a.guess, dateColumn: null } }, ROOT.id, { db: s.db }).catch(e => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([expect.stringMatching(/date/)]);
  });
});

describe('applyActivity', () => {
  it('replaces the file\'s period of the same source, then writes the placed rows with who they are', async () => {
    const s = fakeDb({ replaced: [{ id: 'U-old', rows: 7 }] });
    const a = await analyzed(s);
    const out = await applyActivity({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, ROOT.id, 'analyst@example.org', { db: s.db });
    expect(out).toEqual({
      uploadId: 'U-new', contextId: ROOT.id, imported: 4, replaced: 7, notImported: 2,
      period: { start: '2026-01-15', end: '2026-04-18' }, subjects: expect.objectContaining({ matched: 2 }),
      distribution: expect.objectContaining({ onSelf: 1, onSubUnits: 3, unmatched: 1 }),
    });
    const [del, head, insert] = s.writes;
    expect(del.params).toEqual([ROOT.id, 'Clockify', '2026-01-15', '2026-04-18']);
    expect(head.params.slice(6, 10)).toEqual([6, 4, 2, 'analyst@example.org']);
    // Columns: contextId, principalId, identityId, subjectName, … (store.js INSERT_ROWS).
    expect(insert.params[2]).toEqual([NORTHWIND.id, NORTHWIND.id, CONTOSO.id, ROOT.id]);
    expect(insert.params[3]).toEqual(['P-vera', 'P-tom', null, 'P-vera']);
    expect(insert.params[4]).toEqual(['I-vera', 'I-tom', null, 'I-vera']);
    expect(insert.params[5]).toEqual(['Vera Example', 'Tom Sample', 'Ghost Person', 'Vera Example']);
    expect(insert.params[8]).toEqual([1.5, 2, 0.5, 1]);
    // The draft is gone after the import.
    expect(await readdir(join(root, 'context-uploads'))).not.toContain(`${a.uploadDraftId}.data`);
  });

  it('on a parent, rows land on the root itself, a child and a grandchild — and a re-upload replaces them all, keyed by the root', async () => {
    const TREE = [NORTHWIND, CONTOSO, PLATFORM];
    const text = [HEAD,
      line('Platform Rebuild', 'Vera Example', 'vera@example.org', '04/18/2026', '1.00'),
      line('Customers', 'Vera Example', 'vera@example.org', '04/17/2026', '2.00'),
      line('K-002', 'Vera Example', 'vera@example.org', '04/16/2026', '3.00'),
      line('', 'Vera Example', 'vera@example.org', '04/15/2026', '4.00'),
    ].join('\n');
    const s = fakeDb({ below: TREE, replaced: [{ id: 'U-old', rows: 9 }] });
    const a = await analyzed(s, text);
    expect(a).toMatchObject({ subUnitCount: 3, levels: 2, contextColumnMatches: { Client: { matched: 3, distinct: 3 }, Project: { matched: 0, distinct: 1 } } });
    expect(a.guess.contextColumn).toBe('Client');
    const out = await applyActivity({ uploadDraftId: a.uploadDraftId, mapping: { ...a.guess, emptyContext: 'skip' } }, ROOT.id, 'x', { db: s.db });
    expect(out.distribution).toMatchObject({ onSelf: 1, onSubUnits: 2, subUnits: 2, deepestLevel: 2, empty: 1, emptyTo: 'skip' });
    const [del, head, insert] = s.writes;
    // The replace window is the file's period on the root (the upload's context), whatever level
    // its earlier rows landed on — the row left out still counts for the period.
    expect(del.params).toEqual([ROOT.id, 'Clockify', '2026-04-15', '2026-04-18']);
    expect(head.params[0]).toBe(ROOT.id);
    expect(insert.params[2]).toEqual([PLATFORM.id, ROOT.id, CONTOSO.id]);
    expect(out).toMatchObject({ imported: 3, notImported: 1, replaced: 9 });
  });

  it('on a context without sub-units every row lands on the context itself', async () => {
    const leaf = { ...ROOT, id: NORTHWIND.id, displayName: 'Northwind Traders', parentContextId: ROOT.id };
    const s = fakeDb({ contexts: [leaf], below: [] });
    const a = await analyzeActivity({ ...file(), contextId: leaf.id }, { db: s.db });
    expect(a.guess.contextColumn).toBeNull();
    const out = await applyActivity({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, leaf.id, 'analyst@example.org', { db: s.db });
    expect(out.imported).toBe(5);
    expect(new Set(s.writes[2].params[2])).toEqual(new Set([leaf.id]));
  });

  it('refuses a file of which no row can be imported, and writes nothing', async () => {
    const s = fakeDb();
    const a = await analyzed(s, [HEAD, line('Unknown Ltd', 'Vera Example', 'vera@example.org', '04/18/2026', '1')].join('\n'));
    await expect(applyActivity({ uploadDraftId: a.uploadDraftId, mapping: a.guess }, ROOT.id, 'x', { db: s.db })).rejects.toMatchObject({ status: 400 });
    expect(s.db.tx).not.toHaveBeenCalled();
  });
});
