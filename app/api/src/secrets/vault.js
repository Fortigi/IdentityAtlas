// Identity Atlas v5 — secrets vault.
//
// Envelope encryption: each secret is encrypted with a per-row 256-bit data key,
// and the data key itself is encrypted by a master key from the
// `IDENTITY_ATLAS_MASTER_KEY` env var (32 bytes, base64-encoded).
//
// Why envelope encryption rather than encrypting the value directly with the
// master key:
//   - Per-row keys mean a single compromised secret doesn't expose the others.
//   - Master-key rotation only re-encrypts the small data keys, not all the
//     (potentially large) ciphertexts — see cli/rotate-master-key.js.
//   - The same shape works for an HSM or KMS later — only the master-key
//     wrapping function would change.
//
// AES-256-GCM is the algorithm for both layers. 12-byte IVs (GCM standard),
// 16-byte auth tags. Storing IV + auth tag + ciphertext as separate columns
// rather than a packed blob keeps the schema explicit and debuggable.
//
// Row binding (SEC-2026-09 L-04): both layers authenticate the row's scope and
// id as GCM additional data, so ciphertext copied onto another row (or a row
// whose scope was rewritten) fails authentication instead of decrypting. Rows
// written before this existed carry no AAD; they still decrypt through a legacy
// fallback and are re-encrypted with AAD by rebindLegacySecrets() at startup
// (or on their next write).
//
// Scope (SEC-2026-09 H-01): every read/existence/delete call names the scope
// it is allowed to touch, so a caller holding only an id from one feature
// (e.g. a scraper credential id) can never resolve a row that belongs to
// another (crawler credentials, the LLM key).
//
// If `IDENTITY_ATLAS_MASTER_KEY` is missing the vault refuses to operate at
// startup. The bootstrap module surfaces this as a clear error rather than
// silently writing plaintext.

import crypto from 'crypto';
import * as db from '../db/connection.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;

let cachedMasterKey = null;

// Decode + validate a base64 master key. Exported for the rotation CLI.
export function parseMasterKey(raw, envName = 'IDENTITY_ATLAS_MASTER_KEY') {
  const buf = Buffer.from(String(raw), 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(`${envName} must decode to ${KEY_LEN} bytes (got ${buf.length})`);
  }
  return buf;
}

function getMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;
  const raw = process.env.IDENTITY_ATLAS_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'IDENTITY_ATLAS_MASTER_KEY is not set. Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" " +
      'and add it to your docker-compose env or .env file.'
    );
  }
  cachedMasterKey = parseMasterKey(raw);
  return cachedMasterKey;
}

// Additional authenticated data for one envelope layer of one row. JSON keeps
// the components unambiguous (ids contain ':').
function aadFor(layer, scope, id) {
  return Buffer.from(JSON.stringify(['ia-vault/v1', layer, String(scope), String(id)]), 'utf8');
}

