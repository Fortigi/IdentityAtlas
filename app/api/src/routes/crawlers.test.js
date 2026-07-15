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
  mockDbQuery.mockClear();
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
    expect(sql).toContain('WITH del_config AS');
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
