import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockDb } = vi.hoisted(() => ({ mockDb: { query: vi.fn(), queryOne: vi.fn() } }));
vi.mock('../db/connection.js', () => mockDb);
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_req, _res, next) => next() }));
// Pin the running version so the intent/status recompute (isNewer vs running) is deterministic.
vi.mock('../updates/channel.js', () => ({
  resolveChannel: () => 'edge',
  getCurrentVersion: () => '5.310.20260629.1221',
}));
vi.mock('../updates/checkForUpdates.js', () => ({
  runUpdateCheck: vi.fn().mockResolvedValue({
    channel: 'edge', currentVersion: '5.310.20260629.1221',
    latestVersion: '5.311.20260630.0900', updateAvailable: true, status: 'available',
  }),
  recordLog: vi.fn().mockResolvedValue(undefined),
}));

const { default: router } = await import('./updates.js');
const cf = await import('../updates/checkForUpdates.js');
const app = express().use(express.json()).use('/api', router);

const RUNNING = '5.310.20260629.1221';
const NEWER = '5.311.20260630.0900';
const seenNow = () => new Date().toISOString();

beforeEach(() => { vi.clearAllMocks(); });

describe('updates routes', () => {
  it('GET /admin/updates/status reports web+worker versions, matched (no skew)', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'false' })                                  // auto flag
      .mockResolvedValueOnce({ id: 1, status: 'up-to-date', latestVersion: RUNNING });  // last check
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ component: 'worker', version: RUNNING, lastSeenAt: seenNow() }] }) // worker
      .mockResolvedValueOnce({ rows: [{ filename: '001_core_schema.sql' }, { filename: '002_governance.sql' }] }); // _migrations
    const res = await request(app).get('/api/admin/updates/status');
    expect(res.status).toBe(200);
    expect(res.body.components.web.version).toBe(RUNNING);
    expect(res.body.components.worker.version).toBe(RUNNING);
    expect(res.body.components.database.applied).toBe(2);
    expect(res.body.components.database.ahead).toBe(false);
    expect(res.body.skew.mismatch).toBe(false);
    expect(res.body.updateAvailable).toBe(false);
  });

  it('GET /admin/updates/status flags web/worker version skew', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'false' })
      .mockResolvedValueOnce({ id: 1, status: 'up-to-date', latestVersion: RUNNING });
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ component: 'worker', version: '5.309.20260628.1000', lastSeenAt: seenNow() }] })
      .mockResolvedValueOnce({ rows: [{ filename: '001_core_schema.sql' }] });
    const res = await request(app).get('/api/admin/updates/status');
    expect(res.body.skew.mismatch).toBe(true);
    expect(res.body.components.worker.version).toBe('5.309.20260628.1000');
  });

  it('GET /admin/updates/status flags applyStalled when auto-update is on and an update sits available', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'true' })                                   // enabled
      .mockResolvedValueOnce({ id: 1, status: 'available', latestVersion: NEWER })      // newer available
      .mockResolvedValueOnce({ since: threeDaysAgo });                                  // MIN(available since)
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ component: 'worker', version: RUNNING, lastSeenAt: seenNow() }] })
      .mockResolvedValueOnce({ rows: [{ filename: '001_core_schema.sql' }] });
    const res = await request(app).get('/api/admin/updates/status');
    expect(res.body.updateAvailable).toBe(true);
    expect(res.body.applyStalled).toBe(true);
  });

  it('GET /admin/updates/status does not flag applyStalled when the update only just appeared', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'true' })
      .mockResolvedValueOnce({ id: 1, status: 'available', latestVersion: NEWER })
      .mockResolvedValueOnce({ since: seenNow() });                                     // available just now
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ component: 'worker', version: RUNNING, lastSeenAt: seenNow() }] })
      .mockResolvedValueOnce({ rows: [{ filename: '001_core_schema.sql' }] });
    const res = await request(app).get('/api/admin/updates/status');
    expect(res.body.updateAvailable).toBe(true);
    expect(res.body.applyStalled).toBe(false);
  });

  it('PUT /admin/updates/auto persists the flag', async () => {
    mockDb.query.mockResolvedValueOnce({});
    const res = await request(app).put('/api/admin/updates/auto').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.autoUpdateEnabled).toBe(true);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('GET /admin/updates/log returns rows', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 2, status: 'installed' }] });
    const res = await request(app).get('/api/admin/updates/log');
    expect(res.status).toBe(200);
    expect(res.body.data[0].status).toBe('installed');
  });

  it('POST /admin/updates/check runs a check now', async () => {
    const res = await request(app).post('/api/admin/updates/check');
    expect(res.status).toBe(200);
    expect(cf.runUpdateCheck).toHaveBeenCalledWith({ source: 'manual' });
    expect(res.body.updateAvailable).toBe(true);
  });

  it('GET /updates/intent says shouldUpdate=true when enabled AND a newer version exists', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'true' })
      .mockResolvedValueOnce({ latestVersion: NEWER });
    const res = await request(app).get('/api/updates/intent');
    expect(res.status).toBe(200);
    expect(res.body.shouldUpdate).toBe(true);
    expect(res.body.updateAvailable).toBe(true);
    expect(res.body.latestVersion).toBe(NEWER);
  });

  it('GET /updates/intent recomputes against the running version — no re-apply loop once caught up', async () => {
    // The stored row can still say updateAvailable:true after a restart, but the
    // latest equals the running version, so intent must report false (staleness fix).
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'true' })
      .mockResolvedValueOnce({ latestVersion: RUNNING, updateAvailable: true });
    const res = await request(app).get('/api/updates/intent');
    expect(res.body.updateAvailable).toBe(false);
    expect(res.body.shouldUpdate).toBe(false);
  });

  it('GET /updates/intent says shouldUpdate=false when auto-update is off', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'false' })
      .mockResolvedValueOnce({ latestVersion: NEWER });
    const res = await request(app).get('/api/updates/intent');
    expect(res.body.shouldUpdate).toBe(false);
  });

  it('POST /admin/updates/record validates status and records valid ones', async () => {
    const bad = await request(app).post('/api/admin/updates/record').send({ status: 'bogus' });
    expect(bad.status).toBe(400);

    const ok = await request(app).post('/api/admin/updates/record')
      .send({ status: 'installed', fromVersion: '5.310.x', toVersion: '5.311.x' });
    expect(ok.status).toBe(200);
    expect(cf.recordLog).toHaveBeenCalledTimes(1);
  });
});
