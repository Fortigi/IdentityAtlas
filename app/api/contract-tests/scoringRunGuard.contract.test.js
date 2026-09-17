// Contract test — risk-scoring concurrency guard (SEC-2026-09 L-11).
//
// The "insert only when idle" statement relies on real SQL semantics (typed
// INSERT ... SELECT parameters, the status filter and the staleness window),
// so it is verified against the migrated schema.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { insertScoringRunIfIdle, STALE_RUN_MINUTES } from '../src/riskscoring/scoringRunGuard.js';

let pool;
// queryOne-shaped adapter over a plain pg pool.
const db = { queryOne: async (sql, params) => (await pool.query(sql, params)).rows[0] || null };

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ScoringRuns"`);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ScoringRuns"`);
});

describe('insertScoringRunIfIdle', () => {
  it('inserts a pending run when nothing is in flight', async () => {
    const run = await insertScoringRunIfIdle(db, null, 'contract');
    expect(run).toMatchObject({ status: 'pending', step: 'Queued', triggeredBy: 'contract' });
  });

  it('refuses while a pending or running run exists, and allows again once it completed', async () => {
    const first = await insertScoringRunIfIdle(db, null, 'first');
    expect(await insertScoringRunIfIdle(db, null, 'second')).toBeNull();

    await pool.query(`UPDATE "ScoringRuns" SET status = 'running' WHERE id = $1`, [first.id]);
    expect(await insertScoringRunIfIdle(db, null, 'third')).toBeNull();

    await pool.query(`UPDATE "ScoringRuns" SET status = 'completed' WHERE id = $1`, [first.id]);
    expect(await insertScoringRunIfIdle(db, null, 'fourth')).not.toBeNull();
  });

  it('ignores a run abandoned longer ago than the staleness window', async () => {
    await pool.query(
      `INSERT INTO "ScoringRuns" (status, "startedAt") VALUES ('running', now() - ($1::int * interval '1 minute'))`,
      [STALE_RUN_MINUTES + 5]
    );
    expect(await insertScoringRunIfIdle(db, null, 'after-crash')).not.toBeNull();
  });
});
