// Contract test — the Crawlers page's job list keeps each crawler's last run of
// every mode (real PG16).
//
// With a delta every five minutes, ten deltas fill the "recent jobs" list within
// the hour and the last full run disappears from the page. `latestPerMode` adds
// the newest job per (crawler, mode) to the newest N. DISTINCT ON and the UNION
// are only meaningful against PostgreSQL, so this is where they are proven.
//
// The contract DB is shared, so this file's jobs are dated in the future (they
// are the newest N on the box) and only this file's configuration is asserted on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { recentJobsQuery } from '../src/lib/crawlerJobQueue.js';

let pool;
let cfg;
const ids = {};

async function job(name, syncMode, minutesFromNow) {
  const r = await pool.query(
    `INSERT INTO "CrawlerJobs" ("jobType", status, config, "configId", "createdAt")
     VALUES ('entra-id', 'completed', $1::jsonb, $2, now() + ($3::int * interval '1 minute'))
     RETURNING id`,
    [JSON.stringify({ _syncMode: syncMode }), cfg, minutesFromNow]);
  ids[name] = r.rows[0].id;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  cfg = (await pool.query(
    `INSERT INTO "CrawlerConfigs" ("crawlerType", "displayName", config) VALUES ('entra-id', 'recent-jobs', '{}'::jsonb) RETURNING id`,
  )).rows[0].id;
  await job('olderFull', 'full', 100);
  await job('lastFull', 'full', 200);
  for (let i = 1; i <= 12; i++) await job(`delta${i}`, 'delta', 300 + i);   // delta12 is the newest
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "CrawlerJobs" WHERE "configId" = $1`, [cfg]);
  await pool?.query(`DELETE FROM "CrawlerConfigs" WHERE id = $1`, [cfg]);
  await pool?.end();
});

async function listFor(limit, latestPerMode) {
  const { sql, params } = recentJobsQuery(limit, latestPerMode);
  const rows = (await pool.query(sql, params)).rows;
  return rows.filter(r => r.configId === cfg).map(r => Object.keys(ids).find(k => ids[k] === r.id));
}

describe('recentJobsQuery', () => {
  it('without latestPerMode: only the newest N — the full run has dropped out', async () => {
    expect(await listFor(10, false)).toEqual(
      ['delta12', 'delta11', 'delta10', 'delta9', 'delta8', 'delta7', 'delta6', 'delta5', 'delta4', 'delta3']);
  });

  it('with latestPerMode: the newest N plus the last full run, newest first, nothing twice', async () => {
    expect(await listFor(10, true)).toEqual(
      ['delta12', 'delta11', 'delta10', 'delta9', 'delta8', 'delta7', 'delta6', 'delta5', 'delta4', 'delta3', 'lastFull']);
  });

  it('adds only the LAST run of a mode, not every older one', async () => {
    const got = await listFor(3, true);
    expect(got).toEqual(['delta12', 'delta11', 'delta10', 'lastFull']);
    expect(got).not.toContain('olderFull');
  });
});