function gcmSeal(key, plain, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function gcmOpen(key, ciphertext, iv, authTag, aad) {
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Open one layer: row-bound first, then the pre-AAD legacy form. Throws when
// neither authenticates (wrong key, tampering, or a transplanted bound row).
function openLayer(key, ciphertext, iv, authTag, aad) {
  try {
    return { plain: gcmOpen(key, ciphertext, iv, authTag, aad), legacy: false };
  } catch {
    return { plain: gcmOpen(key, ciphertext, iv, authTag, null), legacy: true };
  }
}

// Encrypt a plaintext value with a fresh per-row data key, then wrap the data
// key with the master key. Returns the row shape ready for INSERT.
function encryptValue(plaintext, scope, id) {
  const dataKey = crypto.randomBytes(KEY_LEN);
  const data = gcmSeal(dataKey, Buffer.from(String(plaintext), 'utf8'), aadFor('data', scope, id));
  const wrapped = gcmSeal(getMasterKey(), dataKey, aadFor('key', scope, id));
  return {
    ciphertext: data.ciphertext,
    iv: data.iv,
    authTag: data.authTag,
    encryptedKey: wrapped.ciphertext,
    keyIv: wrapped.iv,
    keyAuthTag: wrapped.authTag,
  };
}

// Decrypt a row. `legacy` is true when either layer had no AAD binding.
function decryptRowDetailed(row, scope, id) {
  const key = openLayer(getMasterKey(), row.encryptedKey, row.keyIv, row.keyAuthTag, aadFor('key', scope, id));
  const data = openLayer(key.plain, row.ciphertext, row.iv, row.authTag, aadFor('data', scope, id));
  return { plaintext: data.plain.toString('utf8'), legacy: key.legacy || data.legacy };
}

function requireScope(scope) {
  if (typeof scope !== 'string' || !scope) {
    throw new Error('vault: a scope is required for this operation');
  }
}

const ROW_COLUMNS = `ciphertext, iv, "authTag", "encryptedKey", "keyIv", "keyAuthTag"`;

// Public API ──────────────────────────────────────────────────────────

// Set or replace a secret. id is caller-chosen and stable across updates.
export async function putSecret(id, scope, plaintext, label = null) {
  requireScope(scope);
  const enc = encryptValue(plaintext, scope, id);
  await db.query(
    `INSERT INTO "Secrets" (id, scope, label, ciphertext, iv, "authTag", "encryptedKey", "keyIv", "keyAuthTag", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (id) DO UPDATE SET
       scope        = EXCLUDED.scope,
       label        = EXCLUDED.label,
       ciphertext   = EXCLUDED.ciphertext,
       iv           = EXCLUDED.iv,
       "authTag"    = EXCLUDED."authTag",
       "encryptedKey" = EXCLUDED."encryptedKey",
       "keyIv"      = EXCLUDED."keyIv",
       "keyAuthTag" = EXCLUDED."keyAuthTag",
       "updatedAt"  = now()`,
    [id, scope, label, enc.ciphertext, enc.iv, enc.authTag, enc.encryptedKey, enc.keyIv, enc.keyAuthTag]
  );
}

// Read and decrypt a secret from the given scope. Returns null if there is no
// row with that id IN that scope.
export async function getSecret(id, scope) {
  requireScope(scope);
  const r = await db.queryOne(
    `SELECT ${ROW_COLUMNS} FROM "Secrets" WHERE id = $1 AND scope = $2`,
    [id, scope]
  );
  if (!r) return null;
  return decryptRowDetailed(r, scope, id).plaintext;
}

// Existence check (no decryption — useful for the UI to show "key set")
export async function hasSecret(id, scope) {
  requireScope(scope);
  const r = await db.queryOne(`SELECT 1 FROM "Secrets" WHERE id = $1 AND scope = $2`, [id, scope]);
  return !!r;
}

// Which of `ids` exist in `scope` — one round-trip. Returns a Set of ids.
export async function existingSecretIds(ids, scope) {
  requireScope(scope);
  if (!ids.length) return new Set();
  const r = await db.query(`SELECT id FROM "Secrets" WHERE id = ANY($1) AND scope = $2`, [ids, scope]);
  return new Set(r.rows.map(row => row.id));
}

// Delete a secret from the given scope. Returns true when a row was removed.
export async function deleteSecret(id, scope) {
  requireScope(scope);
  const r = await db.query(`DELETE FROM "Secrets" WHERE id = $1 AND scope = $2`, [id, scope]);
  return (r?.rowCount || 0) > 0;
}

// List secrets in a scope. Returns metadata only — never the plaintext.
export async function listSecrets(scope) {
  requireScope(scope);
  const r = await db.query(
    `SELECT id, scope, label, "createdAt", "updatedAt"
       FROM "Secrets" WHERE scope = $1 ORDER BY id`,
    [scope]
  );
  return r.rows;
}

// Idempotent startup pass: re-encrypt every row that still lacks AAD binding
// (written before L-04). Rows that fail to decrypt are left untouched and
// counted — they are reported by id only, never by value.
export async function rebindLegacySecrets() {
  const r = await db.query(`SELECT id, scope, label, ${ROW_COLUMNS} FROM "Secrets"`);
  let rebound = 0;
  let failed = 0;
  for (const row of r.rows) {
    try {
      const { plaintext, legacy } = decryptRowDetailed(row, row.scope, row.id);
      if (!legacy) continue;
      await putSecret(row.id, row.scope, plaintext, row.label);
      rebound++;
    } catch (err) {
      failed++;
      console.warn(`Vault: could not re-bind secret ${row.id}: ${err.message}`);
    }
  }
  if (rebound > 0) console.log(`Vault: bound ${rebound} legacy secret(s) to their rows`);
  return { rebound, failed };
}

// Re-wrap one row's data key from `fromKey` to `toKey` without touching the
// value ciphertext. Returns the new key columns, or null when the row is
// already wrapped (row-bound) by `toKey`. Throws when neither key opens it.
// Exported for cli/rotate-master-key.js; never returns or logs plaintext.
export function rewrapDataKey(row, fromKey, toKey) {
  const aad = aadFor('key', row.scope, row.id);
  let opened;
  try {
    opened = openLayer(toKey, row.encryptedKey, row.keyIv, row.keyAuthTag, aad);
    if (!opened.legacy) return null;
  } catch {
    opened = openLayer(fromKey, row.encryptedKey, row.keyIv, row.keyAuthTag, aad);
  }
  const wrapped = gcmSeal(toKey, opened.plain, aad);
  opened.plain.fill(0);
  return { encryptedKey: wrapped.ciphertext, keyIv: wrapped.iv, keyAuthTag: wrapped.authTag };
}

// Test that the master key is configured correctly. Called from bootstrap.
// Returns true if a round-trip encrypt/decrypt succeeds.
export function selfTest() {
  try {
    getMasterKey();
    const row = encryptValue('selftest', 'selftest', 'selftest');
    return decryptRowDetailed(row, 'selftest', 'selftest').plaintext === 'selftest';
  } catch (err) {
    console.error('Vault self-test failed:', err.message);
    return false;
  }
}

// Test-only: the pure crypto helpers, so the AAD / legacy paths can be proven
// without a database.
export const _internal = {
  encryptValue,
  decryptRowDetailed,
  gcmSeal,
  resetMasterKeyCache: () => { cachedMasterKey = null; },
};
