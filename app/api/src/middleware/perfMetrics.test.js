// middleware/perfMetrics.js — what a request leaves behind in the collector.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const record = vi.fn();
vi.mock('../perf/collector.js', () => ({
  isEnabled: () => true,
  record: (...a) => record(...a),
}));

const { perfMetrics, pathOnly } = await import('./perfMetrics.js');

beforeEach(() => record.mockClear());

describe('pathOnly', () => {
  it('drops the query string and keeps the path', () => {
    expect(pathOnly('/api/identities?search=jane.doe&limit=5')).toBe('/api/identities');
    expect(pathOnly('/api/user/abc-123')).toBe('/api/user/abc-123');
    expect(pathOnly('/api/x?')).toBe('/api/x');
    expect(pathOnly(undefined)).toBe('');
  });
});

describe('perfMetrics records no query strings (SEC-2026-09 L-02)', () => {
  it('stores the request path without the query, plus the route pattern', async () => {
    const app = express();
    app.use(perfMetrics);
    app.get('/api/user/:id', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/api/user/u-42?search=secret-term&filter=dept');
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0][0];
    expect(entry.url).toBe('/api/user/u-42');
    expect(entry.url).not.toContain('secret-term');
    expect(entry).toMatchObject({ method: 'GET', statusCode: 200 });
  });
});
