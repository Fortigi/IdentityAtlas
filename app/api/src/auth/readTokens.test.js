// Unit tests for the read-only API token primitives.
//
// Lookup paths that hit the DB (createToken / findActiveByPlaintext) are
// covered indirectly by the live smoke tests in test/nightly. Here we only
// pin the pure helpers — the bits that decide whether a bearer string
// counts as a read token, and that hashing is deterministic. A regression
// in either is a security regression: the middleware would either accept
// the wrong shape of credential or fail to look one up.

import { describe, it, expect, vi } from 'vitest';

// The module imports `../db/connection.js` — the lookup tests don't need a
// real DB so we mock it to a no-op pool. The pure helpers (hashToken,
// generateToken, isReadTokenFormat) don't actually call db at module load,
// only later, so the mock keeps the import chain happy.
vi.mock('../db/connection.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

const { hashToken, generateToken, isReadTokenFormat } = await import('./readTokens.js');

describe('hashToken', () => {
  it('returns a deterministic 64-char hex SHA-256', () => {
    const a = hashToken('fgr_some-token-value');
    const b = hashToken('fgr_some-token-value');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different inputs', () => {
    expect(hashToken('fgr_a')).not.toBe(hashToken('fgr_b'));
  });
});

describe('generateToken', () => {
  it('returns a token starting with the fgr_ prefix', () => {
    expect(generateToken()).toMatch(/^fgr_/);
  });

  it('produces a high-entropy suffix (43+ url-safe base64 chars from 32 bytes)', () => {
    const tok = generateToken();
    const suffix = tok.slice('fgr_'.length);
    // 32 random bytes encode to 43 url-safe base64 chars (no padding).
    expect(suffix.length).toBeGreaterThanOrEqual(43);
    expect(suffix).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not collide on rapid successive calls (sanity check on randomness)', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(generateToken());
    expect(seen.size).toBe(1000);
  });
});

describe('isReadTokenFormat', () => {
  it('accepts strings that begin with fgr_', () => {
    expect(isReadTokenFormat('fgr_anything')).toBe(true);
  });

  it('rejects crawler-format tokens (fgc_)', () => {
    expect(isReadTokenFormat('fgc_anything')).toBe(false);
  });

  it('rejects JWTs (heuristically: anything not starting with fgr_)', () => {
    expect(isReadTokenFormat('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...')).toBe(false);
  });

  it('rejects non-strings (defensive — middleware passes header.split() output)', () => {
    expect(isReadTokenFormat(undefined)).toBe(false);
    expect(isReadTokenFormat(null)).toBe(false);
    expect(isReadTokenFormat(42)).toBe(false);
  });
});
