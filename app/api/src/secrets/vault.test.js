// Unit tests for the secrets vault.
//
// The database is replaced by a tiny in-memory "Secrets" table that honours
// the id + scope predicates the vault sends, so these tests prove:
//   - scope isolation on read / exists / delete (SEC-2026-09 H-01)
//   - row binding via GCM AAD, the legacy (pre-AAD) decrypt fallback, and the
//     idempotent re-bind pass (SEC-2026-09 L-04)
//   - master-key re-wrapping for the rotation CLI (SEC-2026-09 L-05)
// Real SQL correctness stays with the contract tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

const MASTER = crypto.randomBytes(32);
process.env.IDENTITY_ATLAS_MASTER_KEY = MASTER.toString('base64');

const h = vi.hoisted(() => ({ rows: new Map() }));

vi.mock('../db/connection.js', () => {
  const COLS = ['ciphertext', 'iv', 'authTag', 'encryptedKey', 'keyIv', 'keyAuthTag'];
  const query = async (sql, params = []) => {
    if (sql.startsWith('INSERT INTO "Secrets"')) {
      const [id, scope, label, ...enc] = params;
      h.rows.set(id, { id, scope, label, ...Object.fromEntries(COLS.map((c, i) => [c, enc[i]])) });
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('DELETE FROM "Secrets"')) {
      const row = h.rows.get(params[0]);
      if (!row || row.scope !== params[1]) return { rowCount: 0, rows: [] };
      h.rows.delete(params[0]);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('id = ANY($1)')) {
      return { rows: [...h.rows.values()].filter(r => params[0].includes(r.id) && r.scope === params[1]) };
    }
    if (sql.includes('WHERE scope = $1')) {
      return { rows: [...h.rows.values()].filter(r => r.scope === params[0]) };
    }
    return { rows: [...h.rows.values()] }; // full-table scan (rebind)
  };
  const queryOne = async (sql, params = []) => {
    const row = h.rows.get(params[0]);
    return row && row.scope === params[1] ? row : null;
  };
  return { query, queryOne, default: { query, queryOne } };
});

const vault = await import('./vault.js');

// The row format written before L-04: identical envelope, no AAD on either layer.
function legacyEncrypt(plaintext, masterKey = MASTER) {
  const seal = (key, plain) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return { ct, iv, tag: c.getAuthTag() };
  };
  const dataKey = crypto.randomBytes(32);
  const data = seal(dataKey, Buffer.from(plaintext, 'utf8'));
  const key = seal(masterKey, dataKey);
  return { ciphertext: data.ct, iv: data.iv, authTag: data.tag, encryptedKey: key.ct, keyIv: key.iv, keyAuthTag: key.tag };
}

function plantRow(id, scope, enc, label = null) {
  h.rows.set(id, { id, scope, label, ...enc });
}

beforeEach(() => h.rows.clear());

describe('vault selfTest', () => {
  it('passes the round-trip self-test with a valid master key', () => {
    expect(vault.selfTest()).toBe(true);
  });
});

describe('parseMasterKey', () => {
  it('accepts a 32-byte base64 key and rejects any other length', () => {
    expect(vault.parseMasterKey(MASTER.toString('base64')).equals(MASTER)).toBe(true);
    expect(() => vault.parseMasterKey(crypto.randomBytes(31).toString('base64'), 'X_KEY'))
      .toThrow('X_KEY must decode to 32 bytes (got 31)');
  });
});

describe('scope isolation (H-01)', () => {
  beforeEach(async () => {
    await vault.putSecret('crawler-config:1:clientSecret', 'crawler-config', 'entra-secret');
  });

  it('reads a secret only through its own scope', async () => {
    expect(await vault.getSecret('crawler-config:1:clientSecret', 'crawler-config')).toBe('entra-secret');
    expect(await vault.getSecret('crawler-config:1:clientSecret', 'scraper')).toBeNull();
  });

  it('reports existence only through its own scope', async () => {
    expect(await vault.hasSecret('crawler-config:1:clientSecret', 'crawler-config')).toBe(true);
    expect(await vault.hasSecret('crawler-config:1:clientSecret', 'scraper')).toBe(false);
  });

  it('deletes only through its own scope and says whether a row went', async () => {
    expect(await vault.deleteSecret('crawler-config:1:clientSecret', 'scraper')).toBe(false);
    expect(h.rows.has('crawler-config:1:clientSecret')).toBe(true);
    expect(await vault.deleteSecret('crawler-config:1:clientSecret', 'crawler-config')).toBe(true);
    expect(h.rows.has('crawler-config:1:clientSecret')).toBe(false);
  });

  it('existingSecretIds filters by scope in one call', async () => {
    await vault.putSecret('crawler-config:1:password', 'crawler-config', 'p');
    await vault.putSecret('scraper.1', 'scraper', 's');
    const ids = await vault.existingSecretIds(['crawler-config:1:password', 'scraper.1', 'crawler-config:1:apiToken'], 'crawler-config');
    expect([...ids]).toEqual(['crawler-config:1:password']);
    expect((await vault.existingSecretIds([], 'crawler-config')).size).toBe(0);
  });

  it.each([
    ['getSecret', () => vault.getSecret('llm.apikey')],
    ['hasSecret', () => vault.hasSecret('llm.apikey', '')],
    ['deleteSecret', () => vault.deleteSecret('llm.apikey')],
    ['putSecret', () => vault.putSecret('llm.apikey', undefined, 'x')],
    ['listSecrets', () => vault.listSecrets()],
    ['existingSecretIds', () => vault.existingSecretIds(['a'])],
  ])('%s refuses to run without a scope', async (_name, call) => {
    await expect(call()).rejects.toThrow('a scope is required');
  });

  it('listSecrets returns metadata for one scope only', async () => {
    await vault.putSecret('scraper.1', 'scraper', 'value', 'Label');
    const list = await vault.listSecrets('scraper');
    expect(list.map(r => r.id)).toEqual(['scraper.1']);
  });
});

