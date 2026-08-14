// Unit tests for the pure helpers behind crawlerAuthMiddleware.
// These have no DB / crypto / module-state dependencies, so they run bare.

import { describe, it, expect } from 'vitest';
import {
  DENIAL,
  parseBearerKey,
  legacyHashDenial,
  enabledDenial,
  expiryDenial,
  effectiveRateLimit,
} from './crawlerAuth.helpers.js';

describe('parseBearerKey', () => {
  it('returns null for a missing header', () => {
    expect(parseBearerKey(undefined)).toBeNull();
    expect(parseBearerKey('')).toBeNull();
  });

  it('returns null for a non-fgc bearer or wrong scheme', () => {
    expect(parseBearerKey('Bearer abc123')).toBeNull();
    expect(parseBearerKey('Basic fgc_abcdefgh')).toBeNull();
  });

  it('extracts the key and its 8-char prefix from a valid header', () => {
    expect(parseBearerKey('Bearer fgc_ABCDwxyz1234')).toEqual({
      apiKey: 'fgc_ABCDwxyz1234',
      prefix: 'fgc_ABCD',
    });
  });
});

describe('legacyHashDenial', () => {
  it('flags a 32-byte (legacy SHA-256) hash for rotation', () => {
    expect(legacyHashDenial(Buffer.alloc(32))).toBe(DENIAL.legacyHash);
  });

  it('passes a modern (64-byte scrypt) hash', () => {
    expect(legacyHashDenial(Buffer.alloc(64))).toBeNull();
  });

  it('passes when there is no stored hash', () => {
    expect(legacyHashDenial(null)).toBeNull();
    expect(legacyHashDenial(undefined)).toBeNull();
  });
});

describe('enabledDenial', () => {
  it('passes an enabled crawler', () => {
    expect(enabledDenial(true)).toBeNull();
  });

  it('denies a disabled crawler', () => {
    expect(enabledDenial(false)).toBe(DENIAL.disabled);
  });
});

describe('expiryDenial', () => {
  it('passes when there is no expiry', () => {
    expect(expiryDenial(null)).toBeNull();
  });

  it('passes a future expiry', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(expiryDenial(future)).toBeNull();
  });

  it('denies a past expiry', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(expiryDenial(past)).toBe(DENIAL.expired);
  });
});

describe('effectiveRateLimit', () => {
  it('defaults to 100 when no limit is configured', () => {
    expect(effectiveRateLimit(0, 'Ext')).toBe(100);
    expect(effectiveRateLimit(undefined, 'Ext')).toBe(100);
  });

  it('keeps an external crawler configured limit', () => {
    expect(effectiveRateLimit(250, 'Ext')).toBe(250);
  });

  it('floors the built-in worker at 2000', () => {
    expect(effectiveRateLimit(100, 'Built-in Worker')).toBe(2000);
    expect(effectiveRateLimit(undefined, 'Built-in Worker')).toBe(2000);
  });

  it('lets the built-in worker exceed the floor', () => {
    expect(effectiveRateLimit(5000, 'Built-in Worker')).toBe(5000);
  });
});
