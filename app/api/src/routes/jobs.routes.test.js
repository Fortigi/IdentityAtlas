// Unit tests for the jobs split's route handlers — crawler-config + crawler-job
// CRUD (validation, success and not-found branches), system status and the
// trace-log tail. DB + crawler helpers mocked; a SQL-routed pool mock drives each
// handler through its branches, and the log endpoint reads a real temp file.
// (configValidation / discover / fileUploads tests cover those specific endpoints.)

import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

const TRACE = mkdtempSync(join(tmpdir(), 'jobs-log-'));
process.env.TRACE_DIR = TRACE;
process.env.USE_SQL = 'true';
writeFileSync(join(TRACE, '7.log'), 'hello world trace');

const P = (v) => Promise.resolve(v);
const poolQuery = vi.fn();
const dbQuery = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({ request: () => { const r = { input() { return r; }, query: (...a) => poolQuery(...a) }; return r; } }),
  query: (...a) => dbQuery(...a),
  queryOne: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('./crawlerFiles.js', () => ({ getUploadFolderPath: vi.fn(() => '/tmp/x'), deleteConfigFolder: vi.fn(async () => {}) }));
vi.mock('../secrets/crawlerSecrets.js', () => ({
  storeConfigSecret: vi.fn(async () => {}), hasConfigSecret: vi.fn(async () => false),
  deleteConfigSecret: vi.fn(async () => {}), getConfigSecret: vi.fn(async () => null),
  storeJobSecret: vi.fn(async () => {}), storeJobCredentials: vi.fn(async () => {}), OTHER_SECRET_FIELDS: [],
}));
vi.mock('../crawlerManifests.js', () => ({
  CRAWLER_MANIFESTS_DIR: '', _crawlerManifests: {}, VALID_JOB_TYPES: ['entra-id', 'csv', 'demo'],
  validateCrawlerConfig: vi.fn(() => null), validateStoredCrawlerConfig: vi.fn(async () => null),
  isSingletonJob: vi.fn(() => false), isPushModeType: vi.fn(() => false),
}));

const { default: router } = await import('./jobs.js');
const app = mountRouter(router);

// Default routing: every handler's queries resolve to a plausible row so the
// success branches run. Individual tests override for the not-found cases.
beforeEach(() => {
  poolQuery.mockReset();
  dbQuery.mockReset();
  poolQuery.mockImplementation((sql) => {
    if (/INSERT INTO "CrawlerConfigs"/.test(sql)) return P({ recordset: [{ id: 1, crawlerType: 'demo', config: {} }] });
    if (/UPDATE "CrawlerConfigs" SET config/.test(sql)) return P({ recordset: [{ id: 1, config: {} }] });
    if (/SELECT config, "crawlerType" FROM "CrawlerConfigs"/.test(sql)) return P({ recordset: [{ config: {}, crawlerType: 'demo' }] });
    if (/SELECT "crawlerType", config FROM "CrawlerConfigs"/.test(sql)) return P({ recordset: [{ crawlerType: 'demo', config: {} }] });
    if (/SELECT config, "nextRunMode" FROM "CrawlerConfigs"/.test(sql)) return P({ recordset: [{ config: {}, nextRunMode: 'delta' }] });
    if (/DELETE FROM "CrawlerConfigs"/.test(sql)) return P({ recordset: [], rowsAffected: [1] });
    if (/SELECT \* FROM "CrawlerConfigs"/.test(sql)) return P({ recordset: [{ id: 1, config: {} }] });
    if (/INSERT INTO "CrawlerJobs"/.test(sql)) return P({ recordset: [{ id: 5, jobType: 'demo' }] });
    if (/SELECT \* FROM "CrawlerJobs" WHERE id/.test(sql)) return P({ recordset: [{ id: 5 }] });
    if (/SELECT \* FROM "CrawlerJobs" ORDER BY/.test(sql)) return P({ recordset: [{ id: 5 }] });
    if (/to_regclass/.test(sql)) return P({ recordset: [{ hasData: 1, crawlerCount: 2, configCount: 1, pendingJobs: 0, runningJobs: 1 }] });
    return P({ recordset: [], rowsAffected: [0] });
  });
  dbQuery.mockImplementation((sql) => /UPDATE "CrawlerJobs"/.test(sql) ? P({ rowCount: 1 }) : P({ rowCount: 0 }));
});

