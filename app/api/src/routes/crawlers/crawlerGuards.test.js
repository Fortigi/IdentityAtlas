// Pure unit tests for the admin crawler guards (SEC-2026-09 M-06). No database,
// no filesystem, no Express app — so this file also runs inside Stryker's
// sandbox (see stryker.auth.config.json). The route-level behaviour is pinned
// in routes/crawlers.test.js.
import { describe, it, expect, vi } from 'vitest';
import {
  ASSIGNABLE_CRAWLER_PERMISSIONS, validateCrawlerPermissions, touchesProtectedBuiltinField,
  respondBuiltinOrNotFound, BUILTIN_PROTECTED_ERROR,
} from './crawlerGuards.js';

describe('validateCrawlerPermissions', () => {
  it('only ingest and refreshViews are assignable', () => {
    expect(ASSIGNABLE_CRAWLER_PERMISSIONS).toEqual(['ingest', 'refreshViews']);
  });

  it('passes an absent value through as undefined (field not sent)', () => {
    expect(validateCrawlerPermissions(undefined)).toEqual({ permissions: undefined });
  });

  it('accepts each assignable permission and de-duplicates, keeping first-seen order', () => {
    expect(validateCrawlerPermissions(['ingest'])).toEqual({ permissions: ['ingest'] });
    expect(validateCrawlerPermissions(['refreshViews'])).toEqual({ permissions: ['refreshViews'] });
    expect(validateCrawlerPermissions(['refreshViews', 'ingest', 'refreshViews'])).toEqual({ permissions: ['refreshViews', 'ingest'] });
  });

  it('accepts exactly 10 entries and rejects 11', () => {
    expect(validateCrawlerPermissions(Array(10).fill('ingest'))).toEqual({ permissions: ['ingest'] });
    expect(validateCrawlerPermissions(Array(11).fill('ingest')).error).toBeDefined();
  });

  it.each([
    ['the worker permission', ['admin']],
    ['a mix containing admin', ['ingest', 'admin']],
    ['an empty array', []],
    ['a bare string', 'ingest'],
    ['null', null],
    ['a non-string entry', ['ingest', 1]],
    ['a differently-cased name', ['Ingest']],
  ])('rejects %s', (_label, value) => {
    expect(validateCrawlerPermissions(value)).toEqual({
      error: 'permissions must be a non-empty array of: ingest, refreshViews',
    });
  });
});

describe('touchesProtectedBuiltinField', () => {
  it.each(['displayName', 'enabled', 'systemIds', 'permissions', 'expiresAt'])('%s is protected', (field) => {
    expect(touchesProtectedBuiltinField({ [field]: null })).toBe(true);
    expect(touchesProtectedBuiltinField({ description: 'd', [field]: false })).toBe(true);
  });

  it('description and rateLimit are not protected', () => {
    expect(touchesProtectedBuiltinField({ description: 'd', rateLimit: 5 })).toBe(false);
  });

  it('ignores fields that are undefined or not crawler fields', () => {
    expect(touchesProtectedBuiltinField({ displayName: undefined, isBuiltIn: false, other: 1 })).toBe(false);
    expect(touchesProtectedBuiltinField(undefined)).toBe(false);
  });
});

describe('respondBuiltinOrNotFound', () => {
  const makeRes = () => ({
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  });

  it('403 with the protected message for the built-in row', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ isBuiltIn: true }] }) };
    const res = makeRes();
    await respondBuiltinOrNotFound(pool, 4, res);
    expect(pool.query).toHaveBeenCalledWith('SELECT "isBuiltIn" FROM "Crawlers" WHERE id = $1', [4]);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: BUILTIN_PROTECTED_ERROR });
    expect(BUILTIN_PROTECTED_ERROR).toMatch(/built-in worker/);
  });

  it.each([[[{ isBuiltIn: false }]], [[]]])('404 for an ordinary or missing row (%j)', async (rows) => {
    const res = makeRes();
    await respondBuiltinOrNotFound({ query: vi.fn().mockResolvedValue({ rows }) }, 4, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Crawler not found' });
  });
});
