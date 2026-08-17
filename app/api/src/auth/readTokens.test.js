// Unit tests for the read-only API token primitives.
//
// This module is a credential path: `findActiveByPlaintext` is what the auth
// middleware calls on every request carrying an `fgr_` bearer, and it is the
// only thing standing between a revoked/expired token and the read API. Every
// branch that can return a row instead of null is therefore pinned explicitly —
// a wrong `&&` here is an authentication bypass, not a cosmetic bug.
//
// The DB is the shared manual mock (src/db/__mocks__/connection.js) rather than
// an inline factory, per app/api/CLAUDE.md. It is SQL-blind — it returns
// scripted recordsets without reading the SQL — so these tests pin behaviour and
// the *parameters* we bind, never SQL validity. Schema correctness stays with
// contract-tests/readTokenIdleRevoke.contract.test.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import {
  hashToken, generateToken, isReadTokenFormat,
  createToken, listTokens, revokeToken, revokeIdleTokens, findActiveByPlaintext,
} from './readTokens.js';

beforeEach(() => {
  query.mockReset();
});

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

describe('createToken', () => {
  it('persists only the hash + display prefix, never the plaintext', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7, name: 'excel' }] });

    const { token, row } = await createToken({ name: 'excel', createdBy: 'ops@example.test' });

    const [sql, params] = query.mock.calls[0];
    const [name, tokenHash, tokenPrefix, createdBy, expiresAt] = params;
    expect(name).toBe('excel');
    expect(tokenHash).toBe(hashToken(token));
    // The bound parameters must not contain the plaintext anywhere.
    expect(params).not.toContain(token);
    expect(sql).not.toContain(token);
    // Prefix is a display-only leading slice (12 chars: 'fgr_' + 8).
    expect(tokenPrefix).toBe(token.slice(0, 12));
    expect(tokenPrefix).toHaveLength(12);
    expect(token.startsWith(tokenPrefix)).toBe(true);
    expect(createdBy).toBe('ops@example.test');
    expect(expiresAt).toBeNull();
    expect(row).toEqual({ id: 7, name: 'excel' });
  });

  it('binds NULL for an omitted createdBy / expiresAt', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 8 }] });
    await createToken({ name: 'anon' });
    const [, params] = query.mock.calls[0];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('passes an explicit expiresAt straight through', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 9 }] });
    const when = '2030-01-01T00:00:00Z';
    await createToken({ name: 'expiring', createdBy: 'ops', expiresAt: when });
    expect(query.mock.calls[0][1][4]).toBe(when);
  });

  it('mints a distinct token on each call', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    const a = await createToken({ name: 'a' });
    const b = await createToken({ name: 'b' });
    expect(a.token).not.toBe(b.token);
  });
});

describe('listTokens', () => {
  it('returns the recordset rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    expect(await listTokens()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('returns an empty list when no tokens exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await listTokens()).toEqual([]);
  });
});

describe('revokeToken', () => {
  it('returns true when a row was updated', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3 }] });
    expect(await revokeToken(3)).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([3]);
  });

  it('returns false when the id matched nothing', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await revokeToken(999)).toBe(false);
  });
});

