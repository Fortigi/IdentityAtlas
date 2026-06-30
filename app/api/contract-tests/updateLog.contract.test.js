// Contract test — UpdateLog (migration 050) + recordLog against the real schema.
// Verifies the column set, the boolean/timestamp defaults, and that the
// newest-first ordering the API relies on works.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { recordLog } from '../src/updates/checkForUpdates.js';

let pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "UpdateLog"`);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "UpdateLog"`);
});

describe('UpdateLog', () => {
  it('recordLog inserts a fully-populated row', async () => {
    await recordLog(
      {
        channel: 'edge',
        currentVersion: '5.310.20260629.1221',
        latestVersion: '5.311.20260630.0900',
        updateAvailable: true,
        status: 'available',
        detail: 'newer build on main',
        source: 'manual',
      },
      pool
    );
    const r = await pool.query(`SELECT * FROM "UpdateLog"`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].channel).toBe('edge');
    expect(r.rows[0].status).toBe('available');
    expect(r.rows[0].updateAvailable).toBe(true);
    expect(r.rows[0].latestVersion).toBe('5.311.20260630.0900');
    expect(r.rows[0].createdAt).toBeTruthy(); // default now()
  });

  it('defaults updateAvailable to false and supports newest-first ordering', async () => {
    await recordLog({ channel: 'latest', status: 'up-to-date' }, pool);
    await recordLog({ channel: 'latest', status: 'installed', detail: 'a→b' }, pool);
    const r = await pool.query(
      `SELECT status, "updateAvailable" FROM "UpdateLog" ORDER BY "createdAt" DESC, id DESC LIMIT 1`
    );
    expect(r.rows[0].status).toBe('installed');
    expect(r.rows[0].updateAvailable).toBe(false);
  });
});
