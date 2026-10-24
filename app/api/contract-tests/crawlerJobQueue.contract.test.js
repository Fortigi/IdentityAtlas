// Contract test — one job per crawler configuration (real PG16).
//
// The worker claim is one SQL statement, and whether it holds a queued job back
// depends on real semantics: the NOT EXISTS against a running job of the same
// configuration, NULL configIds, the createdAt order and SKIP LOCKED. The unit
// mocks are SQL-blind, so this is where the rule is actually proven.
//
// Field failure it prevents: a full load of a customer's SailPoint database was
// still running when the scheduled delta of the same configuration fired; the
// worker claimed it and the two ran side by side.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { CLAIM_NEXT_JOB_SQL, findActiveConfigJob } from '../src/lib/crawlerJobQueue.js';

let pool;
let cfgA;
let cfgB;

const claim = async () => (await pool.query(CLAIM_NEXT_JOB_SQL)).rows[0] || null;

// A job with an explicit createdAt, so the queue order is the test's, not the clock's.
async function job(configId, status, minutesAgo) {
  const r = await pool.query(
    `INSERT INTO "CrawlerJobs" ("jobType", status, config, "configId", "createdAt")
     VALUES ('mssql', $1, '{}'::jsonb, $2, now() - ($3::int * interval '1 minute'))
     RETURNING id`,
    [status, configId, minutesAgo]);
  return r.rows[0].id;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const ins = `INSERT INTO "CrawlerConfigs" ("crawlerType", "displayName", config)
               VALUES ('mssql', $1, '{}'::jsonb) RETURNING id`;
  cfgA = (await pool.query(ins, ['job-queue A'])).rows[0].id;
  cfgB = (await pool.query(ins, ['job-queue B'])).rows[0].id;
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "CrawlerJobs" WHERE "configId" IN ($1, $2) OR ("configId" IS NULL AND "jobType" = 'mssql')`, [cfgA, cfgB]);
  await pool?.query(`DELETE FROM "CrawlerConfigs" WHERE id IN ($1, $2)`, [cfgA, cfgB]);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "CrawlerJobs" WHERE "configId" IN ($1, $2) OR ("configId" IS NULL AND "jobType" = 'mssql')`, [cfgA, cfgB]);
});

describe('CLAIM_NEXT_JOB_SQL', () => {
  it('passes over the older queued job of a busy configuration and claims the next configuration\'s', async () => {
    await job(cfgA, 'running', 600);          // the full load, started ten hours ago
    const delta = await job(cfgA, 'queued', 30);   // the scheduled delta — oldest queued job
    const other = await job(cfgB, 'queued', 10);   // another crawler, queued later

    const got = await claim();
    expect(got.id).toBe(other);
    expect(got.configId).toBe(cfgB);
    const still = await pool.query(`SELECT status FROM "CrawlerJobs" WHERE id = $1`, [delta]);
    expect(still.rows[0].status).toBe('queued');
  });

  it('claims nothing while the only queued job belongs to a configuration that is running', async () => {
    await job(cfgA, 'running', 600);
    await job(cfgA, 'queued', 30);
    expect(await claim()).toBeNull();
  });

  it('claims the held-back job once the running one has finished', async () => {
    const full = await job(cfgA, 'running', 600);
    const delta = await job(cfgA, 'queued', 30);
    expect(await claim()).toBeNull();

    await pool.query(`UPDATE "CrawlerJobs" SET status = 'completed' WHERE id = $1`, [full]);
    const got = await claim();
    expect(got.id).toBe(delta);
    const now = await pool.query(`SELECT status, "startedAt" FROM "CrawlerJobs" WHERE id = $1`, [delta]);
    expect(now.rows[0].status).toBe('running');
    expect(now.rows[0].startedAt).not.toBeNull();
  });

  it('is not held back by a finished, failed or cancelled job of the same configuration', async () => {
    await job(cfgA, 'completed', 900);
    await job(cfgA, 'failed', 800);
    await job(cfgA, 'cancelled', 700);
    const q = await job(cfgA, 'queued', 5);
    expect((await claim()).id).toBe(q);
  });

  it('never holds back an inline job, which belongs to no configuration', async () => {
    await job(null, 'running', 600);
    const inline = await job(null, 'queued', 5);
    expect((await claim()).id).toBe(inline);
  });

  it('still claims in createdAt order when nothing is running', async () => {
    const older = await job(cfgB, 'queued', 20);
    await job(cfgA, 'queued', 10);
    expect((await claim()).id).toBe(older);
  });
});

describe('findActiveConfigJob', () => {
  const q = (sql, params) => pool.query(sql, params);

  it('names the running job of a configuration, and ignores other configurations', async () => {
    const running = await job(cfgA, 'running', 60);
    await job(cfgB, 'completed', 60);
    expect(await findActiveConfigJob(q, cfgA)).toEqual({ id: running, status: 'running' });
    expect(await findActiveConfigJob(q, cfgB)).toBeNull();
  });

  it('counts a queued job as in the way too', async () => {
    const queued = await job(cfgB, 'queued', 1);
    expect(await findActiveConfigJob(q, cfgB)).toEqual({ id: queued, status: 'queued' });
  });
});