describe('revokeIdleTokens', () => {
  // The disable-guard is the branch that matters: a wrong comparison here would
  // silently mass-revoke every live token the first time the sweep runs.
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['a non-numeric string', 'thirty'],
  ])('is disabled for %s and issues no query', async (_label, idleDays) => {
    expect(await revokeIdleTokens(idleDays)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('revokes and returns the idle rows for a positive idleDays', async () => {
    const revoked = [{ id: 1, name: 'stale', tokenPrefix: 'fgr_abcd1234' }];
    query.mockResolvedValueOnce({ rows: revoked });

    expect(await revokeIdleTokens(30)).toEqual(revoked);
    expect(query.mock.calls[0][1]).toEqual([30]);
  });

  it('uses the injected client instead of the shared pool when given one', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 2 }] }) };
    expect(await revokeIdleTokens(7, client)).toEqual([{ id: 2 }]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('findActiveByPlaintext', () => {
  const PLAINTEXT = 'fgr_live-token';

  // Stage the lookup SELECT, then a resolved UPDATE for the fire-and-forget
  // lastUsedAt touch (the module calls .catch() on it, so it must be a promise).
  function stageLookup(rows, { touch = Promise.resolve({ rows: [] }) } = {}) {
    query.mockResolvedValueOnce({ rows }).mockReturnValueOnce(touch);
  }

  it('looks the token up by hash, never by plaintext', async () => {
    stageLookup([]);
    await findActiveByPlaintext(PLAINTEXT);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([hashToken(PLAINTEXT)]);
    expect(params).not.toContain(PLAINTEXT);
    expect(sql).toContain('tokenHash');
  });

  it('returns null when no row matches', async () => {
    stageLookup([]);
    expect(await findActiveByPlaintext(PLAINTEXT)).toBeNull();
    // No lastUsedAt touch for a miss.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns null for a revoked token', async () => {
    stageLookup([{ id: 1, name: 't', revoked: true, expiresAt: null }]);
    expect(await findActiveByPlaintext(PLAINTEXT)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns null for an expired token', async () => {
    stageLookup([{ id: 1, name: 't', revoked: false, expiresAt: '2000-01-01T00:00:00Z' }]);
    expect(await findActiveByPlaintext(PLAINTEXT)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns a token with no expiry', async () => {
    const row = { id: 1, name: 't', revoked: false, expiresAt: null };
    stageLookup([row]);
    expect(await findActiveByPlaintext(PLAINTEXT)).toEqual(row);
  });

  it('returns a token whose expiry is still in the future', async () => {
    const row = { id: 1, name: 't', revoked: false, expiresAt: '2999-01-01T00:00:00Z' };
    stageLookup([row]);
    expect(await findActiveByPlaintext(PLAINTEXT)).toEqual(row);
  });

  it('revoked wins over a still-valid expiry', async () => {
    stageLookup([{ id: 1, name: 't', revoked: true, expiresAt: '2999-01-01T00:00:00Z' }]);
    expect(await findActiveByPlaintext(PLAINTEXT)).toBeNull();
  });

  it('touches lastUsedAt for the matched id without awaiting it', async () => {
    stageLookup([{ id: 42, name: 't', revoked: false, expiresAt: null }]);
    await findActiveByPlaintext(PLAINTEXT);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('lastUsedAt');
    expect(params).toEqual([42]);
  });

  it('treats a token expiring at exactly this instant as still valid', async () => {
    // The comparison is `expiresAt < now`, so the expiry instant itself is
    // inclusive — a token is valid up to and including it. Pinned with fake
    // timers because the boundary is otherwise unreachable: without this, the
    // only surviving mutant in this file was `<` -> `<=`, which flips a token
    // from valid to rejected on its exact expiry millisecond.
    vi.useFakeTimers();
    try {
      const now = new Date('2030-06-01T12:00:00.000Z');
      vi.setSystemTime(now);
      const row = { id: 1, name: 't', revoked: false, expiresAt: now.toISOString() };
      query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
      expect(await findActiveByPlaintext(PLAINTEXT)).toEqual(row);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a token that expired one millisecond ago', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2030-06-01T12:00:00.000Z');
      vi.setSystemTime(now);
      const expired = new Date(now.getTime() - 1).toISOString();
      query.mockResolvedValueOnce({ rows: [{ id: 1, name: 't', revoked: false, expiresAt: expired }] });
      expect(await findActiveByPlaintext(PLAINTEXT)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still authenticates when the lastUsedAt write fails', async () => {
    const row = { id: 42, name: 't', revoked: false, expiresAt: null };
    stageLookup([row], { touch: Promise.reject(new Error('write failed')) });
    // The rejection is swallowed by the module's .catch() — if it were not,
    // this would surface as an unhandled rejection and fail the run.
    await expect(findActiveByPlaintext(PLAINTEXT)).resolves.toEqual(row);
  });
});
