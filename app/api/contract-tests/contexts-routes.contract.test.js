// Contract test — GET /api/contexts and GET /api/contexts/tree against a real
// PostgreSQL schema.
//
// Verifies the list (roots only) and tree (nested children) route handlers run
// their USE_SQL-gated SQL against the real schema and return the documented
// shapes. Self-contained: seeds its own system and contexts. The cyclic-CTE
// regression lives in contexts.contract.test.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-contexts-routes') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool.query(`UPDATE "Contexts" SET "parentContextId" = NULL WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]); // cascades ContextMembers
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

beforeEach(async () => {
  await pool.query(`UPDATE "Contexts" SET "parentContextId" = NULL WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
});

async function insertContext({ id = randomUUID(), parent = null, name, owner = null }) {
  await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "parentContextId", "scopeSystemId", "ownerUserId")
     VALUES ($1, 'synced', 'Principal', 'Department', $2, $3, $4, $5)`,
    [id, name, parent, systemId, owner],
  );
  return id;
}

async function insertPrincipal({ sys = systemId, externalId = null, name, deletedAt = null }) {
  const r = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "principalType", "externalId", "deletedAt")
     VALUES ($1, $2, 'User', $3, $4) RETURNING "id"`,
    [sys, name, externalId, deletedAt],
  );
  return r.rows[0].id;
}

describe('GET /contexts — roots', () => {
  it('returns root contexts as { data: [...] } and omits children', async () => {
    const a = await insertContext({ name: 'HTTP Root' });
    await insertContext({ parent: a, name: 'HTTP Child' });

    const res = await agent.get('/api/contexts');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some(c => c.id === a)).toBe(true);
    expect(res.body.data.some(c => c.displayName === 'HTTP Child')).toBe(false);
  });
});

describe('GET /contexts/tree — nesting', () => {
  it('nests children under the requested root', async () => {
    const a = await insertContext({ name: 'Tree Root' });
    const b = await insertContext({ parent: a, name: 'Tree Child' });

    const res = await agent.get(`/api/contexts/tree?root=${a}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const root = res.body.find(n => n.id === a);
    expect(root).toBeTruthy();
    expect(root.children.some(ch => ch.id === b)).toBe(true);
  });
});

// ownerUserId is free text — whatever the source calls the owner. The read
// endpoints resolve it to a Principal so the UI can show a person instead of an
// opaque id. These cases run against the real planner and the real index
// (migration 076), which a mocked-db unit test cannot do.
describe('owner resolution', () => {
  it('resolves ownerUserId to the principal that external id names, on the list and the detail', async () => {
    const owner = await insertPrincipal({ externalId: 'IIQ-4711', name: 'Leo M. Cohen' });
    const ctxId = await insertContext({ name: 'Owned App', owner: 'IIQ-4711' });

    const list = await agent.get('/api/contexts');
    const listed = list.body.data.find(c => c.id === ctxId);
    expect(listed.ownerPrincipalId).toBe(owner);
    expect(listed.ownerDisplayName).toBe('Leo M. Cohen');

    const detail = await agent.get(`/api/contexts/${ctxId}`);
    expect(detail.body.attributes.ownerPrincipalId).toBe(owner);
    expect(detail.body.attributes.ownerDisplayName).toBe('Leo M. Cohen');
    // The raw value survives: it is what the source said, and the UI needs it
    // for the case below.
    expect(detail.body.attributes.ownerUserId).toBe('IIQ-4711');
  });

  it('leaves an owner that matches no principal unresolved rather than blank or wrong', async () => {
    // The real defect this guards: the SQL catalogue stored an employee number
    // where principals are keyed on the identity id, so the owner matched a
    // principal that does not exist. The row must still carry the raw value.
    await insertPrincipal({ externalId: 'IIQ-0001', name: 'Somebody Else' });
    const ctxId = await insertContext({ name: 'Orphan Owner App', owner: '10000737' });

    const detail = await agent.get(`/api/contexts/${ctxId}`);
    expect(detail.body.attributes.ownerUserId).toBe('10000737');
    expect(detail.body.attributes.ownerPrincipalId).toBeNull();
    expect(detail.body.attributes.ownerDisplayName).toBeNull();
  });

  it('prefers a live principal in the context own scope system when an external id is not unique', async () => {
    const other = await pool.query(
      `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-contexts-owner-other') RETURNING "id"`);
    const otherSystemId = other.rows[0].id;
    try {
      // Three candidates for one external id: another system's, this system's
      // soft-deleted one, and this system's live one. Only the last is right,
      // and each wrong one is excluded by a different tie-break.
      await insertPrincipal({ sys: otherSystemId, externalId: 'SHARED-1', name: 'Wrong System' });
      await insertPrincipal({ externalId: 'SHARED-1', name: 'Deleted Here', deletedAt: new Date() });
      const live = await insertPrincipal({ externalId: 'SHARED-1', name: 'Right Here' });
      const ctxId = await insertContext({ name: 'Shared Id App', owner: 'SHARED-1' });

      const detail = await agent.get(`/api/contexts/${ctxId}`);
      expect(detail.body.attributes.ownerPrincipalId).toBe(live);
      expect(detail.body.attributes.ownerDisplayName).toBe('Right Here');
    } finally {
      await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [otherSystemId]);
      await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [otherSystemId]);
    }
  });

  it('a context with no owner resolves to nothing rather than to an arbitrary principal', async () => {
    await insertPrincipal({ externalId: null, name: 'Keyless' });
    const ctxId = await insertContext({ name: 'Ownerless App' });

    const detail = await agent.get(`/api/contexts/${ctxId}`);
    expect(detail.body.attributes.ownerUserId).toBeNull();
    expect(detail.body.attributes.ownerPrincipalId).toBeNull();
  });
});

describe('GET /contexts/:id/members — count pin (Phase 3)', () => {
  // Regression pin: a context with 3 live Principal members must report exactly
  // 3. loadMembers joins ContextMembers to the target table by memberId and
  // filters on the context's targetType; a join/filter regression would silently
  // under- or over-count membership. A failing pin without a feature PR is a bug.
  it('reports the seeded member count and rows', async () => {
    const ctxId = await insertContext({ name: 'Members Ctx' });

    const memberIds = [];
    for (const name of ['M1', 'M2', 'M3']) {
      const r = await pool.query(
        `INSERT INTO "Principals" ("systemId", "displayName", "principalType") VALUES ($1, $2, 'User') RETURNING "id"`,
        [systemId, name],
      );
      memberIds.push(r.rows[0].id);
    }
    for (const memberId of memberIds) {
      await pool.query(
        `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
         VALUES ($1, 'Principal', $2, 'sync')`,
        [ctxId, memberId],
      );
    }

    const res = await agent.get(`/api/contexts/${ctxId}/members`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data.map(m => m.id).sort()).toEqual([...memberIds].sort());
  });
});
