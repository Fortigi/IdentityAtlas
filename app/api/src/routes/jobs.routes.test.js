// Unit tests for routes/jobs.js — crawler-config + crawler-job CRUD validation
// and list happy paths. DB + crawler helpers mocked. (configValidation / discover
// / fileUploads tests cover those specific endpoints.)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

let nextResult = { recordset: [], rowsAffected: [0] };
const mockPool = { request() { const r = { input() { return r; }, query() { return Promise.resolve(nextResult); } }; return r; } };
vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool, query: vi.fn(), queryOne: vi.fn() }));
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

beforeEach(() => { nextResult = { recordset: [], rowsAffected: [0] }; });

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
  it('GET list returns 200 (empty)', async () => {
    const res = await request(app).get('/api/admin/crawler-configs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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
  it('GET list returns 200 (empty)', async () => {
    const res = await request(app).get('/api/admin/crawler-jobs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
