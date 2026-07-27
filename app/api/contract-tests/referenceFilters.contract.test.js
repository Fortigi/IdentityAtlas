// Contract test — reference-field (relationship) filters against a real
// PostgreSQL schema, end-to-end through the live route handlers.
//
// Covers the 12 acceptance criteria agreed in the Definition-of-Ready packet:
// existence/threshold operators, single-valued (manager) cardinality, all-type
// member counting, 2-hop group owners, inverse directions, sponsors, dynamic
// per-sub-tab discovery, soft-delete exclusion, bulk-tag parity, and fail-closed
// handling of unknown keys/values.
//
// Isolation on the shared contract DB: every row this test asserts on carries a
// unique search marker M and a unique principalType/resourceType, so list
// queries (search=M + type) and scoped discovery see ONLY this test's rows.
// beforeAll seeds; afterAll deletes everything it created.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
let tagId;

const S = randomUUID().slice(0, 8);
const M = `REF-${S}`;                 // display-name search marker
const AGENT = `AIAgent-${S}`;         // unique principalType for agents
const USER = `User-${S}`;             // unique principalType for users
const GROUP = `Group-${S}`;           // unique resourceType for groups

const ids = {};

async function addPrincipal(name, { type = USER, managerId = null, deleted = false } = {}) {
  const r = await pool.query(
    `INSERT INTO "Principals" ("systemId","displayName","email","principalType","managerId","deletedAt")
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [systemId, `${M} ${name}`, `${name}-${S}@example.test`, type, managerId, deleted ? new Date() : null],
  );
  return r.rows[0].id;
}
async function addRel(subjectId, relatedId, relationshipType) {
  await pool.query(
    `INSERT INTO "PrincipalRelationships" ("principalId","relatedPrincipalId","relationshipType","systemId")
     VALUES ($1,$2,$3,$4)`,
    [subjectId, relatedId, relationshipType, systemId],
  );
}
async function addResource(name, { type = GROUP, marker = true } = {}) {
  const r = await pool.query(
    `INSERT INTO "Resources" ("systemId","displayName","resourceType") VALUES ($1,$2,$3) RETURNING id`,
    [systemId, marker ? `${M} ${name}` : name, type],
  );
  return r.rows[0].id;
}
async function addAssignment(resourceId, principalId, type, { deleted = false } = {}) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId","deletedAt")
     VALUES ($1,$2,$3,$4,$5)`,
    [resourceId, principalId, type, systemId, deleted ? new Date() : null],
  );
}
async function addOwnership(groupId, ownerPrincipalId) {
  const ow = await addResource('ownership', { type: `${GROUP}-own`, marker: false });
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","systemId")
     VALUES ($1,$2,'HasOwnership',$3)`,
    [groupId, ow, systemId],
  );
  await addAssignment(ow, ownerPrincipalId, 'Direct');
}

// GET the id set for a filtered list, scoped to this test's rows via search=M.
async function userIds(filters) {
  const res = await agent.get('/api/users')
    .query({ search: M, filters: JSON.stringify(filters), limit: 1000 });
  expect(res.status).toBe(200);
  return new Set(res.body.data.map((r) => r.id));
}
async function resourceIds(filters) {
  const res = await agent.get('/api/resources')
    .query({ search: M, filters: JSON.stringify(filters), limit: 1000 });
  expect(res.status).toBe(200);
  return new Set(res.body.data.map((r) => r.id));
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test',$1) RETURNING id`,
    [`contract-reffilters-${S}`],
  );
  systemId = sys.rows[0].id;

  // Owners / manager targets (users)
  ids.owner1 = await addPrincipal('owner1');
  ids.owner2 = await addPrincipal('owner2');
  ids.owner3 = await addPrincipal('owner3');
  ids.ownerDeleted = await addPrincipal('ownerDeleted', { deleted: true });

  // Agents with 0/1/2/3 owners (+ one whose sole owner is soft-deleted)
  ids.A1 = await addPrincipal('agentA1', { type: AGENT });   // 1 owner
  ids.A2 = await addPrincipal('agentA2', { type: AGENT });   // 0 owners
  ids.A3 = await addPrincipal('agentA3', { type: AGENT });   // 2 owners
  ids.A4 = await addPrincipal('agentA4', { type: AGENT });   // 3 owners
  ids.A5 = await addPrincipal('agentA5', { type: AGENT });   // 1 owner, but deleted
  await addRel(ids.A1, ids.owner1, 'Owner');
  await addRel(ids.A3, ids.owner1, 'Owner');
  await addRel(ids.A3, ids.owner2, 'Owner');
  await addRel(ids.A4, ids.owner1, 'Owner');
  await addRel(ids.A4, ids.owner2, 'Owner');
  await addRel(ids.A4, ids.owner3, 'Owner');
  await addRel(ids.A5, ids.ownerDeleted, 'Owner');           // owner tombstoned → counts as 0

  // Users: manager present/absent, a manager with a report, an agent owner
  ids.M1 = await addPrincipal('managerM1');                        // manages U1
  ids.U1 = await addPrincipal('userU1', { managerId: ids.M1 });    // has manager
  ids.U2 = await addPrincipal('userU2');                           // no manager
  // owner1 also "owns agents" (A1/A3/A4) → inverse direction

  // Guests with/without a sponsor
  ids.GST1 = await addPrincipal('guest1');
  ids.GST2 = await addPrincipal('guest2');
  await addRel(ids.GST1, ids.owner1, 'Sponsor');

  // Groups: members via Direct / Indirect / empty, + soft-deleted assignment
  ids.G1 = await addResource('groupG1');
  ids.G2 = await addResource('groupG2');
  ids.G3 = await addResource('groupG3');
  ids.GDEL = await addResource('groupGDEL');
  await addAssignment(ids.G1, ids.U1, 'Direct');
  await addAssignment(ids.G2, ids.U1, 'Indirect');
  await addAssignment(ids.G2, ids.U2, 'Indirect');
  await addAssignment(ids.GDEL, ids.U1, 'Direct', { deleted: true });

  // Groups with / without an owner (2-hop via GroupOwnership)
  ids.GO1 = await addResource('groupGO1');
  ids.GO2 = await addResource('groupGO2');
  await addOwnership(ids.GO1, ids.owner1);
}, 60000);

