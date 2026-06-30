import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockDb } = vi.hoisted(() => ({ mockDb: { query: vi.fn(), queryOne: vi.fn() } }));
vi.mock('../db/connection.js', () => mockDb);
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_req, _res, next) => next() }));
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

beforeEach(() => { vi.clearAllMocks(); });

describe('updates routes', () => {
  it('GET /admin/updates/status returns version + flag + last check', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'true' })         // auto flag
      .mockResolvedValueOnce({ id: 1, status: 'available' }); // last check
    const res = await request(app).get('/api/admin/updates/status');
    expect(res.status).toBe(200);
    expect(res.body.autoUpdateEnabled).toBe(true);
    expect(res.body.lastCheck.status).toBe('available');
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

  it('GET /updates/intent says shouldUpdate=true when enabled AND available', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'true' })
      .mockResolvedValueOnce({ latestVersion: '5.311.20260630.0900', updateAvailable: true });
    const res = await request(app).get('/api/updates/intent');
    expect(res.status).toBe(200);
    expect(res.body.shouldUpdate).toBe(true);
    expect(res.body.latestVersion).toBe('5.311.20260630.0900');
  });

  it('GET /updates/intent says shouldUpdate=false when auto-update is off', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ configValue: 'false' })
      .mockResolvedValueOnce({ latestVersion: '5.311.20260630.0900', updateAvailable: true });
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
