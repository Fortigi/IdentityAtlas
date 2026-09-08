// Unit tests for auth/shareTokens.js — the `fgs_` share-link token (#1166).

import { describe, it, expect } from 'vitest';
import { generateShareToken, hashToken, isShareTokenFormat, SHARE_TOKEN_PREFIX } from './shareTokens.js';
import { generateToken as generateReadToken } from './readTokens.js';

describe('generateShareToken', () => {
  it('mints a prefixed, url-safe token with 32 bytes of entropy', () => {
    const token = generateShareToken();
    expect(token.startsWith(SHARE_TOKEN_PREFIX)).toBe(true);
    // 32 random bytes → 43 base64url characters, no padding or '+/'.
    expect(token.slice(SHARE_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateShareToken()));
    expect(tokens.size).toBe(50);
  });

  it('is distinguishable from a read API key, which is a credential', () => {
    // A share token authorizes nothing; an fgr_ token does. Confusing the two
    // in middleware would be a privilege bug, so the prefixes must not collide.
    expect(isShareTokenFormat(generateReadToken())).toBe(false);
    expect(generateReadToken().startsWith(SHARE_TOKEN_PREFIX)).toBe(false);
  });
});

describe('hashToken', () => {
  it('is a stable SHA-256 hex digest of the plaintext', () => {
    const token = generateShareToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateShareToken()));
    // Two tokens differing in one character must not collide, and the digest
    // must not simply echo the input back.
    expect(hashToken('fgs_aaaa')).not.toBe(hashToken('fgs_aaab'));
    expect(hashToken(token)).not.toBe(token);
  });
});

describe('isShareTokenFormat', () => {
  it('accepts a minted token', () => {
    expect(isShareTokenFormat(generateShareToken())).toBe(true);
  });

  it('rejects the bare prefix, other token families and non-strings', () => {
    expect(isShareTokenFormat('fgs_')).toBe(false);           // prefix with no entropy
    expect(isShareTokenFormat('fgc_abcdef')).toBe(false);     // crawler key
    expect(isShareTokenFormat('afgs_abcdef')).toBe(false);    // prefix not at the start
    expect(isShareTokenFormat('')).toBe(false);
    expect(isShareTokenFormat(null)).toBe(false);
    expect(isShareTokenFormat(undefined)).toBe(false);
    expect(isShareTokenFormat(12345)).toBe(false);
    expect(isShareTokenFormat({ toString: () => 'fgs_x' })).toBe(false);
  });
});
