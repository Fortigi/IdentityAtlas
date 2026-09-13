/**
 * Custom Connector's "card" in the UI is a CrawlerConfigs row paired with its
 * Crawlers row (the API key) — created together by POST /admin/crawlers and
 * cleaned up together by either delete path (this file's DELETE
 * /admin/crawlers/:id, or DELETE /admin/crawler-configs/:id in jobs.js).
 * These tests cover that pairing; the existing PowerShell integration test
 * (Test-CustomConnectorCrawler.ps1) only exercises the happy-path
 * register -> push -> verify flow, not deletion.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.USE_SQL = 'true'; // crawlers.js captures this at module-load time

const { mockPool, mockDbQuery } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  const mockPool = { query: (...a) => mockDbQuery(...a) };
  return { mockPool, mockDbQuery };
});

vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool }));
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const { adminCrawlersRouter } = await import('./crawlers.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', adminCrawlersRouter);
  return app;
}

beforeEach(() => {
  mockDbQuery.mockReset();
});

describe('POST /admin/crawlers', () => {
  it('creates the Crawlers row and a paired CrawlerConfigs row in one statement', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 42, displayName: 'My Connector', apiKeyPrefix: 'fgc_b69c', createdAt: '2026-06-19T00:00:00Z' }],
    });

    const res = await request(makeApp())
      .post('/api/admin/crawlers')
      .send({ displayName: 'My Connector' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(42);
    expect(res.body.apiKey).toMatch(/^fgc_/);

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const sql = mockDbQuery.mock.calls[0][0];
    const params = mockDbQuery.mock.calls[0][1];
    expect(sql).toContain('WITH new_crawler AS');
    expect(sql).toContain('INSERT INTO "Crawlers"');
    expect(sql).toContain('INSERT INTO "CrawlerConfigs"');
    // The paired-config type is a bound parameter (resolved from the pushMode
    // manifest flag), never hardcoded — see issue #368.
    expect(sql).not.toContain("'custom-connector'");
    expect(params).toContain('custom-connector');
    expect(sql).toContain('jsonb_build_object');
  });
});

describe('DELETE /admin/crawlers/:id', () => {
  it('permanent delete removes the paired CrawlerConfigs row in the same statement', async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(makeApp())
      .delete('/api/admin/crawlers/42')
      .send({ permanent: true });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/permanently removed/);

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const sql = mockDbQuery.mock.calls[0][0];
    const params = mockDbQuery.mock.calls[0][1];
    expect(sql).toContain('del_config AS');
    expect(sql).toContain('DELETE FROM "CrawlerConfigs"');
    // Bound push-mode type, not a hardcoded literal (issue #368).
    expect(sql).not.toContain("'custom-connector'");
    expect(params).toContain('custom-connector');
    expect(sql).toContain('crawlerId');
    expect(sql).toContain('DELETE FROM "Crawlers"');
  });

  it('soft delete (disable) only touches the Crawlers row, not CrawlerConfigs', async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(makeApp())
      .delete('/api/admin/crawlers/42')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/disabled/);

    const sql = mockDbQuery.mock.calls[0][0];
    expect(sql).not.toContain('CrawlerConfigs');
  });
});

// SEC-2026-09 M-06: admin-granted permissions are whitelisted, and the
// built-in worker row (isBuiltIn) cannot be renamed / disabled / deleted /
// re-permissioned through the API.
describe('crawler permissions whitelist', () => {
  it('POST refuses the worker-class admin permission without writing anything', async () => {
    const res = await request(makeApp()).post('/api/admin/crawlers').send({ displayName: 'x', permissions: ['ingest', 'admin'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ingest, refreshViews/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it.each([[[]], ['ingest'], [[1]], [Array(11).fill('ingest')]])('POST refuses malformed permissions %j', async (permissions) => {
    const res = await request(makeApp()).post('/api/admin/crawlers').send({ displayName: 'x', permissions });
    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('POST stores whitelisted permissions de-duplicated, and defaults to ingest', async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ id: 1 }] });
    await request(makeApp()).post('/api/admin/crawlers').send({ displayName: 'x', permissions: ['refreshViews', 'ingest', 'ingest'] });
    expect(mockDbQuery.mock.calls[0][1][6]).toBe(JSON.stringify(['refreshViews', 'ingest']));
    await request(makeApp()).post('/api/admin/crawlers').send({ displayName: 'y' });
    expect(mockDbQuery.mock.calls[1][1][6]).toBe(JSON.stringify(['ingest']));
  });

  it('PATCH refuses the admin permission', async () => {
    const res = await request(makeApp()).patch('/api/admin/crawlers/5').send({ permissions: ['admin'] });
    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe('built-in worker row is protected', () => {
  it('PATCH that renames guards the UPDATE on NOT isBuiltIn and answers 403 for the worker', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })             // guarded UPDATE matched nothing
      .mockResolvedValueOnce({ rows: [{ isBuiltIn: true }] });      // it is the worker
    const res = await request(makeApp()).patch('/api/admin/crawlers/1').send({ displayName: 'renamed' });
    expect(res.status).toBe(403);
    expect(mockDbQuery.mock.calls[0][0]).toContain(`AND NOT "isBuiltIn"`);
  });

  it.each([['enabled', false], ['permissions', ['ingest']], ['systemIds', [3]], ['expiresAt', '2030-01-01']])(
    'PATCH of %s is guarded', async (field, value) => {
      mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });
      await request(makeApp()).patch('/api/admin/crawlers/5').send({ [field]: value });
      expect(mockDbQuery.mock.calls[0][0]).toContain('AND NOT "isBuiltIn"');
    });

  it('PATCH of description / rateLimit only is allowed on the worker (no guard)', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1, isBuiltIn: true }], rowCount: 1 });
    const res = await request(makeApp()).patch('/api/admin/crawlers/1').send({ description: 'd', rateLimit: 5000 });
    expect(res.status).toBe(200);
    expect(mockDbQuery.mock.calls[0][0]).not.toContain('isBuiltIn');
  });

  it('PATCH answers 404 when the id does not exist', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] });
    expect((await request(makeApp()).patch('/api/admin/crawlers/99').send({ displayName: 'x' })).status).toBe(404);
  });

  it('soft delete of the worker is refused with 403', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ isBuiltIn: true }] });
    const res = await request(makeApp()).delete('/api/admin/crawlers/1').send({});
    expect(res.status).toBe(403);
    expect(mockDbQuery.mock.calls[0][0]).toContain('AND NOT "isBuiltIn"');
  });

  it('permanent delete of the worker is refused with 403 and only targets non-built-in rows', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ isBuiltIn: true }] });
    const res = await request(makeApp()).delete('/api/admin/crawlers/1').send({ permanent: true });
    expect(res.status).toBe(403);
    expect(mockDbQuery.mock.calls[0][0]).toContain('WHERE id = $2 AND NOT "isBuiltIn"');
  });

  it('delete of a missing id stays 404', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] });
    expect((await request(makeApp()).delete('/api/admin/crawlers/77').send({})).status).toBe(404);
  });
});
