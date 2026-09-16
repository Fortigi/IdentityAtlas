// Master key location + upgrade relocation (SEC-2026-09 M-08).
//
// Uses a real temp directory for the key files so the copy / read-back / remove
// sequence is exercised against the filesystem, not a mock of it. The vault
// self-test is replaced by a strict decoder (a 32-byte base64 key passes, anything
// else fails) so a test can tell a loaded key from a garbage one.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs, { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../db/connection.js');
vi.mock('./vault.js', () => ({ getSecret: vi.fn(), selfTest: vi.fn(() => true) }));

import { queryOne } from '../db/connection.js';
import { getSecret } from './vault.js';
import {
  ensureMasterKey, resolveMasterKeyPaths, readKeyFile, LEGACY_MASTER_KEY_FILE,
} from './masterKeyStore.js';

const newKey = () => crypto.randomBytes(32).toString('base64');
const strictSelfTest = (env) => () => {
  try { return Buffer.from(env.IDENTITY_ATLAS_MASTER_KEY, 'base64').length === 32; } catch { return false; }
};

let root, legacyFile, keyDir, primaryFile, env, log;

function deps(extra = {}) {
  return {
    env,
    legacyFile,
    selfTest: strictSelfTest(env),
    countStoredSecrets: async () => 0,
    verifyStoredSecret: async () => true,
    log,
    ...extra,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iakey-'));
  mkdirSync(join(root, 'uploads'));
  legacyFile = join(root, 'uploads', '.master-key');
  keyDir = join(root, 'volumes', 'keys');
  primaryFile = posix.join(keyDir, '.master-key');
  env = {};
  log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  queryOne.mockReset();
  getSecret.mockReset();
});

describe('resolveMasterKeyPaths', () => {
  it('uses the legacy shared-volume path when nothing is configured (older compose files)', () => {
    expect(resolveMasterKeyPaths({})).toEqual({ primary: LEGACY_MASTER_KEY_FILE, legacy: null });
    expect(LEGACY_MASTER_KEY_FILE).toBe('/data/uploads/.master-key');
  });

  it('puts the key in IDENTITY_ATLAS_KEY_DIR and offers the legacy file for relocation', () => {
    expect(resolveMasterKeyPaths({ IDENTITY_ATLAS_KEY_DIR: '/data/keys' }))
      .toEqual({ primary: '/data/keys/.master-key', legacy: '/data/uploads/.master-key' });
  });

  it('does not relocate onto itself when the key dir is the legacy directory', () => {
    expect(resolveMasterKeyPaths({ IDENTITY_ATLAS_KEY_DIR: '/data/uploads' }))
      .toEqual({ primary: '/data/uploads/.master-key', legacy: null });
  });

  it('an explicit MASTER_KEY_FILE wins over the key dir and never relocates', () => {
    expect(resolveMasterKeyPaths({ MASTER_KEY_FILE: '/srv/k', IDENTITY_ATLAS_KEY_DIR: '/data/keys' }))
      .toEqual({ primary: '/srv/k', legacy: null });
  });
});

describe('readKeyFile', () => {
  it('returns null for a missing file and the trimmed key for a present one', () => {
    expect(readKeyFile(join(root, 'nope'))).toBeNull();
    writeFileSync(legacyFile, '  abc\n');
    expect(readKeyFile(legacyFile)).toBe('abc');
  });

  it('treats a path under a non-directory as a missing file (Linux reports ENOTDIR)', () => {
    const notDir = { readFileSync: () => { const e = new Error('ENOTDIR: not a directory'); e.code = 'ENOTDIR'; throw e; } };
    expect(readKeyFile(legacyFile, notDir)).toBeNull();
  });

  it('refuses an empty file', () => {
    writeFileSync(legacyFile, '\n');
    expect(() => readKeyFile(legacyFile)).toThrow(/is empty/);
  });

  it('explains an unreadable file instead of treating it as missing', () => {
    const denied = { readFileSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } };
    expect(() => readKeyFile(legacyFile, denied)).toThrow(/could not be read.*chown/s);
  });
});

