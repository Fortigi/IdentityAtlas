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

async function insertContext({ id = randomUUID(), parent = null, name }) {
  await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "parentContextId", "scopeSystemId")
     VALUES ($1, 'synced', 'Principal', 'Department', $2, $3, $4)`,
    [id, name, parent, systemId],
  );
  return id;
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
