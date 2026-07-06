// Contract test — contexts/cycleGuard.js against real PG16.
//
// Validates the two guards that keep the Contexts tree acyclic on the write
// paths (the self-FK only catches a 1-hop self-loop, not a multi-hop cycle):
//   - wouldCreateCycle(): true iff a proposed reparent would loop the tree.
//   - breakCycles(): repairs stored cycles by NULLing offending parents, while
//     leaving a clean chain untouched.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { wouldCreateCycle, breakCycles } from '../src/contexts/cycleGuard.js';

let pool;
let systemId;

// Clean chain A <- B <- C (C.parent=B, B.parent=A, A.parent=null)
const A = 'aaaa0000-0000-0000-0000-000000000001';
const B = 'aaaa0000-0000-0000-0000-000000000002';
const C = 'aaaa0000-0000-0000-0000-000000000003';
// 2-cycle X <-> Y
const X = 'bbbb0000-0000-0000-0000-000000000001';
const Y = 'bbbb0000-0000-0000-0000-000000000002';
// 3-cycle P -> Q -> R -> P
const P = 'cccc0000-0000-0000-0000-000000000001';
const Q = 'cccc0000-0000-0000-0000-000000000002';
const R = 'cccc0000-0000-0000-0000-000000000003';

async function ins(id, parent) {
  await pool.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "scopeSystemId", "parentContextId")
     VALUES ($1,'synced','Identity','OrgUnit',$2,$3,$4)`,
    [id, id, systemId, parent],
  );
}
async function parentOf(id) {
  const r = await pool.query(`SELECT "parentContextId" FROM "Contexts" WHERE id = $1`, [id]);
  return r.rows[0]?.parentContextId ?? null;
}

beforeEach(async () => {
  if (!pool) pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  if (!systemId) {
    const s = await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','cycleguard') RETURNING id`);
    systemId = s.rows[0].id;
  }
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  // clean chain
  await ins(A, null); await ins(B, A); await ins(C, B);
  // 2-cycle: insert acyclic, then close the loop with an UPDATE
  await ins(X, null); await ins(Y, X);
  await pool.query(`UPDATE "Contexts" SET "parentContextId" = $1 WHERE id = $2`, [Y, X]);
  // 3-cycle
  await ins(P, null); await ins(Q, P); await ins(R, Q);
  await pool.query(`UPDATE "Contexts" SET "parentContextId" = $1 WHERE id = $2`, [R, P]);
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  await pool?.end();
});

describe('wouldCreateCycle', () => {
  it('detects an ancestor being re-parented under its own descendant', async () => {
    // A is an ancestor of C, so setting A.parent = C would loop.
    expect(await wouldCreateCycle(pool, A, C)).toBe(true);
  });
  it('allows a descendant re-parenting under an ancestor (no loop)', async () => {
    expect(await wouldCreateCycle(pool, C, A)).toBe(false);
  });
  it('rejects self-parenting', async () => {
    expect(await wouldCreateCycle(pool, B, B)).toBe(true);
  });
  it('is false for a null parent', async () => {
    expect(await wouldCreateCycle(pool, C, null)).toBe(false);
  });
  it('terminates on an already-corrupt (cyclic) tree instead of hanging', async () => {
    // X/Y are a live 2-cycle; the CYCLE clause must keep this bounded.
    expect(await wouldCreateCycle(pool, A, X)).toBe(false);
  });
});

describe('breakCycles', () => {
  it('repairs stored cycles and leaves the clean chain intact', async () => {
    const fixed = await breakCycles(pool);
    expect(fixed).toBeGreaterThanOrEqual(2); // at least one node per cycle nulled

    // Clean chain preserved.
    expect(await parentOf(A)).toBe(null);
    expect(await parentOf(B)).toBe(A);
    expect(await parentOf(C)).toBe(B);

    // No cycle survives: no node is its own ancestor anymore.
    const { rows } = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, "parentContextId" AS cur, ARRAY[id] AS path FROM "Contexts" WHERE "scopeSystemId" = $1 AND "parentContextId" IS NOT NULL
         UNION ALL
         SELECT u.id, c."parentContextId", u.path || c.id
           FROM up u JOIN "Contexts" c ON c.id = u.cur
          WHERE c.id <> ALL(u.path)
       )
       SELECT u.id FROM up u JOIN "Contexts" c ON c.id = u.cur WHERE c."parentContextId" = u.id`,
      [systemId],
    );
    expect(rows).toHaveLength(0);
  });

  it('is a no-op on an already-acyclic tree', async () => {
    await breakCycles(pool);      // first pass repairs
    const second = await breakCycles(pool); // second pass finds nothing
    expect(second).toBe(0);
  });
});
