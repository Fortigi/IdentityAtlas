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
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
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