afterAll(async () => {
  if (tagId) {
    await pool.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1`, [tagId]);
    await pool.query(`DELETE FROM "Contexts" WHERE id = $1`, [tagId]);
  }
  if (systemId) {
    await pool.query(`DELETE FROM "PrincipalRelationships" WHERE "systemId" = $1`, [systemId]);
    await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
    await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
    await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
    await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
    await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  }
  await pool.end();
  delete process.env.USE_SQL;
});

describe('AC1/AC2 — owners existence + thresholds (agents)', () => {
  it('None (0) returns the ownerless agent, not the owned one', async () => {
    const none = await userIds({ principalType: AGENT, 'rel.owners': 'None (0)' });
    expect(none.has(ids.A2)).toBe(true);
    expect(none.has(ids.A1)).toBe(false);
  });
  it('Any (1 or more) returns owned agents, not the ownerless one', async () => {
    const any = await userIds({ principalType: AGENT, 'rel.owners': 'Any (1 or more)' });
    expect(any.has(ids.A1)).toBe(true);
    expect(any.has(ids.A2)).toBe(false);
  });
  it('Exactly 1 / 2 or more / 3 or more partition by owner count', async () => {
    const one = await userIds({ principalType: AGENT, 'rel.owners': 'Exactly 1' });
    expect(one.has(ids.A1)).toBe(true);
    expect(one.has(ids.A3)).toBe(false);
    expect(one.has(ids.A4)).toBe(false);
    const two = await userIds({ principalType: AGENT, 'rel.owners': '2 or more' });
    expect(two.has(ids.A3)).toBe(true);
    expect(two.has(ids.A4)).toBe(true);
    expect(two.has(ids.A1)).toBe(false);
    const three = await userIds({ principalType: AGENT, 'rel.owners': '3 or more' });
    expect(three.has(ids.A4)).toBe(true);
    expect(three.has(ids.A3)).toBe(false);
  });
});

describe('AC3 — manager (single-valued)', () => {
  it('None → users without a manager; Any → users with one', async () => {
    const none = await userIds({ principalType: USER, 'rel.manager': 'None (0)' });
    expect(none.has(ids.U2)).toBe(true);
    expect(none.has(ids.U1)).toBe(false);
    const any = await userIds({ principalType: USER, 'rel.manager': 'Any (1 or more)' });
    expect(any.has(ids.U1)).toBe(true);
    expect(any.has(ids.U2)).toBe(false);
  });
});

describe('AC4 — members count ALL assignment types', () => {
  it('None returns only the truly empty group (Indirect-only is NOT empty)', async () => {
    const none = await resourceIds({ 'rel.members': 'None (0)' });
    expect(none.has(ids.G3)).toBe(true);
    expect(none.has(ids.G1)).toBe(false);
    expect(none.has(ids.G2)).toBe(false); // 2 Indirect members ⇒ not "None"
  });
});

describe('AC5 — group owners (2-hop via GroupOwnership)', () => {
  it('None returns the ownerless group, not the owned one', async () => {
    const none = await resourceIds({ 'rel.owners': 'None (0)' });
    expect(none.has(ids.GO2)).toBe(true);
    expect(none.has(ids.GO1)).toBe(false);
  });
});

describe('AC6/AC7 — inverse directions', () => {
  it('ownsAgents: the owner shows as owning ≥1 agent', async () => {
    const owns = await userIds({ principalType: USER, 'rel.ownsAgents': 'Any (1 or more)' });
    expect(owns.has(ids.owner1)).toBe(true);
    expect(owns.has(ids.U2)).toBe(false);
  });
  it('directReports: the manager shows as having ≥1 report', async () => {
    const mgrs = await userIds({ principalType: USER, 'rel.directReports': 'Any (1 or more)' });
    expect(mgrs.has(ids.M1)).toBe(true);
    expect(mgrs.has(ids.U1)).toBe(false);
  });
});

describe('AC8 — guest sponsors', () => {
  it('None returns the unsponsored guest, not the sponsored one', async () => {
    const none = await userIds({ principalType: USER, 'rel.sponsors': 'None (0)' });
    expect(none.has(ids.GST2)).toBe(true);
    expect(none.has(ids.GST1)).toBe(false);
  });
});

describe('AC9 — dynamic discovery scoped to the sub-tab', () => {
  it('Agents tab offers owners (multi picklist) but not manager/directReports', async () => {
    const res = await agent.get('/api/user-columns-page').query({ principalType: AGENT });
    expect(res.status).toBe(200);
    const byCol = Object.fromEntries(res.body.map((c) => [c.column, c]));
    expect(byCol['rel.owners']).toBeTruthy();
    expect(byCol['rel.owners'].values).toEqual(
      ['None (0)', 'Any (1 or more)', 'Exactly 1', '2 or more', '3 or more'],
    );
    expect(byCol['rel.owners'].label).toBe('Owners');
    expect(byCol['rel.manager']).toBeFalsy();
    expect(byCol['rel.directReports']).toBeFalsy();
  });
  it('Users tab offers manager (single picklist) + directReports, not owners', async () => {
    const res = await agent.get('/api/user-columns-page').query({ principalType: USER });
    expect(res.status).toBe(200);
    const byCol = Object.fromEntries(res.body.map((c) => [c.column, c]));
    expect(byCol['rel.manager']).toBeTruthy();
    expect(byCol['rel.manager'].values).toEqual(['None (0)', 'Any (1 or more)']);
    expect(byCol['rel.directReports']).toBeTruthy();
    expect(byCol['rel.owners']).toBeFalsy();
  });
  it('Resource columns expose members and owners reference fields', async () => {
    const res = await agent.get('/api/resource-columns');
    expect(res.status).toBe(200);
    const cols = new Set(res.body.map((c) => c.column));
    expect(cols.has('rel.members')).toBe(true);
    expect(cols.has('rel.owners')).toBe(true);
  });
});

describe('AC10 — soft-deleted related rows are not counted', () => {
  it('agent whose only owner is tombstoned reads as None, not Any', async () => {
    const none = await userIds({ principalType: AGENT, 'rel.owners': 'None (0)' });
    const any = await userIds({ principalType: AGENT, 'rel.owners': 'Any (1 or more)' });
    expect(none.has(ids.A5)).toBe(true);
    expect(any.has(ids.A5)).toBe(false);
  });
  it('group whose only member assignment is soft-deleted reads as None', async () => {
    const none = await resourceIds({ 'rel.members': 'None (0)' });
    expect(none.has(ids.GDEL)).toBe(true);
  });
});

describe('AC11 — bulk tag-by-filter applies the same rel constraint (no over-tag)', () => {
  it('tags exactly the ownerless agents, not the whole set', async () => {
    const created = await agent.post('/api/tags')
      .send({ name: `reffilter-${S}`, color: '#3b82f6', entityType: 'user' });
    expect(created.status).toBeLessThan(300);
    tagId = created.body.id;

    const res = await agent.post(`/api/tags/${tagId}/assign-by-filter`).send({
      entityType: 'user',
      search: M,
      filters: { principalType: AGENT, 'rel.owners': 'None (0)' },
    });
    expect(res.status).toBe(200);

    const tagged = new Set(
      (await pool.query(`SELECT "memberId" FROM "ContextMembers" WHERE "contextId" = $1`, [tagId]))
        .rows.map((r) => r.memberId),
    );
    // ownerless agents (A2, and A5 whose owner is deleted) — NOT the owned ones
    expect(tagged.has(ids.A2)).toBe(true);
    expect(tagged.has(ids.A5)).toBe(true);
    expect(tagged.has(ids.A1)).toBe(false);
    expect(tagged.has(ids.A3)).toBe(false);
    expect(tagged.has(ids.A4)).toBe(false);
  });
});

describe('AC12 — fail closed on unknown key / value', () => {
  it('unknown rel key matches nothing (never widens)', async () => {
    const r = await userIds({ principalType: AGENT, 'rel.bogus': 'None (0)' });
    for (const id of [ids.A1, ids.A2, ids.A3, ids.A4, ids.A5]) expect(r.has(id)).toBe(false);
  });
  it('unrecognised value matches nothing (no SQL error)', async () => {
    const r = await userIds({ principalType: AGENT, 'rel.owners': "'; DROP TABLE x --" });
    expect(r.size).toBe(0);
  });
});