describe('crawler-configs — validation', () => {
  it('POST 400 when crawlerType/displayName are missing', async () => {
    expect((await request(app).post('/api/admin/crawler-configs').send({})).status).toBe(400);
  });
  it('GET/:id 400 on a non-integer id', async () => {
    expect((await request(app).get('/api/admin/crawler-configs/abc')).status).toBe(400);
  });
  it('PATCH/:id 400 on a non-integer id', async () => {
    expect((await request(app).patch('/api/admin/crawler-configs/abc').send({})).status).toBe(400);
  });
  it('DELETE/:id 400 on a non-integer id', async () => {
    expect((await request(app).delete('/api/admin/crawler-configs/abc')).status).toBe(400);
  });
});

describe('crawler-configs — CRUD', () => {
  it('POST creates a config (201, secret masked)', async () => {
    const res = await request(app).post('/api/admin/crawler-configs')
      .send({ crawlerType: 'demo', displayName: 'Demo', config: { clientSecret: 's' } });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
  });
  it('GET/:id returns a config', async () => {
    expect((await request(app).get('/api/admin/crawler-configs/1')).status).toBe(200);
  });
  it('GET/:id 404 when absent', async () => {
    poolQuery.mockImplementation(() => P({ recordset: [] }));
    expect((await request(app).get('/api/admin/crawler-configs/9')).status).toBe(404);
  });
  it('PATCH updates a config', async () => {
    const res = await request(app).patch('/api/admin/crawler-configs/1')
      .send({ displayName: 'New', config: { foo: 'bar' }, nextRunMode: 'full' });
    expect(res.status).toBe(200);
  });
  it('DELETE removes a config', async () => {
    expect((await request(app).delete('/api/admin/crawler-configs/1')).status).toBe(200);
  });
  it('GET list returns configs', async () => {
    const res = await request(app).get('/api/admin/crawler-configs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('crawler-jobs — validation', () => {
  it('POST 400 on an unknown jobType', async () => {
    expect((await request(app).post('/api/admin/crawler-jobs').send({ jobType: 'bogus' })).status).toBe(400);
  });
  it('POST 400 on an invalid syncMode', async () => {
    expect((await request(app).post('/api/admin/crawler-jobs').send({ jobType: 'demo', syncMode: 'weird' })).status).toBe(400);
  });
  it('POST 400 on a non-positive configId', async () => {
    expect((await request(app).post('/api/admin/crawler-jobs').send({ jobType: 'demo', configId: -1 })).status).toBe(400);
  });
  it('GET/:id 400 on a non-integer id', async () => {
    expect((await request(app).get('/api/admin/crawler-jobs/abc')).status).toBe(400);
  });
  it('DELETE/:id 400 on a non-integer id', async () => {
    expect((await request(app).delete('/api/admin/crawler-jobs/abc')).status).toBe(400);
  });
  it('force-stop 400 on a non-integer id', async () => {
    expect((await request(app).post('/api/admin/crawler-jobs/abc/force-stop')).status).toBe(400);
  });
  it('log 400 on a non-integer id', async () => {
    expect((await request(app).get('/api/admin/crawler-jobs/abc/log')).status).toBe(400);
  });
});

describe('crawler-jobs — lifecycle', () => {
  it('POST creates an inline job (201)', async () => {
    const res = await request(app).post('/api/admin/crawler-jobs').send({ jobType: 'demo', config: {} });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(5);
  });
  it('POST creates a config-sourced job (201)', async () => {
    const res = await request(app).post('/api/admin/crawler-jobs').send({ jobType: 'demo', configId: 1, syncMode: 'full' });
    expect(res.status).toBe(201);
  });
  it('GET/:id returns a job', async () => {
    expect((await request(app).get('/api/admin/crawler-jobs/5')).status).toBe(200);
  });
  it('GET list returns jobs', async () => {
    expect((await request(app).get('/api/admin/crawler-jobs')).body).toHaveLength(1);
  });
  it('DELETE cancels a queued job', async () => {
    expect((await request(app).delete('/api/admin/crawler-jobs/5')).status).toBe(200);
  });
  it('DELETE 404 when nothing queued', async () => {
    dbQuery.mockImplementation(() => P({ rowCount: 0 }));
    expect((await request(app).delete('/api/admin/crawler-jobs/5')).status).toBe(404);
  });
  it('force-stop marks a running job failed', async () => {
    expect((await request(app).post('/api/admin/crawler-jobs/5/force-stop')).status).toBe(200);
  });
});

describe('status + trace log', () => {
  it('GET /admin/status reports flags', async () => {
    const res = await request(app).get('/api/admin/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasData: true, hasCrawlers: true, runningJobs: 1 });
  });
  it('GET /crawler-jobs/:id/log tails an existing log file', async () => {
    const res = await request(app).get('/api/admin/crawler-jobs/7/log');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exists: true, text: 'hello world trace' });
  });
  it('GET /crawler-jobs/:id/log reports a missing file', async () => {
    const res = await request(app).get('/api/admin/crawler-jobs/999/log');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
  });
});
