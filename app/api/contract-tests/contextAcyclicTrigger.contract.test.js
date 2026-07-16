// Contract test — the Contexts-acyclicity constraint trigger against real PG16.
//
// Migration 059 adds a DEFERRABLE INITIALLY DEFERRED constraint trigger that
// makes it impossible to COMMIT a cyclic parentContextId from ANY writer (#627).
// These tests pin the three behaviours that matter:
//   - a cycle that survives to commit aborts the transaction (check_violation);
//   - an acyclic tree commits fine;
//   - a batch-internal transient cycle that resolves before commit is allowed
//     (that's the whole reason the trigger is deferred, not per-statement).

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';

let pool;
let systemId;

const A = 'a0000000-0000-0000-0000-0000000c0701';
const B = 'a0000000-0000-0000-0000-0000000c0702';
const C = 'a0000000-0000-0000-0000-0000000c0703';

async function ins(client, id, parent) {
  await client.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "scopeSystemId", "parentContextId")
     VALUES ($1, 'synced', 'Principal', 'Department', $2, $3, $4)`,
    [id, `ctx-${id.slice(-4)}`, systemId, parent],
  );
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-acyclic-trigger') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterEach(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
});

describe('Contexts acyclicity trigger (migration 059)', () => {
  it('commits an acyclic chain A <- B <- C', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ins(client, A, null);
      await ins(client, B, A);
      await ins(client, C, B);
      await expect(client.query('COMMIT')).resolves.toBeDefined();
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('aborts the transaction when a 2-cycle A <-> B survives to commit', async () => {
    const client = await pool.connect();
    let err;
    try {
      await client.query('BEGIN');
      await ins(client, A, null);
      await ins(client, B, A);
      await client.query(`UPDATE "Contexts" SET "parentContextId" = $2 WHERE id = $1`, [A, B]); // A -> B -> A
      await client.query('COMMIT');
    } catch (e) {
      err = e;
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('23514'); // check_violation raised by the trigger
    // Nothing persisted — the whole transaction rolled back.
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "Contexts" WHERE id = ANY($1)`, [[A, B]]);
    expect(rows[0].n).toBe(0);
  });

  it('aborts on a 3-cycle P -> Q -> R -> P', async () => {
    const [P, Q, R] = ['a0000000-0000-0000-0000-0000000c07f1', 'a0000000-0000-0000-0000-0000000c07f2', 'a0000000-0000-0000-0000-0000000c07f3'];
    const client = await pool.connect();
    let err;
    try {
      await client.query('BEGIN');
      await ins(client, P, null);
      await ins(client, Q, P);
      await ins(client, R, Q);
      await client.query(`UPDATE "Contexts" SET "parentContextId" = $2 WHERE id = $1`, [P, R]); // close the loop
      await client.query('COMMIT');
    } catch (e) {
      err = e;
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    expect(err?.code).toBe('23514');
  });

  it('allows a batch-internal transient cycle that is resolved before commit', async () => {
    // Deferred-to-commit is the point: mid-transaction the tree briefly loops,
    // but the pointer is fixed before commit, so the final state is acyclic.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ins(client, A, null);
      await ins(client, B, A);
      await client.query(`UPDATE "Contexts" SET "parentContextId" = $2 WHERE id = $1`, [A, B]); // transient A -> B -> A
      await client.query(`UPDATE "Contexts" SET "parentContextId" = NULL WHERE id = $1`, [A]);  // resolve it
      await expect(client.query('COMMIT')).resolves.toBeDefined();
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    const { rows } = await pool.query(`SELECT "parentContextId" FROM "Contexts" WHERE id = $1`, [A]);
    expect(rows[0].parentContextId).toBeNull();
  });

  it('rejects a direct self-loop A -> A at commit', async () => {
    const client = await pool.connect();
    let err;
    try {
      await client.query('BEGIN');
      await ins(client, A, null);
      await client.query(`UPDATE "Contexts" SET "parentContextId" = id WHERE id = $1`, [A]);
      await client.query('COMMIT');
    } catch (e) {
      err = e;
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    expect(err).toBeDefined(); // self-FK or the trigger — either way it must not commit
  });
});
