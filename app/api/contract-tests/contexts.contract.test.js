// Contract test — recursive context-tree queries against a real PostgreSQL schema.
//
// Regression coverage for the cyclic-parentContextId hang
// (bugfixes/contexts-cte-cycle). A corrupt parent chain (A→B→A) made the
// `UNION ALL` recursive `descendants` CTE in routes/contexts.js (GET
// /contexts/tree) and the member-set `subtree` CTE recurse forever. The fix
// adds a PG `CYCLE` guard to every such read query. These tests run the real
// query shapes against PG16 and assert they (a) return the correct tree on the
// happy path and (b) TERMINATE on a cycle instead of hanging.
//
// The "without CYCLE" case is included to prove the guard is load-bearing: the
// same query minus the CYCLE clause must time out on the cyclic fixture.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';

let pool;
let systemId;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-contexts-cycle') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // Break parent links first (parentContextId is ON DELETE CASCADE; a cycle
  // would make the cascade circular), then delete this system's test rows.
  await pool.query(`UPDATE "Contexts" SET "parentContextId" = NULL WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function insertContext({ id = randomUUID(), parent = null, name }) {
  await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "parentContextId", "scopeSystemId")
     VALUES ($1, 'synced', 'Principal', 'Department', $2, $3, $4)`,
    [id, name, parent, systemId],
  );
  return id;
}

// The exact descendants CTE from routes/contexts.js (GET /contexts/tree), with
// the CYCLE guard. Kept identical so this test breaks if the guard is removed.
const DESCENDANTS_SQL = `
  WITH RECURSIVE descendants AS (
    SELECT * FROM "Contexts" WHERE id = $1
    UNION ALL
    SELECT c.* FROM "Contexts" c JOIN descendants d ON c."parentContextId" = d.id
  )
  CYCLE id SET "isCycle" USING "cyclePath"
  SELECT id, "parentContextId", "displayName" FROM descendants ORDER BY "displayName"
`;

// Same query WITHOUT the guard — used only to prove the guard is load-bearing.
const DESCENDANTS_SQL_NO_GUARD = `
  WITH RECURSIVE descendants AS (
    SELECT * FROM "Contexts" WHERE id = $1
    UNION ALL
    SELECT c.* FROM "Contexts" c JOIN descendants d ON c."parentContextId" = d.id
  )
  SELECT id, "parentContextId", "displayName" FROM descendants
`;

// ── tests ─────────────────────────────────────────────────────────────────────

describe('contexts tree CTE — happy path', () => {
  it('returns the full subtree with correct parent links', async () => {
    const a = await insertContext({ name: 'Acme Corp' });
    const b = await insertContext({ parent: a, name: 'Engineering' });
    const c = await insertContext({ parent: b, name: 'Finance' });

    const { rows } = await pool.query(DESCENDANTS_SQL, [a]);

    expect(rows).toHaveLength(3);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(byId[a].parentContextId).toBeNull();
    expect(byId[b].parentContextId).toBe(a);
    expect(byId[c].parentContextId).toBe(b);
  });
});

describe('contexts tree CTE — cyclic parentContextId', () => {
  // Build A→B→A, mimicking corrupt data that predates migration 059's trigger or
  // arrives via a bypassing writer. The trigger blocks committing a cycle through
  // a normal write, so close the loop with triggers off for this connection only
  // (session_replication_role, reset in finally so it never leaks). The read-side
  // CYCLE guards still have to survive such a cycle — that's what these tests pin.
  async function makeCycle() {
    const a = await insertContext({ name: 'Cycle A' });
    const b = await insertContext({ parent: a, name: 'Cycle B' });
    const c = await pool.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE "Contexts" SET "parentContextId" = $1 WHERE id = $2`, [b, a]);
    } finally {
      await c.query(`SET session_replication_role = origin`).catch(() => {});
      c.release();
    }
    return { a, b };
  }

  it('terminates and returns finite rows instead of hanging', async () => {
    const { a, b } = await makeCycle();

    const client = await pool.connect();
    try {
      await client.query(`SET statement_timeout = '5s'`);
      const { rows } = await client.query(DESCENDANTS_SQL, [a]);
      // The CYCLE guard stops descending once an id repeats on the path, so the
      // query returns rather than running until statement_timeout fires.
      const ids = rows.map(r => r.id);
      expect(ids).toContain(a);
      expect(ids).toContain(b);
      expect(rows.length).toBeLessThan(10); // finite, not runaway
    } finally {
      client.release();
    }
  });

  it('would hang without the CYCLE guard (proves the guard is load-bearing)', async () => {
    const { a } = await makeCycle();

    const client = await pool.connect();
    try {
      await client.query(`SET statement_timeout = '2s'`);
      // 57014 = query_canceled (statement_timeout). The unguarded CTE recurses
      // forever on the cycle, so PG cancels it.
      await expect(client.query(DESCENDANTS_SQL_NO_GUARD, [a])).rejects.toMatchObject({ code: '57014' });
    } finally {
      client.release();
    }
  });
});
