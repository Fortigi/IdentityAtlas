// Contract test — refreshGeneratedContexts (post-crawl tree refresh) against a
// real PostgreSQL schema.
//
// Regression guard for the "context plugins spawn a new tree on every crawl"
// bug: legacy trees (created before migration 034) have a NULL sourceInstanceKey.
// The refresh must backfill a stable key and reconcile onto the EXISTING tree,
// never mint a fresh key that inserts a duplicate tree each run. We simulate a
// legacy tree (NULL key), run the refresh twice, and assert the tree count is
// still one.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';

const PLUGIN_NAME = 'principal-type-tree';

let enqueueRun, refreshGeneratedContexts;
let pool;
let systemId;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
  ({ enqueueRun, refreshGeneratedContexts } = await import('../src/contexts/plugins/runner.js'));
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

beforeEach(cleanup);

async function cleanup() {
  await pool.query(`DELETE FROM "Contexts" WHERE "sourceAlgorithmId" IN (SELECT id FROM "ContextAlgorithms" WHERE name = $1)`, [PLUGIN_NAME]);
  await pool.query(`DELETE FROM "ContextAlgorithms" WHERE name = $1`, [PLUGIN_NAME]);
  await pool.query(`DELETE FROM "Principals" WHERE "displayName" LIKE 'refresh-ct-%'`);
  await pool.query(`DELETE FROM "Systems" WHERE "displayName" = 'refresh-contract'`);
}

async function seed() {
  await pool.query(
    `INSERT INTO "ContextAlgorithms" ("id", "name", "displayName", "targetType")
     VALUES ($1, $2, 'Principal Type Tree', 'Principal')`,
    [randomUUID(), PLUGIN_NAME],
  );
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'refresh-contract') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO "Principals" ("systemId", "displayName", "principalType") VALUES ($1, $2, 'ServicePrincipal')`,
      [systemId, `refresh-ct-${i}`],
    );
  }
}

const rootCount = async () =>
  (await pool.query(
    `SELECT COUNT(*)::int AS n FROM "Contexts" c
       JOIN "ContextAlgorithms" a ON a.id = c."sourceAlgorithmId"
      WHERE a.name = $1 AND c."externalId" = 'ptype-root'`,
    [PLUGIN_NAME],
  )).rows[0].n;

describe('refreshGeneratedContexts — legacy NULL-key tree', () => {
  it('updates the existing tree in place across repeated crawls (never duplicates)', async () => {
    await seed();

    // Build the initial tree, then knock its instance key back to NULL to
    // impersonate a tree created before migration 034.
    await enqueueRun(PLUGIN_NAME, { systemId, values: ['ServicePrincipal'] }, 'initial', { awaitCompletion: true });
    await pool.query(
      `UPDATE "Contexts" SET "sourceInstanceKey" = NULL
        WHERE "sourceAlgorithmId" IN (SELECT id FROM "ContextAlgorithms" WHERE name = $1)`,
      [PLUGIN_NAME],
    );
    expect(await rootCount()).toBe(1);

    // Two post-crawl refreshes. Pre-fix, each would spawn another root.
    await refreshGeneratedContexts('crawl-refresh', { awaitCompletion: true });
    await refreshGeneratedContexts('crawl-refresh', { awaitCompletion: true });

    expect(await rootCount()).toBe(1);

    // And the surviving tree now carries a real (non-null) instance key.
    const keys = (await pool.query(
      `SELECT DISTINCT "sourceInstanceKey" FROM "Contexts" c
         JOIN "ContextAlgorithms" a ON a.id = c."sourceAlgorithmId"
        WHERE a.name = $1`,
      [PLUGIN_NAME],
    )).rows;
    expect(keys).toHaveLength(1);
    expect(keys[0].sourceInstanceKey).toBeTruthy();
  });
});