describe('row binding (L-04)', () => {
  it('a bound row copied onto another id does not decrypt', async () => {
    await vault.putSecret('llm.apikey', 'llm', 'provider-key');
    const { id: _id, scope: _scope, label: _label, ...enc } = h.rows.get('llm.apikey');
    plantRow('crawler-job:5:credentials', 'crawler-job', enc);
    await expect(vault.getSecret('crawler-job:5:credentials', 'crawler-job')).rejects.toThrow();
  });

  it('a bound row whose scope was rewritten does not decrypt', async () => {
    await vault.putSecret('scraper.x', 'crawler-config', 'secret');
    h.rows.get('scraper.x').scope = 'scraper';
    await expect(vault.getSecret('scraper.x', 'scraper')).rejects.toThrow();
  });

  it('new writes are bound: the value does not open without AAD', async () => {
    await vault.putSecret('llm.apikey', 'llm', 'provider-key');
    const row = h.rows.get('llm.apikey');
    const { legacy } = vault._internal.decryptRowDetailed(row, 'llm', 'llm.apikey');
    expect(legacy).toBe(false);
  });

  it('a legacy (pre-AAD) row still decrypts', async () => {
    plantRow('crawler-config:3:clientSecret', 'crawler-config', legacyEncrypt('old-secret'));
    expect(await vault.getSecret('crawler-config:3:clientSecret', 'crawler-config')).toBe('old-secret');
    const { legacy } = vault._internal.decryptRowDetailed(h.rows.get('crawler-config:3:clientSecret'), 'crawler-config', 'crawler-config:3:clientSecret');
    expect(legacy).toBe(true);
  });

  it('a row that authenticates under neither form throws', async () => {
    const enc = legacyEncrypt('x');
    enc.ciphertext = Buffer.from(enc.ciphertext.map(b => b ^ 0xff));
    plantRow('llm.apikey', 'llm', enc);
    await expect(vault.getSecret('llm.apikey', 'llm')).rejects.toThrow();
  });

  it('rebindLegacySecrets re-encrypts only legacy rows, keeps scope + label, and is idempotent', async () => {
    plantRow('crawler-config:3:clientSecret', 'crawler-config', legacyEncrypt('old-secret'), 'Crawler config 3');
    await vault.putSecret('llm.apikey', 'llm', 'already-bound');
    const boundBefore = h.rows.get('llm.apikey').ciphertext;
    const broken = legacyEncrypt('x');
    broken.authTag = Buffer.alloc(16);
    plantRow('scraper.broken', 'scraper', broken);

    const first = await vault.rebindLegacySecrets();
    expect(first).toEqual({ rebound: 1, failed: 1 });
    const rebound = h.rows.get('crawler-config:3:clientSecret');
    expect(rebound.scope).toBe('crawler-config');
    expect(rebound.label).toBe('Crawler config 3');
    expect(vault._internal.decryptRowDetailed(rebound, 'crawler-config', rebound.id)).toEqual({ plaintext: 'old-secret', legacy: false });
    expect(h.rows.get('llm.apikey').ciphertext.equals(boundBefore)).toBe(true);

    expect(await vault.rebindLegacySecrets()).toEqual({ rebound: 0, failed: 1 });
  });
});

describe('rewrapDataKey (L-05)', () => {
  const NEW = crypto.randomBytes(32);

  it('moves a row from the previous key to the new key without changing the value ciphertext', async () => {
    await vault.putSecret('crawler-config:1:clientSecret', 'crawler-config', 'entra-secret');
    const row = { ...h.rows.get('crawler-config:1:clientSecret') };
    const cols = vault.rewrapDataKey(row, MASTER, NEW);
    expect(cols).not.toBeNull();
    // The value ciphertext is untouched; only the key columns change, and the
    // new key (not the old one) now opens the data key with row binding.
    const rewrapped = { ...row, ...cols };
    expect(() => vault.rewrapDataKey(rewrapped, crypto.randomBytes(32), NEW)).not.toThrow();
    expect(vault.rewrapDataKey(rewrapped, crypto.randomBytes(32), NEW)).toBeNull();
    expect(() => vault.rewrapDataKey(rewrapped, MASTER, crypto.randomBytes(32))).toThrow();
  });

  it('binds a legacy data key while re-wrapping it', () => {
    const row = { id: 'llm.apikey', scope: 'llm', ...legacyEncrypt('k', MASTER) };
    const cols = vault.rewrapDataKey(row, MASTER, NEW);
    // Already under NEW? No — so it came from MASTER; now it must be bound under NEW.
    expect(vault.rewrapDataKey({ ...row, ...cols }, MASTER, NEW)).toBeNull();
  });

  it('upgrades a legacy row that is already under the new key', () => {
    const row = { id: 'llm.apikey', scope: 'llm', ...legacyEncrypt('k', NEW) };
    const cols = vault.rewrapDataKey(row, MASTER, NEW);
    expect(cols).not.toBeNull();
    expect(vault.rewrapDataKey({ ...row, ...cols }, MASTER, NEW)).toBeNull();
  });

  it('throws when neither key opens the row', () => {
    const row = { id: 'llm.apikey', scope: 'llm', ...legacyEncrypt('k', crypto.randomBytes(32)) };
    expect(() => vault.rewrapDataKey(row, MASTER, NEW)).toThrow();
  });
});
