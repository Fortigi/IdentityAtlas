// Where the secrets-vault master key lives, and how it is loaded (SEC-2026-09 M-08).
//
// Resolution order:
//   1. IDENTITY_ATLAS_MASTER_KEY — env var (or IDENTITY_ATLAS_MASTER_KEY_FILE, see
//      config/fileSecrets.js). Preferred: the operator controls and backs it up.
//   2. A key file:
//        MASTER_KEY_FILE                        explicit path (unchanged), else
//        $IDENTITY_ATLAS_KEY_DIR/.master-key    a web-only volume, else
//        /data/uploads/.master-key              the legacy location
//   3. First boot: generate a key and persist it to the file from step 2.
//
// Why the key moves: /data/uploads is the `job_data` volume that the worker
// container also mounts, so a compromise of the worker exposed the key that
// decrypts every vaulted credential. The Compose file now mounts a web-only
// volume and sets IDENTITY_ATLAS_KEY_DIR. The variable is opt-in on purpose:
// without it (an older compose file, which has no such volume) the directory
// would be container-local and the key would be lost on the next recreate, so
// the legacy location stays in use.
//
// Upgrade path: when IDENTITY_ATLAS_KEY_DIR is set and only the legacy file
// exists, the key is copied to the new location, the copy is read back and
// compared, the key is checked against a stored secret, and only then is the
// legacy file removed. Any failure leaves the legacy file in place.
//
// Safety net: a new key is never generated while the vault already holds
// encrypted secrets — that would silently make them unreadable (for example
// after rolling back to a compose file that does not mount the key volume).

import crypto from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, posix } from 'path';
import * as db from '../db/connection.js';
import { getSecret, selfTest as vaultSelfTest } from './vault.js';

export const LEGACY_MASTER_KEY_FILE = '/data/uploads/.master-key';
const KEY_FILENAME = '.master-key';

// → { primary, legacy } — `legacy` is set only when a relocation is possible.
export function resolveMasterKeyPaths(env = process.env, legacyFile = LEGACY_MASTER_KEY_FILE) {
  if (env.MASTER_KEY_FILE) return { primary: env.MASTER_KEY_FILE, legacy: null };
  if (env.IDENTITY_ATLAS_KEY_DIR) {
    const primary = posix.join(env.IDENTITY_ATLAS_KEY_DIR, KEY_FILENAME);
    return { primary, legacy: primary === legacyFile ? null : legacyFile };
  }
  return { primary: legacyFile, legacy: null };
}

// Read a key file. Returns the key, or null when the file does not exist.
export function readKeyFile(path, fs = { readFileSync }) {
  let key;
  try {
    key = fs.readFileSync(path, 'utf8').trim();
  } catch (err) {
    // ENOTDIR: a path component is not a directory, so the file cannot exist either.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Error(
      `Master key file exists at ${path} but could not be read: ${err.message}. ` +
      'This usually means the file is owned by a different user than the web container. ' +
      'Fix with: docker compose exec -u 0 web chown -R node:node /data'
    );
  }
  if (!key) throw new Error(`Master key file ${path} is empty. Delete it and restart the web container to regenerate.`);
  return key;
}

async function countStoredSecrets() {
  const row = await db.queryOne(`SELECT count(*)::int AS n FROM "Secrets"`);
  return row ? Number(row.n) : 0;
}

// True when the current master key decrypts a stored secret (or none exist).
async function verifyStoredSecret() {
  const row = await db.queryOne(`SELECT id, scope FROM "Secrets" ORDER BY id LIMIT 1`);
  if (!row) return true;
  try {
    await getSecret(row.id, row.scope);
    return true;
  } catch {
    return false;
  }
}

function defaultDeps() {
  return {
    env: process.env,
    legacyFile: LEGACY_MASTER_KEY_FILE,
    fs: { readFileSync, writeFileSync, mkdirSync, unlinkSync },
    selfTest: vaultSelfTest,
    countStoredSecrets,
    verifyStoredSecret,
    log: console,
  };
}

function useKey(d, key, what) {
  d.env.IDENTITY_ATLAS_MASTER_KEY = key;
  if (!d.selfTest()) throw new Error(`Secrets vault self-test failed — ${what}`);
}

