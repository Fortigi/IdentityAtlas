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

// Normalise to dual-shape so both the shim callers (runs.js: .recordset /
// .rowsAffected) and the native callers (configs/helpers: .rows / .rowCount)
// read the same staged rows off one SQL dispatcher during the #663 migration.
const P = (v) => {
  const rows = v.rows ?? v.recordset ?? [];
  const rowCount = v.rowCount ?? v.rowsAffected?.[0] ?? rows.length;
  return Promise.resolve({ ...v, rows, recordset: rows, rowCount, rowsAffected: [rowCount] });
};
const poolQuery = vi.fn();
const dbQuery = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({
    request: () => { const r = { input() { return r; }, query: (...a) => poolQuery(...a) }; return r; },
    query: (...a) => poolQuery(...a),
  }),
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
  CRAWLER_MANIFESTS_DIR: '', _crawlerManifests: {}, VALID_JOB_TYPES: ['entra-id', 'csv', 'demo', 'rest-type'],
  // A fictional type that declares URL fields, so the connector-URL guard runs.
  getUrlFields: vi.fn(t => (t === 'rest-type' ? ['baseUrl', 'tokenEndpoint'] : [])),
  validateCrawlerConfig: vi.fn(() => null), validateStoredCrawlerConfig: vi.fn(async () => null),
  isSingletonJob: vi.fn(() => false), isPushModeType: vi.fn(() => false), isExperimentalType: vi.fn(() => false),
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
    if (/SELECT config, "nextRunMode".* FROM "CrawlerConfigs"/.test(sql)) return P({ recordset: [{ config: {}, nextRunMode: 'delta' }] });
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

// SEC-2026-09 M-03: connector URLs are vetted before a config is stored or a job
// queued. Literal IPs keep these tests off real DNS.
describe('connector-URL guard on config save and job creation', () => {
  const inserted = (re) => poolQuery.mock.calls.some(([sql]) => re.test(sql));
  const restExisting = (config) => poolQuery.mockImplementation((sql) => {
    if (/SELECT config, "crawlerType" FROM "CrawlerConfigs"/.test(sql)) return P({ recordset: [{ config, crawlerType: 'rest-type' }] });
    if (/UPDATE "CrawlerConfigs" SET config/.test(sql)) return P({ recordset: [{ id: 1, config: {} }] });
    return P({ recordset: [], rowsAffected: [0] });
  });

  it('POST config refuses a private base URL and stores nothing', async () => {
    const res = await request(app).post('/api/admin/crawler-configs')
      .send({ crawlerType: 'rest-type', displayName: 'X', config: { baseUrl: 'https://10.0.0.5/scim' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^baseUrl rejected: .*private.*Allow private network/);
    expect(inserted(/INSERT INTO "CrawlerConfigs"/)).toBe(false);
  });

  it('POST config refuses an http token endpoint unless allowInsecureHttp is set', async () => {
    const config = { baseUrl: 'https://8.8.8.8/scim', tokenEndpoint: 'http://8.8.4.4/token' };
    const refused = await request(app).post('/api/admin/crawler-configs').send({ crawlerType: 'rest-type', displayName: 'X', config });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/^tokenEndpoint rejected: URL must use https .*Allow insecure HTTP/);
    const allowed = await request(app).post('/api/admin/crawler-configs')
      .send({ crawlerType: 'rest-type', displayName: 'X', config: { ...config, allowInsecureHttp: true } });
    expect(allowed.status).toBe(201);
  });

  it('POST config with allowPrivateNetwork accepts a private address but never a metadata one', async () => {
    const ok = await request(app).post('/api/admin/crawler-configs')
      .send({ crawlerType: 'rest-type', displayName: 'X', config: { baseUrl: 'https://192.168.10.4/', allowPrivateNetwork: true } });
    expect(ok.status).toBe(201);
    const meta = await request(app).post('/api/admin/crawler-configs')
      .send({ crawlerType: 'rest-type', displayName: 'X', config: { baseUrl: 'https://[::ffff:169.254.169.254]/', allowPrivateNetwork: true } });
    expect(meta.status).toBe(400);
    expect(meta.body.error).toMatch(/link-local, metadata, or reserved/);
  });

  it('PATCH checks the MERGED config: an edit that only changes the host is still vetted', async () => {
    restExisting({ baseUrl: 'https://8.8.8.8/', tokenEndpoint: 'https://8.8.4.4/token' });
    const res = await request(app).patch('/api/admin/crawler-configs/1').send({ config: { tokenEndpoint: 'https://127.0.0.1:3001/api' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^tokenEndpoint rejected/);
    expect(inserted(/UPDATE "CrawlerConfigs" SET config/)).toBe(false);
  });

  it('PATCH that turns the opt-in off re-vets the stored private URL', async () => {
    restExisting({ baseUrl: 'https://10.1.1.1/', allowPrivateNetwork: true });
    const res = await request(app).patch('/api/admin/crawler-configs/1').send({ config: { allowPrivateNetwork: false } });
    expect(res.status).toBe(400);
    restExisting({ baseUrl: 'https://10.1.1.1/', allowPrivateNetwork: true });
    expect((await request(app).patch('/api/admin/crawler-configs/1').send({ config: { pageSize: 50 } })).status).toBe(200);
  });

  it('POST job refuses an inline config pointing at a metadata address and queues nothing', async () => {
    const res = await request(app).post('/api/admin/crawler-jobs')
      .send({ jobType: 'rest-type', config: { baseUrl: 'https://169.254.169.254/latest' } });
    expect(res.status).toBe(400);
    expect(inserted(/INSERT INTO "CrawlerJobs"/)).toBe(false);
  });

  it('POST job re-vets a stored config (saved before the guard existed)', async () => {
    poolQuery.mockImplementation((sql) => {
      if (/SELECT config, "nextRunMode".* FROM "CrawlerConfigs"/.test(sql)) return P({ recordset: [{ config: { baseUrl: 'http://10.0.0.9/' }, nextRunMode: 'delta' }] });
      return P({ recordset: [{ id: 5 }] });
    });
    const res = await request(app).post('/api/admin/crawler-jobs').send({ jobType: 'rest-type', configId: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^baseUrl rejected: URL must use https/);
    expect(inserted(/INSERT INTO "CrawlerJobs"/)).toBe(false);
  });

  it('types that declare no URL fields are not affected', async () => {
    const res = await request(app).post('/api/admin/crawler-configs')
      .send({ crawlerType: 'demo', displayName: 'Demo', config: { baseUrl: 'http://127.0.0.1/' } });
    expect(res.status).toBe(201);
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
