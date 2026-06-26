// Contract test — context-plugin runner (enqueueRun) against a real PostgreSQL
// schema.
//
// Verifies the run-enqueue path's SQL runs against the real schema: the
// ContextAlgorithms lookup, the ContextAlgorithmRuns INSERT, and the two guard
// errors (unknown plugin / unregistered algorithm). enqueueRun uses the shared
// db/connection.js pool, so DATABASE_URL is pointed at the contract DB before
// the module is imported.
//
// Full reconciliation (diff/merge of ContextMembers) is intentionally left to a
// higher-layer test — it runs a real registered plugin against live data and is
// entangled with the in-flight assignment/context-model migrations (045-047).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';

const PLUGIN_NAME = 'principal-type-tree'; // a real registered plugin (registry.js)

let enqueueRun;
let pool;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
  ({ enqueueRun } = await import('../src/contexts/plugins/runner.js'));
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

beforeEach(cleanup);

async function cleanup() {
  // Contexts reference the algorithm; remove them before the algorithm row.
  // Deleting the ContextAlgorithms row cascades its ContextAlgorithmRuns.
  await pool.query(`DELETE FROM "Contexts" WHERE "sourceAlgorithmId" IN (SELECT id FROM "ContextAlgorithms" WHERE name = $1)`, [PLUGIN_NAME]);
  await pool.query(`DELETE FROM "ContextAlgorithms" WHERE name = $1`, [PLUGIN_NAME]);
}

async function seedAlgorithm() {
  const r = await pool.query(
    `INSERT INTO "ContextAlgorithms" ("id", "name", "displayName", "targetType")
     VALUES ($1, $2, 'Principal Type Tree', 'Principal') RETURNING "id"`,
    [randomUUID(), PLUGIN_NAME],
  );
  return r.rows[0].id;
}

describe('enqueueRun — guards', () => {
  it('throws for an unknown plugin name', async () => {
    await expect(enqueueRun('no-such-plugin', {}, 'test')).rejects.toThrow(/Unknown plugin/);
  });

  it('throws when the plugin has no ContextAlgorithms row', async () => {
    // Registered in the registry, but not seeded into ContextAlgorithms.
    await expect(enqueueRun(PLUGIN_NAME, {}, 'test')).rejects.toThrow(/not registered/);
  });
});

describe('enqueueRun — inserts a run row', () => {
  it('inserts a ContextAlgorithmRuns row linked to the algorithm', async () => {
    const algorithmId = await seedAlgorithm();

    // awaitCompletion runs executeRun inline so the row reaches a terminal state
    // before we assert (no dangling background work). We assert on the row's
    // identity/linkage, not the plugin's output (which depends on seeded data).
    const runId = await enqueueRun(PLUGIN_NAME, { values: ['ManagedIdentity'] }, 'contract-test', { awaitCompletion: true });

    expect(typeof runId).toBe('string');
    const run = await pool.query(
      `SELECT "algorithmId", "triggeredBy", status, parameters FROM "ContextAlgorithmRuns" WHERE id = $1`,
      [runId],
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0].algorithmId).toBe(algorithmId);
    expect(run.rows[0].triggeredBy).toBe('contract-test');
    expect(['queued', 'running', 'succeeded', 'failed', 'cancelled']).toContain(run.rows[0].status);
    expect(run.rows[0].parameters).toMatchObject({ values: ['ManagedIdentity'] });
  });
});
