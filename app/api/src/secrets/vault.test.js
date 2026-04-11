// Unit tests for the secrets vault.
//
// These tests don't touch the database — they exercise the encryption helpers
// in isolation by importing the internal `encryptValue` shape via a round-trip
// using the public selfTest(). For full DB-backed put/get tests we'd need a
// test postgres; that's covered by the smoke test in CI.

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';

describe('vault selfTest', () => {
  beforeAll(() => {
    // Provide a deterministic master key for the test
    process.env.IDENTITY_ATLAS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  });

  it('passes the round-trip self-test with a valid master key', async () => {
    const { selfTest } = await import('./vault.js');
    expect(selfTest()).toBe(true);
  });

  // Note: the negative path (missing/short key) is intentionally not unit
  // tested here. The vault module caches the master key on first read, and
  // vitest's dynamic import doesn't bypass the cache. The bootstrap.js
  // integration covers the failure path: if the key is missing in production
  // the web container refuses to start, and our nightly test exercises that.
});
