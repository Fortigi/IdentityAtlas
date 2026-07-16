// Contract test — the context-plugin runner reconciles a cyclic plugin batch
// without persisting a cycle (#627, gap #1).
//
// The silent breakCycles-after-reconcile repair was removed. Two things now keep
// the tree acyclic: linkContextParents skips a loop-closing parent link
// (wouldCreateCycle), and migration 059's deferred trigger is the backstop. This
// registers a throwaway plugin that emits an A<->B parent loop, runs it through
// enqueueRun against real PG, and asserts the persisted tree is acyclic and the
// run succeeded — i.e. the skip handled the loop and no cycle reached commit. If
// the skip were removed, both links would be written and the trigger would abort
// the run (status 'failed'), so this test is load-bearing for the skip.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';

const PLUGIN_NAME = 'contract-cyclic-627';

let enqueueRun;
let REGISTERED_PLUGINS;
let pool;
let systemId;

const CYCLIC_PLUGIN = {
  name: PLUGIN_NAME,
  displayName: 'Cyclic Test (627)',
  targetType: 'Principal',
  async run() {
    // A -> B and B -> A: a genuine batch-internal 2-cycle in the parent structure.
    return {
      contexts: [
        { externalId: 'A', displayName: 'Ctx A', parentExternalId: 'B' },
        { externalId: 'B', displayName: 'Ctx B', parentExternalId: 'A' },
      ],
      members: [],
    };
  },
};

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
  ({ enqueueRun } = await import('../src/contexts/plugins/runner.js'));
  ({ REGISTERED_PLUGINS } = await import('../src/contexts/plugins/registry.js'));
  REGISTERED_PLUGINS.push(CYCLIC_PLUGIN);
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','cyclic-627') RETURNING id`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await cleanup();
  await pool.query(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  const i = REGISTERED_PLUGINS.findIndex((p) => p.name === PLUGIN_NAME);
  if (i >= 0) REGISTERED_PLUGINS.splice(i, 1);
  await pool.end();
});

beforeEach(cleanup);

async function cleanup() {
  await pool.query(`DELETE FROM "Contexts" WHERE "sourceAlgorithmId" IN (SELECT id FROM "ContextAlgorithms" WHERE name = $1)`, [PLUGIN_NAME]);
  await pool.query(`DELETE FROM "ContextAlgorithms" WHERE name = $1`, [PLUGIN_NAME]);
}

async function seedAlgorithm() {
  await pool.query(
    `INSERT INTO "ContextAlgorithms" ("id", "name", "displayName", "targetType")
     VALUES ($1, $2, 'Cyclic Test', 'Principal')`,
    [randomUUID(), PLUGIN_NAME],
  );
}

describe('runner — cyclic plugin batch (#627)', () => {
  it('reconciles an A<->B parent loop into an acyclic tree with no persisted cycle', async () => {
    await seedAlgorithm();
    const runId = await enqueueRun(PLUGIN_NAME, { scopeSystemId: systemId }, 'contract-test', { awaitCompletion: true });

    const { rows } = await pool.query(
      `SELECT id, "parentContextId" FROM "Contexts"
        WHERE "sourceAlgorithmId" IN (SELECT id FROM "ContextAlgorithms" WHERE name = $1)`,
      [PLUGIN_NAME],
    );
    expect(rows).toHaveLength(2);

    // The loop-closing link was skipped, so at most one of the two carries a parent.
    expect(rows.filter((r) => r.parentContextId !== null).length).toBeLessThanOrEqual(1);

    // No node is its own ancestor — walk each parent chain to a root, never revisiting.
    const parentOf = new Map(rows.map((r) => [r.id, r.parentContextId]));
    for (const start of parentOf.keys()) {
      const seen = new Set();
      let cur = start;
      while (cur != null && !seen.has(cur)) { seen.add(cur); cur = parentOf.get(cur) ?? null; }
      expect(cur).toBeNull(); // reached a root → acyclic (a cycle would leave cur non-null)
    }

    // The skip handled the loop up front, so the run succeeded (trigger never fired).
    const run = await pool.query(`SELECT status FROM "ContextAlgorithmRuns" WHERE id = $1`, [runId]);
    expect(run.rows[0].status).toBe('succeeded');
  });
});
