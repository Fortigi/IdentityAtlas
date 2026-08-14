// Unit tests for crawlerAuthMiddleware — the request-level guard chain.
// The DB is the shared manual mock (src/db/__mocks__/connection.js); crypto and
// the in-memory rate-limit / auth caches run for real. USE_SQL is set before the
// module is imported so `useSql` resolves true for the main flows.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');
const { query } = await import('../db/connection.js');
const { crawlerAuthMiddleware } = await import('./crawlerAuth.js');

const SALT = Buffer.from('0123456789abcdef');
const API_KEY = 'fgc_HAPPYkey';
const VALID_HASH = crypto.scryptSync(API_KEY, SALT, 64, { N: 16384, r: 8, p: 1 });
const AUTH_HEADER = { authorization: `Bearer ${API_KEY}` };

let nextId = 200;
function crawlerRow(over = {}) {
  return {
    id: nextId++,
    displayName: 'Ext',
    apiKeyHash: VALID_HASH,
    apiKeySalt: SALT,
    systemIds: [1, 2],
    permissions: ['ingest'],
    enabled: true,
    expiresAt: null,
    rateLimit: 100,
    ...over,
  };
}

function makeReqRes(headers) {
  const req = { headers, originalUrl: '/api/ingest/principals', ip: '10.0.0.9' };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return { req, res };
}

async function run(headers = AUTH_HEADER) {
  const { req, res } = makeReqRes(headers);
  let nextCalled = false;
  await crawlerAuthMiddleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

beforeEach(() => {
  query.mockReset();
  // Default for follow-up queries (audit INSERT, lastUsedAt UPDATE).
  query.mockResolvedValue({ rows: [] });
});

describe('crawlerAuthMiddleware — header / lookup guards', () => {
  it('401s a missing Authorization header without touching the DB', async () => {
    const { res, nextCalled } = await run({});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or invalid API key' });
    expect(nextCalled).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('401s a non-fgc bearer token', async () => {
    const { res } = await run({ authorization: 'Bearer abc' });
    expect(res.statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('401s and audits an unknown key (crawlerId 0)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const { res, nextCalled } = await run();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid API key' });
    expect(nextCalled).toBe(false);
    const audit = query.mock.calls.find((c) => Array.isArray(c[1]) && c[1][1] === 'auth_failed');
    expect(audit[1][0]).toBe(0);
  });

  it('500s when the lookup query throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValueOnce(new Error('boom'));
    const { res } = await run();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Authentication service error' });
    errSpy.mockRestore();
  });
});

describe('crawlerAuthMiddleware — key verification', () => {
  it('rejects a legacy 32-byte hash before verifying', async () => {
    query.mockResolvedValueOnce({ rows: [crawlerRow({ apiKeyHash: Buffer.alloc(32) })] });
    const { res, nextCalled } = await run();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/must be rotated/);
    expect(nextCalled).toBe(false);
    const audit = query.mock.calls.find((c) => Array.isArray(c[1]) && c[1][1] === 'auth_legacy_hash');
    expect(audit).toBeTruthy();
  });

  it('401s when the key does not match the stored hash', async () => {
    query.mockResolvedValueOnce({ rows: [crawlerRow({ apiKeyHash: crypto.randomBytes(64) })] });
    const { res, nextCalled } = await run();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid API key' });
    expect(nextCalled).toBe(false);
  });
});

describe('crawlerAuthMiddleware — state guards', () => {
  it('403s a disabled crawler', async () => {
    query.mockResolvedValueOnce({ rows: [crawlerRow({ enabled: false })] });
    const { res } = await run();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Crawler is disabled' });
  });

  it('401s an expired key', async () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    query.mockResolvedValueOnce({ rows: [crawlerRow({ expiresAt })] });
    const { res } = await run();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'API key has expired' });
  });

  it('429s once the per-window rate limit is exceeded', async () => {
    const row = crawlerRow({ rateLimit: 1 });
    query.mockResolvedValueOnce({ rows: [row] });
    const first = await run();
    expect(first.nextCalled).toBe(true);

    query.mockResolvedValueOnce({ rows: [row] });
    const second = await run();
    expect(second.res.statusCode).toBe(429);
    expect(second.res.body).toEqual({ error: 'Rate limit exceeded' });
  });
});

describe('crawlerAuthMiddleware — success', () => {
  it('attaches req.crawler and calls next() for a valid key', async () => {
    query.mockResolvedValueOnce({ rows: [crawlerRow({ id: 900, systemIds: [7], permissions: ['ingest', 'admin'] })] });
    const { req, res, nextCalled } = await run();
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
    expect(req.crawler).toEqual({
      id: 900,
      displayName: 'Ext',
      systemIds: [7],
      permissions: ['ingest', 'admin'],
    });
  });

  it('defaults non-array systemIds/permissions on the attached crawler', async () => {
    query.mockResolvedValueOnce({ rows: [crawlerRow({ id: 901, systemIds: null, permissions: null })] });
    const { req, nextCalled } = await run();
    expect(nextCalled).toBe(true);
    expect(req.crawler.systemIds).toBeNull();
    expect(req.crawler.permissions).toEqual(['ingest']);
  });
});

describe('crawlerAuthMiddleware — SQL disabled', () => {
  it('503s when USE_SQL is not set', async () => {
    const prev = process.env.USE_SQL;
    delete process.env.USE_SQL;
    vi.resetModules();
    const mod = await import('./crawlerAuth.js');
    process.env.USE_SQL = prev;

    const { req, res } = makeReqRes(AUTH_HEADER);
    let nextCalled = false;
    await mod.crawlerAuthMiddleware(req, res, () => { nextCalled = true; });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'SQL not configured' });
    expect(nextCalled).toBe(false);
  });
});
