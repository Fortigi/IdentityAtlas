// Unit tests for cli/rotate-master-key.js (SEC-2026-09 L-05). pg is mocked with
// an in-memory Secrets table; the real vault crypto is used end-to-end, so the
// test proves a rotated row decrypts under the NEW key with the value
// ciphertext untouched, and that nothing is written when a row is unreadable.

process.env.USE_SQL = 'true'; // auth-config.js (reused for withClient) exits otherwise

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const h = vi.hoisted(() => ({ rows: [], statements: [] }));

vi.mock('pg', () => {
  const client = {
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      h.statements.push(sql.trim().split(/\s+/)[0]);
      if (sql.startsWith('SELECT')) return { rows: h.rows.map(r => ({ ...r })) };
      if (sql.startsWith('UPDATE')) {
        h.pending.set(params[3], { encryptedKey: params[0], keyIv: params[1], keyAuthTag: params[2] });
        return { rowCount: 1 };
      }
      if (sql === 'BEGIN') h.pending = new Map();
      if (sql === 'COMMIT') {
        for (const r of h.rows) Object.assign(r, h.pending.get(r.id) || {});
      }
      return { rows: [] };
    },
  };
  return { default: { Client: function Client() { return client; } } };
});

const OLD = crypto.randomBytes(32);
const NEW = crypto.randomBytes(32);
process.env.IDENTITY_ATLAS_MASTER_KEY = OLD.toString('base64');

const vault = await import('../secrets/vault.js');
const cli = await import('./rotate-master-key.js');

function rowUnder(key, id, scope, value) {
  vault._internal.resetMasterKeyCache();
  process.env.IDENTITY_ATLAS_MASTER_KEY = key.toString('base64');
  return { id, scope, ...vault._internal.encryptValue(value, scope, id) };
}

function decryptUnder(key, row) {
  vault._internal.resetMasterKeyCache();
  process.env.IDENTITY_ATLAS_MASTER_KEY = key.toString('base64');
  return vault._internal.decryptRowDetailed(row, row.scope, row.id).plaintext;
}

const env = { IDENTITY_ATLAS_MASTER_KEY_PREVIOUS: OLD.toString('base64'), IDENTITY_ATLAS_MASTER_KEY: NEW.toString('base64') };
let logSpy;

beforeEach(() => {
  h.rows = [];
  h.statements = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe('loadRotationKeys', () => {
  it('returns both decoded keys', () => {
    const k = cli.loadRotationKeys(env);
    expect(k.previousKey.equals(OLD)).toBe(true);
    expect(k.currentKey.equals(NEW)).toBe(true);
  });

  it.each([
    [{ IDENTITY_ATLAS_MASTER_KEY: env.IDENTITY_ATLAS_MASTER_KEY }, 'IDENTITY_ATLAS_MASTER_KEY_PREVIOUS must be set'],
    [{ IDENTITY_ATLAS_MASTER_KEY_PREVIOUS: env.IDENTITY_ATLAS_MASTER_KEY_PREVIOUS }, 'IDENTITY_ATLAS_MASTER_KEY must be set'],
    [{ ...env, IDENTITY_ATLAS_MASTER_KEY_PREVIOUS: 'c2hvcnQ=' }, 'IDENTITY_ATLAS_MASTER_KEY_PREVIOUS must decode to 32 bytes'],
    [{ ...env, IDENTITY_ATLAS_MASTER_KEY_PREVIOUS: env.IDENTITY_ATLAS_MASTER_KEY }, 'are the same key'],
  ])('rejects %o', (e, msg) => {
    expect(() => cli.loadRotationKeys(e)).toThrow(msg);
  });
});

describe('main — rotation', () => {
  it('re-wraps every row so it decrypts under the new key, leaving value ciphertext untouched', async () => {
    h.rows = [
      rowUnder(OLD, 'crawler-config:1:clientSecret', 'crawler-config', 'entra-secret'),
      rowUnder(OLD, 'llm.apikey', 'llm', 'provider-key'),
    ];
    const valueCiphertextBefore = h.rows.map(r => Buffer.from(r.ciphertext));

    const code = await cli.main([], env);

    expect(code).toBe(0);
    expect(h.statements).toContain('COMMIT');
    expect(h.rows.map(r => r.ciphertext)).toEqual(valueCiphertextBefore);
    expect(decryptUnder(NEW, h.rows[0])).toBe('entra-secret');
    expect(decryptUnder(NEW, h.rows[1])).toBe('provider-key');
    expect(() => decryptUnder(OLD, h.rows[0])).toThrow();
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('re-wrapped to the new key: 2');
    expect(out).not.toContain('entra-secret');
    expect(out).not.toContain('provider-key');
  });

  it('is a no-op on a second run (rows already on the new key are skipped)', async () => {
    h.rows = [rowUnder(NEW, 'llm.apikey', 'llm', 'provider-key')];
    const before = Buffer.from(h.rows[0].encryptedKey);
    expect(await cli.main([], env)).toBe(0);
    expect(h.rows[0].encryptedKey.equals(before)).toBe(true);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('already on the new key:    1');
  });

  it('--dry-run rolls back', async () => {
    h.rows = [rowUnder(OLD, 'llm.apikey', 'llm', 'provider-key')];
    const before = Buffer.from(h.rows[0].encryptedKey);
    expect(await cli.main(['--dry-run'], env)).toBe(0);
    expect(h.statements).toContain('ROLLBACK');
    expect(h.statements).not.toContain('COMMIT');
    expect(h.rows[0].encryptedKey.equals(before)).toBe(true);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Dry run');
  });

  it('writes nothing and exits 1 when a row opens with neither key', async () => {
    h.rows = [
      rowUnder(OLD, 'llm.apikey', 'llm', 'provider-key'),
      rowUnder(crypto.randomBytes(32), 'scraper.x', 'scraper', 'other'),
    ];
    const before = Buffer.from(h.rows[0].encryptedKey);
    expect(await cli.main([], env)).toBe(1);
    expect(h.statements).toContain('ROLLBACK');
    expect(h.rows[0].encryptedKey.equals(before)).toBe(true);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Unreadable row ids: scraper.x');
  });
});

describe('rotateMasterKey — failure mid-transaction', () => {
  it('rolls back and rethrows when a statement fails', async () => {
    const statements = [];
    const client = {
      query: async (sql) => {
        statements.push(sql.split(/\s+/)[0]);
        if (sql.startsWith('SELECT')) throw new Error('db gone');
        return { rows: [] };
      },
    };
    await expect(cli.rotateMasterKey(client, { previousKey: OLD, currentKey: NEW })).rejects.toThrow('db gone');
    expect(statements).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
  });
});