describe('ensureMasterKey — existing deployments', () => {
  it('keeps using an explicit IDENTITY_ATLAS_MASTER_KEY and touches no file', async () => {
    const key = newKey();
    env.IDENTITY_ATLAS_MASTER_KEY = key;
    env.IDENTITY_ATLAS_KEY_DIR = keyDir;
    writeFileSync(legacyFile, newKey());
    expect(await ensureMasterKey(deps())).toBe('env');
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBe(key);
    expect(existsSync(legacyFile)).toBe(true);
    expect(existsSync(primaryFile)).toBe(false);
  });

  it('throws when the explicit key fails the vault self-test', async () => {
    env.IDENTITY_ATLAS_MASTER_KEY = 'not-a-32-byte-key';
    await expect(ensureMasterKey(deps())).rejects.toThrow(/self-test failed — check IDENTITY_ATLAS_MASTER_KEY/);
  });

  it('old compose file (no key dir): reads the legacy file and leaves it where it is', async () => {
    const key = newKey();
    writeFileSync(legacyFile, key);
    expect(await ensureMasterKey(deps())).toBe('file');
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBe(key);
    expect(readFileSync(legacyFile, 'utf8')).toBe(key);
    expect(log.log.mock.calls).toEqual([[`Master key loaded from ${legacyFile}`]]);
  });

  it('a corrupt key file fails the self-test loudly', async () => {
    writeFileSync(legacyFile, 'garbage');
    await expect(ensureMasterKey(deps())).rejects.toThrow(/master key file is corrupt/);
  });
});

