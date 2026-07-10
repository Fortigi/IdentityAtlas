// Unit tests for routes/crawlers.js — admin CRUD validation/list and self-service
// auth + validation. DB + crawler helpers mocked. (crawlers.test.js covers the
// create/delete pairing; crawlers.selfservice.authz.test.js covers 403 worker gates.)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

let nextResult = { recordset: [], rowsAffected: [0] };
const mockPool = { request() { const r = { input() { return r; }, query() { return Promise.resolve(nextResult); } }; return r; } };
const query = vi.fn();
vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool, query: (...a) => query(...a), queryOne: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('../secrets/crawlerSecrets.js', () => ({ injectJobSecret: vi.fn(async (j) => j.config), deleteJobSecret: vi.fn(async () => {}) }));
vi.mock('../crawlerManifests.js', () => ({ getPushModeType: vi.fn(() => null) }));
vi.mock('../postCrawlJobs.js', () => ({ runPostCrawlJobs: vi.fn(async () => {}) }));
vi.mock('../middleware/crawlerAuth.js', () => ({ crawlerHasPermission: vi.fn(() => true), crawlerHasSystemAccess: vi.fn(() => true) }));

const { adminCrawlersRouter, selfServiceCrawlersRouter } = await import('./crawlers.js');
const adminApp = mountRouter(adminCrawlersRouter);

// Self-service requests carry a crawler identity (set by the API-key middleware
// in production). Inject one so we can reach the handler validation.
function crawlerApp(crawler) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (crawler) req.crawler = crawler; next(); });
  app.use('/api', selfServiceCrawlersRouter);
  return request(app);
}
const WORKER = { id: 1, systemIds: [1], permissions: ['admin'] };

beforeEach(() => {
  nextResult = { recordset: [], rowsAffected: [0] };
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('admin crawlers', () => {
  it('GET /admin/crawlers returns 200 list', async () => {
    const res = await request(adminApp).get('/api/admin/crawlers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
  it('POST 400 when displayName is missing', async () => {
    expect((await request(adminApp).post('/api/admin/crawlers').send({})).status).toBe(400);
  });
  it('PATCH/:id 400 on a non-integer id', async () => {
    expect((await request(adminApp).patch('/api/admin/crawlers/abc').send({})).status).toBe(400);
  });
  it('DELETE/:id 400 on a non-integer id', async () => {
    expect((await request(adminApp).delete('/api/admin/crawlers/abc')).status).toBe(400);
  });
  it('GET/:id/audit 400 on a non-integer id', async () => {
    expect((await request(adminApp).get('/api/admin/crawlers/abc/audit')).status).toBe(400);
  });
  it('POST/:id/reset 400 on a non-integer id', async () => {
    expect((await request(adminApp).post('/api/admin/crawlers/abc/reset')).status).toBe(400);
  });
});

describe('self-service crawlers — auth + validation', () => {
  it('GET /crawlers/whoami 401 without a crawler key', async () => {
    expect((await crawlerApp(null).get('/api/crawlers/whoami')).status).toBe(401);
  });
  it('POST /crawlers/jobs/claim 401 without a crawler key', async () => {
    expect((await crawlerApp(null).post('/api/crawlers/jobs/claim')).status).toBe(401);
  });
  it('GET /crawlers/whoami 200 echoes the crawler', async () => {
    const res = await crawlerApp(WORKER).get('/api/crawlers/whoami');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1 });
  });
  it('POST /crawlers/jobs/:id/phases 400 when phases is not an array', async () => {
    expect((await crawlerApp(WORKER).post('/api/crawlers/jobs/1/phases').send({ phases: 'nope' })).status).toBe(400);
  });
  it('POST /crawlers/jobs/:id/complete 400 on a non-integer id', async () => {
    expect((await crawlerApp(WORKER).post('/api/crawlers/jobs/abc/complete')).status).toBe(400);
  });
  it('POST /crawlers/configs/:id/mark-delta-mode 400 on a non-integer id', async () => {
    expect((await crawlerApp(WORKER).post('/api/crawlers/configs/abc/mark-delta-mode')).status).toBe(400);
  });
});

describe('admin crawlers — happy paths', () => {
  it('GET/:id/audit returns the paginated log + total', async () => {
    // The handler batches two SELECTs and reads result.recordsets[0]/[1].
    nextResult = { recordsets: [[{ action: 'created' }], [{ total: 1 }]] };
    const res = await request(adminApp).get('/api/admin/crawlers/42/audit');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [{ action: 'created' }], total: 1 });
  });
  it('PATCH/:id updates a crawler', async () => {
    nextResult = { recordset: [{ id: 42, displayName: 'X', enabled: true }], rowsAffected: [1] };
    expect((await request(adminApp).patch('/api/admin/crawlers/42').send({ displayName: 'Y' })).status).toBe(200);
  });
  it('POST/:id/reset regenerates the key', async () => {
    nextResult = { recordset: [{ id: 42, displayName: 'X' }], rowsAffected: [1] };
    const res = await request(adminApp).post('/api/admin/crawlers/42/reset');
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toMatch(/^fgc_/);
  });
});

describe('self-service crawlers — happy paths (worker key)', () => {
  const asWorker = () => crawlerApp(WORKER);
  it('rotate returns a new key', async () => {
    nextResult = { recordset: [], rowsAffected: [1] };
    const res = await asWorker().post('/api/crawlers/rotate');
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toMatch(/^fgc_/);
  });
  it('job-progress merges progress into a running job', async () => {
    nextResult = { recordset: [{ status: 'running', progress: '{}' }], rowsAffected: [1] };
    const res = await asWorker().post('/api/crawlers/job-progress').send({ jobId: 5, step: 'x', pct: 50, detail: 'd' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
  it('claim returns null on an empty queue', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await asWorker().post('/api/crawlers/jobs/claim');
    expect(res.status).toBe(200);
    expect(res.body.job).toBeNull();
  });
  it('claim returns the next job with its secret injected', async () => {
    query.mockResolvedValue({ rows: [{ id: 9, jobType: 'demo', config: {} }] });
    const res = await asWorker().post('/api/crawlers/jobs/claim');
    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(9);
  });
  it('mark-delta-mode flips the config', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect((await asWorker().post('/api/crawlers/configs/3/mark-delta-mode')).status).toBe(200);
  });
  it('GET delta-token returns null when absent', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await asWorker().get('/api/crawlers/delta-tokens/users?systemId=1');
    expect(res.body).toEqual({ token: null, lastSyncAt: null });
  });
  it('PUT delta-token stores it', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect((await asWorker().put('/api/crawlers/delta-tokens/users').send({ systemId: 1, token: 'tok' })).status).toBe(200);
  });
  it('DELETE delta-token removes it', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect((await asWorker().delete('/api/crawlers/delta-tokens/users?systemId=1')).status).toBe(200);
  });
  it('phases stores the array', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    const res = await asWorker().post('/api/crawlers/jobs/5/phases').send({ phases: [{ name: 'a' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 1 });
  });
  it('complete marks the job completed', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect((await asWorker().post('/api/crawlers/jobs/5/complete').send({ result: { ok: 1 } })).status).toBe(200);
  });
  it('fail marks the job failed', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect((await asWorker().post('/api/crawlers/jobs/5/fail').send({ errorMessage: 'boom' })).status).toBe(200);
  });
});
