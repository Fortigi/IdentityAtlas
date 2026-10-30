// Contract test — saved workbench investigations (migration 107) on real PostgreSQL.
// Runs every statement of contexts/workbench/investigations.js and asserts what
// landed: a whole draft saved and read back as the workbench sent it; a second save
// that clears a mark, keeps an unchanged mark's author, removes a proposed role
// and keeps the others with their ids; a stale save refused; deleting one proposed
// role leaves the rest; a sync that deletes a person keeps the saved rows; and that
// none of it touches Resources, assignments or members.
//
// Isolation on the shared contract DB: one private system and unit; everything
// this file creates is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { poolDb } from '../test-utils/poolDb.js';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const {
  listInvestigations, getInvestigation, createInvestigation, saveInvestigation, deleteInvestigation, deleteProposal,
} = await import('../src/contexts/workbench/investigations.js');

let pool;
let db;
let sysId;
let unitId;
let appId;
const ID = {};
const R = {};

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const count = async (sql, params) => Number((await one(sql, params)).n);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  db = poolDb(pool);
  sysId = (await one(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('WorkbenchSaveTest', 'wbs-1') RETURNING id`)).id;
  for (const name of ['anna', 'bram']) {
    ID[name] = (await one(`INSERT INTO "Identities" (id, "displayName") VALUES (gen_random_uuid(), $1) RETURNING id`, [`wbs-${name}`])).id;
  }
  ID.loose = (await one(`INSERT INTO "Principals" (id, "systemId", "displayName", "principalType") VALUES (gen_random_uuid(), $1, 'wbs-svc', 'User') RETURNING id`, [sysId])).id;
  for (const [key, type] of [['read', 'Group'], ['or', 'Group'], ['role', 'BusinessRole']]) {
    R[key] = (await one(`INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [sysId, `wbs-${key}`, type])).id;
  }
  unitId = (await one(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName")
    VALUES (gen_random_uuid(), 'manual', 'Identity', 'Department', 'OrganizationalUnit', 'wbs-Claims') RETURNING id`)).id;
  appId = (await one(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName")
    VALUES (gen_random_uuid(), 'manual', 'Resource', 'Application', 'LogicalApplication', 'wbs-App') RETURNING id`)).id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE id = ANY($1::uuid[])`, [[unitId, appId]]); // cascades the investigations
  await pool.query(`DELETE FROM "Identities" WHERE id = ANY($1::uuid[])`, [[ID.anna, ID.bram]]);
  await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [sysId]);
  await pool.end();
});

const draft = () => ({
  name: 'Motor handlers',
  description: 'First pass',
  view: { columns: ['name', 'activity'], filters: { activity: { values: ['Handle motor claims'] } }, sort: { key: 'name', dir: 'asc' } },
  accessReadAt: '2026-10-27T08:00:00.000Z',
  accessCells: [`i:${ID.anna}|${R.read}|Direct`, `i:${ID.bram}|${R.or}|Indirect`],
  marks: [
    { person: `i:${ID.bram}`, resourceId: R.or, mark: 'other', note: 'works council' },
    { person: `p:${ID.loose}`, resourceId: R.read, mark: 'investigate' },
  ],
  proposals: [
    { name: 'Claims handler — Motor', baseBusinessRoleId: R.role, members: [`i:${ID.anna}`, `i:${ID.bram}`], entitlements: [R.read] },
    { name: 'Works council', members: [`i:${ID.bram}`], entitlements: [R.or] },
  ],
});

describe('how a proposed role is assigned (migration 108)', () => {
  it('saves and reads back the kind, the rule, the exceptions, the policies, the approver and the why', async () => {
    const rule = { includeChildren: false, filters: { jobTitle: { values: ['Team lead'], includeProposed: true, contains: ['handler'] } } };
    const inv = await createInvestigation(db, unitId, {
      name: 'Assignment rules',
      proposals: [
        { name: 'Rule', kind: 'rule', rule, members: [`i:${ID.anna}`], excluded: [`i:${ID.bram}`], joinerPolicy: 'approval', leaverPolicy: 'keep', rationale: 'Every handler' },
        { name: 'Request', kind: 'requestable', approver: { kind: 'accountable' }, leaverPolicy: 'review', members: [`i:${ID.bram}`] },
        { name: 'Undecided' },
      ],
    }, 'ann@example.test');
    expect(inv.proposals.map(p => [p.name, p.kind, p.rule, p.members, p.excluded, p.joinerPolicy, p.leaverPolicy, p.approver, p.rationale])).toEqual([
      ['Rule', 'rule', rule, [`i:${ID.anna}`], [`i:${ID.bram}`], 'approval', 'keep', null, 'Every handler'],
      ['Request', 'requestable', null, [`i:${ID.bram}`], [], 'auto', 'review', { kind: 'accountable', principalId: null, name: null }, null],
      ['Undecided', null, null, [], [], 'auto', 'remove', null, null],
    ]);
    // A change to how it is assigned is a change to the proposal.
    const before = inv.proposals[1];
    const again = await saveInvestigation(db, inv.id, { proposals: inv.proposals.map(p => ({ ...p, leaverPolicy: p.id === before.id ? 'keep' : p.leaverPolicy })) }, 'bob@example.test');
    expect(again.proposals[1]).toMatchObject({ leaverPolicy: 'keep', updatedBy: 'bob@example.test' });
    expect(again.proposals[0].updatedBy).toBe('ann@example.test');
    await pool.query(`DELETE FROM "WorkbenchInvestigations" WHERE id = $1`, [inv.id]);
  });
});

let saved;

describe('saving a new investigation', () => {
  it('reads back exactly what was saved', async () => {
    saved = await createInvestigation(db, unitId, draft(), 'ann@example.test');
    expect(saved).toMatchObject({
      contextId: unitId, name: 'Motor handlers', description: 'First pass', createdBy: 'ann@example.test', updatedBy: 'ann@example.test',
      view: draft().view, accessCells: draft().accessCells,
    });
    expect(new Date(saved.accessReadAt).toISOString()).toBe('2026-10-27T08:00:00.000Z');
    expect(saved.marks.map(m => [m.person, m.resourceId, m.mark, m.note, m.markedBy])).toEqual(expect.arrayContaining([
      [`i:${ID.bram}`, R.or, 'other', 'works council', 'ann@example.test'],
      [`p:${ID.loose}`, R.read, 'investigate', null, 'ann@example.test'],
    ]));
    expect(saved.proposals.map(p => [p.name, p.mode, p.baseBusinessRoleId, p.status, p.version, p.members, p.entitlements])).toEqual([
      ['Claims handler — Motor', 'extend', R.role, 'draft', 1, [`i:${ID.anna}`, `i:${ID.bram}`].sort(), [R.read]],
      ['Works council', 'new', null, 'draft', 1, [`i:${ID.bram}`], [R.or]],
    ]);
  });

  it('lists it on its unit with its proposed roles', async () => {
    const list = await listInvestigations(db, unitId);
    expect(list).toEqual([expect.objectContaining({ id: saved.id, name: 'Motor handlers', markCount: 2 })]);
    expect(list[0].proposals.map(p => p.name)).toEqual(['Claims handler — Motor', 'Works council']);
  });

  it('refuses a second investigation of the same name on the unit (case and spaces ignored)', async () => {
    await expect(createInvestigation(db, unitId, { name: ' MOTOR HANDLERS ' }, 'bob')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a context that is not an organizational unit', async () => {
    await expect(createInvestigation(db, appId, { name: 'x' }, 'bob')).rejects.toMatchObject({ status: 400 });
  });
});

describe('saving over it', () => {
  it('clears a dropped mark, keeps an unchanged mark’s author, removes a dropped proposal and keeps the other’s id', async () => {
    const [motor, council] = saved.proposals;
    const next = draft();
    next.expectedUpdatedAt = saved.updatedAt instanceof Date ? saved.updatedAt.toISOString() : saved.updatedAt;
    next.marks = [{ person: `i:${ID.bram}`, resourceId: R.or, mark: 'other', note: 'works council' }];
    next.proposals = [{ id: council.id, name: 'Works council (OR)', members: [`i:${ID.bram}`], entitlements: [R.or, R.read] }];

    const after = await saveInvestigation(db, saved.id, next, 'bob@example.test');
    expect(after.updatedBy).toBe('bob@example.test');
    expect(after.marks).toEqual([expect.objectContaining({ person: `i:${ID.bram}`, markedBy: 'ann@example.test' })]);
    expect(after.proposals.map(p => [p.id, p.name, p.entitlements.length])).toEqual([[council.id, 'Works council (OR)', 2]]);
    expect(await count(`SELECT count(*) AS n FROM "RoleProposalMembers" WHERE "proposalId" = $1`, [motor.id])).toBe(0);
    saved = after;
  });

  it('refuses a save from someone who opened it before the last save, naming who saved', async () => {
    const stale = { ...draft(), expectedUpdatedAt: '2020-01-01T00:00:00.000Z' };
    await expect(saveInvestigation(db, saved.id, stale, 'carol')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^bob@example.test saved/) });
    expect((await getInvestigation(db, saved.id)).proposals).toHaveLength(1);
  });

  it('a proposed role keeps its author and time when a save does not change it', async () => {
    const before = saved.proposals[0];
    const same = { proposals: [{ id: before.id, name: before.name, members: before.members, entitlements: before.entitlements }] };
    const after = await saveInvestigation(db, saved.id, same, 'dave');
    expect(after.proposals[0]).toMatchObject({ id: before.id, updatedBy: before.updatedBy });
    expect(new Date(after.proposals[0].updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
    saved = after;
  });
});

describe('the order of the proposed roles', () => {
  it('is the order of the last save', async () => {
    const two = await saveInvestigation(db, saved.id, { proposals: [{ name: 'Second' }, ...saved.proposals.map(p => ({ id: p.id, name: p.name, members: p.members, entitlements: p.entitlements }))] }, 'ann');
    expect(two.proposals.map(p => p.name)).toEqual(['Second', saved.proposals[0].name]);
    const back = await saveInvestigation(db, saved.id, { proposals: [two.proposals[1], two.proposals[0]].map(p => ({ id: p.id, name: p.name, members: p.members, entitlements: p.entitlements })) }, 'ann');
    expect(back.proposals.map(p => p.id)).toEqual([two.proposals[1].id, two.proposals[0].id]);
    saved = await saveInvestigation(db, saved.id, { proposals: [back.proposals[0]].map(p => ({ id: p.id, name: p.name, members: p.members, entitlements: p.entitlements })) }, 'ann');
  });
});

describe('deleting one proposed role', () => {
  it('removes it with its parts and leaves the others', async () => {
    const two = await saveInvestigation(db, saved.id, {
      proposals: [...saved.proposals.map(p => ({ id: p.id, name: p.name, members: p.members, entitlements: p.entitlements })),
        { name: 'Extra', members: [`i:${ID.anna}`], entitlements: [R.read] }],
    }, 'ann');
    expect(two.proposals.map(p => p.name)).toEqual([saved.proposals[0].name, 'Extra']);
    const [keep, drop] = two.proposals;
    await deleteProposal(db, saved.id, drop.id);
    const after = await getInvestigation(db, saved.id);
    expect(after.proposals.map(p => p.id)).toEqual([keep.id]);
    expect(after.proposals[0].entitlements).toHaveLength(keep.entitlements.length);
    expect(await count(`SELECT count(*) AS n FROM "RoleProposalEntitlements" WHERE "proposalId" = $1`, [drop.id])).toBe(0);
  });

  it('will not delete another investigation’s proposed role', async () => {
    const other = await createInvestigation(db, unitId, { name: 'Other', proposals: [{ name: 'Theirs' }] }, 'ann');
    await expect(deleteProposal(db, saved.id, other.proposals[0].id)).rejects.toMatchObject({ status: 404 });
    expect((await getInvestigation(db, other.id)).proposals).toHaveLength(1);
    await deleteInvestigation(db, other.id);
  });
});

describe('what it does not touch', () => {
  it('keeps the saved rows when a sync deletes the person, so a reopen can say so', async () => {
    await saveInvestigation(db, saved.id, { marks: [{ person: `i:${ID.anna}`, resourceId: R.read, mark: 'unrelated' }], proposals: saved.proposals.map(p => ({ id: p.id, members: [`i:${ID.anna}`] })) }, 'ann');
    await pool.query(`DELETE FROM "Identities" WHERE id = $1`, [ID.anna]);
    const after = await getInvestigation(db, saved.id);
    expect(after.marks.map(m => m.person)).toEqual([`i:${ID.anna}`]);
    expect(after.proposals[0].members).toEqual([`i:${ID.anna}`]);
  });

  it('adds no Resource, assignment or member', async () => {
    expect(await count(`SELECT count(*) AS n FROM "Resources" WHERE "systemId" = $1`, [sysId])).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM "ResourceAssignments" WHERE "systemId" = $1`, [sysId])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "ContextMembers" WHERE "contextId" = $1`, [unitId])).toBe(0);
  });

  it('deleting the investigation removes its marks, snapshot and proposals', async () => {
    await deleteInvestigation(db, saved.id);
    await expect(getInvestigation(db, saved.id)).rejects.toMatchObject({ status: 404 });
    for (const t of ['WorkbenchMarks', 'WorkbenchAccessSnapshots', 'RoleProposals']) {
      expect(await count(`SELECT count(*) AS n FROM "${t}" WHERE "investigationId" = $1`, [saved.id])).toBe(0);
    }
    await expect(deleteInvestigation(db, saved.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the matrix’s Proposed lens on PostgreSQL', () => {
  it('lists investigations with proposed roles across units, with the unit’s name', async () => {
    const { listAllInvestigations } = await import('../src/contexts/workbench/proposedMatrix.js');
    const inv = await createInvestigation(db, unitId, { name: 'Lens check', proposals: [{ name: 'P' }] }, 'ann@example.test');
    const empty = await createInvestigation(db, unitId, { name: 'Lens empty' }, 'ann@example.test');
    const list = (await listAllInvestigations(db)).filter(i => i.contextId === unitId);
    expect(list.find(i => i.id === inv.id)).toMatchObject({ name: 'Lens check', unitName: 'wbs-Claims', proposals: [expect.objectContaining({ name: 'P' })] });
    expect(list.some(i => i.id === empty.id)).toBe(false);
    await deleteInvestigation(db, inv.id);
    await deleteInvestigation(db, empty.id);
  });

});