describe('ensureMasterKey — relocation to the web-only key dir', () => {
  beforeEach(() => { env.IDENTITY_ATLAS_KEY_DIR = keyDir; });

  it('copies the legacy key, verifies it, then removes the legacy file', async () => {
    const key = newKey();
    writeFileSync(legacyFile, key);
    const verify = vi.fn(async () => env.IDENTITY_ATLAS_MASTER_KEY === key);
    expect(await ensureMasterKey(deps({ verifyStoredSecret: verify }))).toBe('relocated');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(readFileSync(primaryFile, 'utf8')).toBe(key);
    expect(existsSync(legacyFile)).toBe(false);
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBe(key);
    expect(log.log.mock.calls).toEqual([
      [`Master key loaded from ${legacyFile}`],
      [`Master key moved from ${legacyFile} to ${primaryFile}`],
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps the legacy file (and discards the copy) when the key does not decrypt stored secrets', async () => {
    const key = newKey();
    writeFileSync(legacyFile, key);
    expect(await ensureMasterKey(deps({ verifyStoredSecret: async () => false }))).toBe('legacy');
    expect(readFileSync(legacyFile, 'utf8')).toBe(key);
    expect(existsSync(primaryFile)).toBe(false);
    expect(log.warn.mock.calls).toEqual([[
      `Master key stays at ${legacyFile} (shared with the worker): the key does not decrypt the stored secrets, so it was not moved`,
    ]]);
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBe(key);
  });

  it('keeps the legacy file when the new location cannot be written', async () => {
    const key = newKey();
    writeFileSync(legacyFile, key);
    mkdirSync(join(root, 'volumes'));
    writeFileSync(keyDir, 'a file where the directory should be');
    expect(await ensureMasterKey(deps())).toBe('legacy');
    expect(readFileSync(legacyFile, 'utf8')).toBe(key);
    expect(log.warn.mock.calls[0][0]).toMatch(/could not write/);
  });

  it('keeps the legacy file when the copy does not read back identically', async () => {
    const key = newKey();
    writeFileSync(legacyFile, key);
    let copied = false;
    const lyingFs = {
      ...fs,
      writeFileSync: (p, ...rest) => { copied = copied || p === primaryFile; return fs.writeFileSync(p, ...rest); },
      readFileSync: (p, enc) => (copied && p === primaryFile ? 'truncated' : fs.readFileSync(p, enc)),
    };
    expect(await ensureMasterKey(deps({ fs: lyingFs }))).toBe('legacy');
    expect(readFileSync(legacyFile, 'utf8')).toBe(key);
    expect(existsSync(primaryFile)).toBe(false);
    expect(log.warn.mock.calls[0][0]).toMatch(/did not read back identically$/);
  });

  it('keeps working from the new copy when the legacy file cannot be removed', async () => {
    const key = newKey();
    writeFileSync(legacyFile, key);
    const stickyFs = {
      ...fs,
      unlinkSync: (p) => { if (p === legacyFile) throw new Error('EBUSY'); return fs.unlinkSync(p); },
    };
    expect(await ensureMasterKey(deps({ fs: stickyFs }))).toBe('file');
    expect(readFileSync(primaryFile, 'utf8')).toBe(key);
    expect(existsSync(legacyFile)).toBe(true);
    expect(log.warn.mock.calls).toEqual([[`Could not remove ${legacyFile}: EBUSY`]]);
    expect(log.log.mock.calls.flat().join('\n')).not.toMatch(/moved/);
  });

  it('removes a leftover legacy copy identical to the relocated key', async () => {
    const key = newKey();
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(primaryFile, key);
    writeFileSync(legacyFile, key);
    expect(await ensureMasterKey(deps())).toBe('file');
    expect(existsSync(legacyFile)).toBe(false);
    expect(log.log.mock.calls).toEqual([
      [`Master key loaded from ${primaryFile}`],
      [`Removed leftover master key copy at ${legacyFile}`],
    ]);
  });

  it('never removes a legacy file that holds a DIFFERENT key', async () => {
    const key = newKey();
    const other = newKey();
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(primaryFile, key);
    writeFileSync(legacyFile, other);
    expect(await ensureMasterKey(deps())).toBe('file');
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBe(key);
    expect(readFileSync(legacyFile, 'utf8')).toBe(other);
    expect(log.warn.mock.calls).toEqual([[
      `A different master key file still exists at ${legacyFile}; it is not used and was left in place. Remove it once you have confirmed it is not needed.`,
    ]]);
  });
});

describe('ensureMasterKey — first boot', () => {
  it('generates a 32-byte key into the key dir', async () => {
    env.IDENTITY_ATLAS_KEY_DIR = keyDir;
    expect(await ensureMasterKey(deps())).toBe('generated');
    const written = readFileSync(primaryFile, 'utf8');
    expect(Buffer.from(written, 'base64')).toHaveLength(32);
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBe(written);
    expect(existsSync(legacyFile)).toBe(false);
    expect(log.log.mock.calls).toEqual([
      [`Master key generated and persisted to ${primaryFile}`],
      ['For production, prefer setting IDENTITY_ATLAS_MASTER_KEY explicitly so the key can be backed up.'],
    ]);
  });

  it('refuses to generate a key while encrypted secrets exist, leaving no file behind', async () => {
    env.IDENTITY_ATLAS_KEY_DIR = keyDir;
    expect(await ensureMasterKey(deps({ countStoredSecrets: async () => 3 }))).toBe('refused');
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBeUndefined();
    expect(existsSync(primaryFile)).toBe(false);
    expect(log.error.mock.calls[0][0]).toMatch(/holds 3 encrypted secret/);
  });

  it('generates anyway when the operator explicitly allows a new key', async () => {
    env.IDENTITY_ATLAS_ALLOW_NEW_MASTER_KEY = 'true';
    expect(await ensureMasterKey(deps({ countStoredSecrets: async () => 3 }))).toBe('generated');
    expect(existsSync(legacyFile)).toBe(true);
  });

  it('fails loudly when a freshly generated key does not pass the vault self-test', async () => {
    await expect(ensureMasterKey(deps({ selfTest: () => false }))).rejects.toThrow(/self-test failed — after key generation/);
  });

  it('refuses to run with an ephemeral key when the file cannot be persisted', async () => {
    env.IDENTITY_ATLAS_KEY_DIR = keyDir;
    mkdirSync(join(root, 'volumes'));
    writeFileSync(keyDir, 'blocks mkdir');
    await expect(ensureMasterKey(deps())).rejects.toThrow(/^Could not persist master key to .*Set IDENTITY_ATLAS_MASTER_KEY explicitly/s);
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBeUndefined();
  });
});

describe('ensureMasterKey — default database checks', () => {
  const baseDeps = () => ({ env, legacyFile, selfTest: strictSelfTest(env), log });

  it('counts stored secrets from the Secrets table before generating', async () => {
    queryOne.mockResolvedValueOnce({ n: 2 });
    expect(await ensureMasterKey(baseDeps())).toBe('refused');
    expect(String(queryOne.mock.calls[0][0])).toMatch(/count\(\*\).*FROM "Secrets"/s);
  });

  it('treats a missing count row as an empty vault', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await ensureMasterKey(baseDeps())).toBe('generated');
  });

  it('verifies relocation by decrypting a stored secret', async () => {
    env.IDENTITY_ATLAS_KEY_DIR = keyDir;
    writeFileSync(legacyFile, newKey());
    queryOne.mockResolvedValueOnce({ id: 'llm.apikey', scope: 'llm' });
    getSecret.mockRejectedValueOnce(new Error('Unsupported state or unable to authenticate data'));
    expect(await ensureMasterKey(baseDeps())).toBe('legacy');
    // The vault refuses a read that does not name its scope (SEC-2026-09 L-04).
    expect(getSecret).toHaveBeenCalledWith('llm.apikey', 'llm');
    expect(existsSync(legacyFile)).toBe(true);
  });

  it('relocates when a stored secret decrypts, or when the vault is empty', async () => {
    env.IDENTITY_ATLAS_KEY_DIR = keyDir;
    writeFileSync(legacyFile, newKey());
    queryOne.mockResolvedValueOnce({ id: 'llm.apikey', scope: 'llm' });
    getSecret.mockResolvedValueOnce('plaintext');
    expect(await ensureMasterKey(baseDeps())).toBe('relocated');

    // second deployment, empty vault
    const second = mkdtempSync(join(tmpdir(), 'iakey-'));
    legacyFile = join(second, '.master-key');
    env = { IDENTITY_ATLAS_KEY_DIR: join(second, 'keys') };
    writeFileSync(legacyFile, newKey());
    queryOne.mockResolvedValueOnce(null);
    expect(await ensureMasterKey(baseDeps())).toBe('relocated');
  });
});
