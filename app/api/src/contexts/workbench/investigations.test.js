// The investigation store's decisions with a scripted database: which statements
// run with what, what is refused (404 / 409), and which proposal id a save keeps.
// That the SQL does what it says on PostgreSQL is contract-tests/workbenchInvestigations.contract.test.js'.
import { describe, it, expect } from 'vitest';
import {
  listInvestigations, getInvestigation, createInvestigation, saveInvestigation, deleteInvestigation, deleteProposal,
  UPDATE_HEAD_SQL, UPSERT_MARKS_SQL, DELETE_CLEARED_MARKS_SQL, INSERT_PROPOSAL_SQL, UPDATE_PROPOSAL_SQL, POSITION_SQL,
} from './investigations.js';
import { InvestigationError } from './investigationDraft.js';

const INV = '11111111-1111-4111-8111-111111111111';
const CTX = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const P2 = '44444444-4444-4444-8444-444444444444';
const PERSON = '55555555-5555-4555-8555-555555555555';
const RES = '66666666-6666-4666-8666-666666666666';

/**
 * A db whose answers are picked by the first rule whose pattern the SQL matches.
 * Every statement (outside and inside tx) is recorded in `calls`.
 */
function fakeDb(rules = []) {
  const calls = [];
  const answer = (sql, params) => {
    calls.push({ sql, params });
    const rule = rules.find(([pattern]) => pattern.test(sql));
    const out = rule ? (typeof rule[1] === 'function' ? rule[1](params) : rule[1]) : {};
    return { rows: out.rows ?? [], rowCount: out.rowCount ?? (out.rows ? out.rows.length : 0) };
  };
  const query = async (sql, params) => answer(sql, params);
  return {
    calls,
    query,
    queryOne: async (sql, params) => answer(sql, params).rows[0] ?? null,
    tx: async (fn) => fn({ query }),
  };
}

const HEAD = { id: INV, contextId: CTX, name: 'Motor', description: null, view: {}, accessReadAt: null, createdBy: 'a', createdAt: 't', updatedBy: 'a', updatedAt: 't' };
// What a reopen reads after a write, so create/save can return it.
const READ_BACK = [
  [/FROM "WorkbenchInvestigations" WHERE id = \$1$/m, { rows: [HEAD] }],
  [/FROM "WorkbenchMarks" WHERE/, { rows: [] }],
  [/FROM "RoleProposals" p WHERE/, { rows: [] }],
  [/FROM "WorkbenchAccessSnapshots"/, { rows: [] }],
];

const sqlOf = (db, pattern) => db.calls.filter(c => pattern.test(c.sql));

async function rejection(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected a rejection');
}

describe('listInvestigations', () => {
  it('reads the unit’s investigations', async () => {
    const db = fakeDb([[/FROM "WorkbenchInvestigations" w/, { rows: [{ id: INV }] }]]);
    expect(await listInvestigations(db, CTX)).toEqual([{ id: INV }]);
    expect(db.calls[0].params).toEqual([CTX]);
  });
});

describe('getInvestigation', () => {
  it('404s an unknown investigation and reads nothing else', async () => {
    const db = fakeDb();
    const err = await rejection(getInvestigation(db, INV));
    expect(err).toBeInstanceOf(InvestigationError);
    expect(err.status).toBe(404);
    expect(db.calls).toHaveLength(1);
  });

  it('turns stored people back into workbench row keys and returns the snapshot', async () => {
    const db = fakeDb([
      [/FROM "WorkbenchInvestigations" WHERE id = \$1$/m, { rows: [HEAD] }],
      [/FROM "WorkbenchMarks" WHERE/, { rows: [{ personKind: 'principal', personId: PERSON, resourceId: RES, mark: 'other', note: 'OR', markedBy: 'b', markedAt: 'u' }] }],
      [/FROM "RoleProposals" p WHERE/, { rows: [{ id: P1, name: 'R', members: [`identity:${PERSON}`, `principal:${P2}`], entitlements: [RES], evidenceClaimIds: [] }] }],
      [/FROM "WorkbenchAccessSnapshots"/, { rows: [{ cells: [`i:${PERSON}|${RES}|Direct`] }] }],
    ]);
    const out = await getInvestigation(db, INV);
    expect(out.marks).toEqual([{ person: `p:${PERSON}`, resourceId: RES, mark: 'other', note: 'OR', markedBy: 'b', markedAt: 'u' }]);
    expect(out.proposals[0].members).toEqual([`i:${PERSON}`, `p:${P2}`]);
    expect(out.accessCells).toEqual([`i:${PERSON}|${RES}|Direct`]);
  });

  it('returns an empty snapshot when none was saved', async () => {
    const out = await getInvestigation(fakeDb(READ_BACK), INV);
    expect(out.accessCells).toEqual([]);
  });
});

