import { describe, it, expect } from 'vitest';
import { authCacheKey } from './crawlerAuth.js';

// The auth cache keys by a SHA-256 of the apiKey so the plaintext crawler key is
// never retained in the in-memory Map (a heap-dump exposure).
describe('authCacheKey', () => {
  it('does not retain the plaintext apiKey — it hashes it', () => {
    const key = authCacheKey('crawler-1', 'fgc_supersecret');
    expect(key).not.toContain('fgc_supersecret');
    expect(key).toMatch(/^crawler-1:[0-9a-f]{64}$/); // "<crawlerId>:<sha256 hex>"
  });

  it('is stable for the same inputs but changes on key rotation', () => {
    expect(authCacheKey('c', 'k1')).toBe(authCacheKey('c', 'k1'));
    expect(authCacheKey('c', 'k1')).not.toBe(authCacheKey('c', 'k2'));
  });

  it('is scoped by crawlerId', () => {
    expect(authCacheKey('a', 'k')).not.toBe(authCacheKey('b', 'k'));
  });
});