// Ensure IDENTITY_ATLAS_MASTER_KEY holds a usable key. Returns a short status:
// 'env' | 'file' | 'relocated' | 'legacy' | 'generated' | 'refused'.
export async function ensureMasterKey(deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (d.env.IDENTITY_ATLAS_MASTER_KEY) {
    useKey(d, d.env.IDENTITY_ATLAS_MASTER_KEY, 'check IDENTITY_ATLAS_MASTER_KEY');
    return 'env';
  }
  const { primary, legacy } = resolveMasterKeyPaths(d.env, d.legacyFile);
  const key = readKeyFile(primary, d.fs);
  if (key !== null) {
    useKey(d, key, 'master key file is corrupt');
    d.log.log(`Master key loaded from ${primary}`);
    if (legacy) removeLeftoverLegacy(d, key, legacy);
    return 'file';
  }
  const legacyKey = legacy ? readKeyFile(legacy, d.fs) : null;
  if (legacyKey !== null) {
    useKey(d, legacyKey, 'master key file is corrupt');
    d.log.log(`Master key loaded from ${legacy}`);
    return relocateLegacyKey(d, legacyKey, primary, legacy);
  }
  return generateKey(d, primary);
}

// A previous relocation copied the key but stopped before removing the legacy
// file. Remove it only when it is byte-identical to the key in use.
function removeLeftoverLegacy(d, key, legacy) {
  const legacyKey = readKeyFile(legacy, d.fs);
  if (legacyKey === null) return;
  if (legacyKey !== key) {
    d.log.warn(`A different master key file still exists at ${legacy}; it is not used and was left in place. Remove it once you have confirmed it is not needed.`);
    return;
  }
  if (tryUnlink(d, legacy)) d.log.log(`Removed leftover master key copy at ${legacy}`);
}

function tryUnlink(d, path) {
  try {
    d.fs.unlinkSync(path);
    return true;
  } catch (err) {
    d.log.warn(`Could not remove ${path}: ${err.message}`);
    return false;
  }
}

async function relocateLegacyKey(d, key, primary, legacy) {
  const keep = (reason) => {
    d.log.warn(`Master key stays at ${legacy} (shared with the worker): ${reason}`);
    return 'legacy';
  };
  try {
    d.fs.mkdirSync(dirname(primary), { recursive: true, mode: 0o700 });
    d.fs.writeFileSync(primary, key, { mode: 0o600, encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    return keep(`could not write ${primary}: ${err.message}`);
  }
  let copy = null;
  try { copy = readKeyFile(primary, d.fs); } catch { /* treated as a mismatch */ }
  if (copy !== key) {
    tryUnlink(d, primary);
    return keep(`the copy at ${primary} did not read back identically`);
  }
  if (!(await d.verifyStoredSecret())) {
    tryUnlink(d, primary);
    return keep('the key does not decrypt the stored secrets, so it was not moved');
  }
  if (!tryUnlink(d, legacy)) return 'file';
  d.log.log(`Master key moved from ${legacy} to ${primary}`);
  return 'relocated';
}

async function generateKey(d, primary) {
  const stored = await d.countStoredSecrets();
  if (stored > 0 && d.env.IDENTITY_ATLAS_ALLOW_NEW_MASTER_KEY !== 'true') {
    d.log.error(
      `No master key found (checked IDENTITY_ATLAS_MASTER_KEY and ${primary}), but the vault holds ${stored} ` +
      'encrypted secret(s). A new key was NOT generated because it could not decrypt them. Restore the key ' +
      '(set IDENTITY_ATLAS_MASTER_KEY, or put the key file back) and restart. To discard the stored secrets ' +
      'and start with a new key, set IDENTITY_ATLAS_ALLOW_NEW_MASTER_KEY=true.'
    );
    return 'refused';
  }
  const key = crypto.randomBytes(32).toString('base64');
  try {
    d.fs.mkdirSync(dirname(primary), { recursive: true, mode: 0o700 });
    d.fs.writeFileSync(primary, key, { mode: 0o600, encoding: 'utf8' });
  } catch (err) {
    // Can't persist → refuse to continue. Running with an ephemeral key would
    // silently lose all secrets on the next container restart.
    throw new Error(
      `Could not persist master key to ${primary}: ${err.message}. ` +
      'Set IDENTITY_ATLAS_MASTER_KEY explicitly in the compose env, or fix the volume permissions.'
    );
  }
  useKey(d, key, 'after key generation');
  d.log.log(`Master key generated and persisted to ${primary}`);
  d.log.log('For production, prefer setting IDENTITY_ATLAS_MASTER_KEY explicitly so the key can be backed up.');
  return 'generated';
}