describe('createInvestigation', () => {
  const unit = (category) => [/SELECT "contextCategory"/, { rows: category ? [{ contextCategory: category }] : [] }];

  it('refuses a draft without a name before touching the database', async () => {
    const db = fakeDb();
    expect((await rejection(createInvestigation(db, CTX, {}, 'ann'))).status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it('404s an unknown unit and 400s a context that is not an organizational unit', async () => {
    expect((await rejection(createInvestigation(fakeDb([unit(null)]), CTX, { name: 'x' }, 'ann'))).status).toBe(404);
    const notUnit = await rejection(createInvestigation(fakeDb([unit('LogicalApplication')]), CTX, { name: 'x' }, 'ann'));
    expect(notUnit.status).toBe(400);
  });

  it('writes the head, the snapshot, the marks and each proposal, then reads it back', async () => {
    const db = fakeDb([
      unit('OrganizationalUnit'),
      [/INSERT INTO "WorkbenchInvestigations"/, { rows: [{ id: INV }] }],
      [/SELECT id FROM "RoleProposals" WHERE "investigationId"/, { rows: [] }],
      [/INSERT INTO "RoleProposals"/, (params) => ({ rows: [{ id: params[0] ?? P2 }] })],
      ...READ_BACK,
    ]);
    await createInvestigation(db, CTX, {
      name: 'Motor', view: { columns: ['name'] }, accessReadAt: '2026-10-27T08:00:00Z', accessCells: [`i:${PERSON}|${RES}|Direct`],
      marks: [{ person: `i:${PERSON}`, resourceId: RES, mark: 'other' }],
      proposals: [{ id: P1, name: 'A', members: [`i:${PERSON}`], entitlements: [RES] }, { name: 'B' }],
    }, 'ann');
    const head = sqlOf(db, /INSERT INTO "WorkbenchInvestigations"/)[0];
    expect(head.params).toEqual([CTX, 'Motor', null, '{"columns":["name"]}', '2026-10-27T08:00:00.000Z', 'ann']);
    expect(sqlOf(db, /INSERT INTO "WorkbenchAccessSnapshots"/)[0].params[1]).toBe(`["i:${PERSON}|${RES}|Direct"]`);
    expect(sqlOf(db, /INSERT INTO "WorkbenchMarks"/)[0].params).toEqual([INV, ['identity'], [PERSON], [RES], ['other'], [null], 'ann']);
    const inserted = sqlOf(db, /INSERT INTO "RoleProposals"/);
    expect(inserted.map(c => c.params[0])).toEqual([P1, null]);
    // Saved in the browser's order, so the answer maps back onto its drafts.
    expect(inserted.map(c => c.params[7])).toEqual([0, 1]);
    expect(sqlOf(db, /INSERT INTO "RoleProposalMembers"/)[0].params).toEqual([P1, ['identity'], [PERSON]]);
    expect(sqlOf(db, /INSERT INTO "RoleProposalEntitlements"/)[0].params).toEqual([P1, [RES]]);
    // Both proposals are kept: the clean-up removes only the ones not saved.
    expect(sqlOf(db, /DELETE FROM "RoleProposals"/)[0].params).toEqual([INV, [P1, P2]]);
  });

  it('turns a duplicate name into a 409', async () => {
    const db = fakeDb([unit('OrganizationalUnit')]);
    db.tx = async () => { throw Object.assign(new Error('dup'), { code: '23505' }); };
    const err = await rejection(createInvestigation(db, CTX, { name: 'Motor' }, 'ann'));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/already has an investigation/);
  });

  it('lets any other database error through', async () => {
    const db = fakeDb([unit('OrganizationalUnit')]);
    db.tx = async () => { throw new Error('boom'); };
    expect((await rejection(createInvestigation(db, CTX, { name: 'Motor' }, 'ann'))).message).toBe('boom');
  });
});

describe('saveInvestigation', () => {
  it('saves over it with the time it was opened at, clearing marks the draft no longer holds', async () => {
    const db = fakeDb([
      [/UPDATE "WorkbenchInvestigations"/, { rowCount: 1 }],
      [/SELECT id FROM "RoleProposals" WHERE "investigationId"/, { rows: [{ id: P1 }] }],
      ...READ_BACK,
    ]);
    await saveInvestigation(db, INV, { expectedUpdatedAt: '2026-10-27T09:00:00.123Z', proposals: [{ id: P1, name: 'Renamed' }] }, 'bob');
    const head = sqlOf(db, /UPDATE "WorkbenchInvestigations"/)[0];
    expect(head.sql).toBe(UPDATE_HEAD_SQL);
    // name kept (null → COALESCE), description untouched (false), opened-at sent.
    expect(head.params).toEqual([INV, null, false, null, '{}', null, 'bob', '2026-10-27T09:00:00.123Z']);
    expect(sqlOf(db, /DELETE FROM "WorkbenchMarks"/)[0].sql).toBe(DELETE_CLEARED_MARKS_SQL);
    expect(sqlOf(db, /INSERT INTO "WorkbenchMarks"/)).toHaveLength(0);
    // P1 is this investigation's: updated in place, not inserted again.
    expect(sqlOf(db, /UPDATE "RoleProposals"/)[0]).toMatchObject({ sql: UPDATE_PROPOSAL_SQL, params: [P1, INV, 'Renamed', null, null, 'new', 'bob'] });
    expect(sqlOf(db, /SET position/)[0]).toMatchObject({ sql: POSITION_SQL, params: [P1, 0] });
    expect(sqlOf(db, /INSERT INTO "RoleProposals"/)).toHaveLength(0);
  });

  it('removes every proposed role when the draft holds none', async () => {
    const db = fakeDb([[/UPDATE "WorkbenchInvestigations"/, { rowCount: 1 }], ...READ_BACK]);
    await saveInvestigation(db, INV, { proposals: [] }, 'bob');
    expect(sqlOf(db, /DELETE FROM "RoleProposals"/)[0].params).toEqual([INV, []]);
  });

  it('gives a proposal a fresh id when the browser’s id belongs to another investigation', async () => {
    const db = fakeDb([
      [/UPDATE "WorkbenchInvestigations"/, { rowCount: 1 }],
      [/SELECT id FROM "RoleProposals" WHERE "investigationId"/, { rows: [] }],
      [/SELECT 1 FROM "RoleProposals" WHERE id/, { rows: [{}] }],
      [/INSERT INTO "RoleProposals"/, { rows: [{ id: P2 }] }],
      ...READ_BACK,
    ]);
    await saveInvestigation(db, INV, { proposals: [{ id: P1 }] }, 'bob');
    expect(sqlOf(db, /INSERT INTO "RoleProposals"/)[0]).toMatchObject({ sql: INSERT_PROPOSAL_SQL });
    expect(sqlOf(db, /INSERT INTO "RoleProposals"/)[0].params[0]).toBeNull();
    expect(sqlOf(db, /DELETE FROM "RoleProposals"/)[0].params).toEqual([INV, [P2]]);
  });

  it('keeps the browser’s id for a new proposal nobody uses', async () => {
    const db = fakeDb([
      [/UPDATE "WorkbenchInvestigations"/, { rowCount: 1 }],
      [/SELECT 1 FROM "RoleProposals" WHERE id/, { rows: [] }],
      [/INSERT INTO "RoleProposals"/, (params) => ({ rows: [{ id: params[0] }] })],
      ...READ_BACK,
    ]);
    await saveInvestigation(db, INV, { proposals: [{ id: P1, evidenceClaimIds: [P2] }] }, 'bob');
    expect(sqlOf(db, /INSERT INTO "RoleProposals"/)[0].params[0]).toBe(P1);
    expect(sqlOf(db, /INSERT INTO "RoleProposalEvidence"/)[0].params).toEqual([P1, [P2]]);
  });

  it('404s an investigation that does not exist', async () => {
    const db = fakeDb([[/UPDATE "WorkbenchInvestigations"/, { rowCount: 0 }], [/SELECT "updatedBy"/, { rows: [] }]]);
    expect((await rejection(saveInvestigation(db, INV, {}, 'bob'))).status).toBe(404);
  });

  it('409s, naming who, when someone saved it after it was opened — and writes nothing else', async () => {
    const db = fakeDb([[/UPDATE "WorkbenchInvestigations"/, { rowCount: 0 }], [/SELECT "updatedBy"/, { rows: [{ updatedBy: 'carol' }] }]]);
    const err = await rejection(saveInvestigation(db, INV, { expectedUpdatedAt: '2026-10-27T09:00:00Z' }, 'bob'));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/^carol saved this investigation/);
    expect(sqlOf(db, /WorkbenchMarks|WorkbenchAccessSnapshots|RoleProposals/)).toHaveLength(0);
  });

  it('upserts the marks the draft holds', async () => {
    const db = fakeDb([[/UPDATE "WorkbenchInvestigations"/, { rowCount: 1 }], ...READ_BACK]);
    await saveInvestigation(db, INV, { marks: [{ person: `p:${PERSON}`, resourceId: RES, mark: 'investigate', note: 'ask' }] }, 'bob');
    expect(sqlOf(db, /INSERT INTO "WorkbenchMarks"/)[0]).toMatchObject({
      sql: UPSERT_MARKS_SQL, params: [INV, ['principal'], [PERSON], [RES], ['investigate'], ['ask'], 'bob'],
    });
  });
});

describe('deleteInvestigation / deleteProposal', () => {
  it('deletes, and 404s what is not there', async () => {
    await deleteInvestigation(fakeDb([[/DELETE/, { rowCount: 1 }]]), INV);
    expect((await rejection(deleteInvestigation(fakeDb([[/DELETE/, { rowCount: 0 }]]), INV))).status).toBe(404);
  });

  it('deletes one proposed role only within its own investigation', async () => {
    const db = fakeDb([[/DELETE/, { rowCount: 1 }]]);
    await deleteProposal(db, INV, P1);
    expect(db.calls[0].params).toEqual([P1, INV]);
    const err = await rejection(deleteProposal(fakeDb([[/DELETE/, { rowCount: 0 }]]), INV, P1));
    expect(err).toMatchObject({ status: 404, message: 'Proposed role not found' });
  });
});
