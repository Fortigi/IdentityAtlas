// Identity Atlas v5 — secrets vault.
//
// Envelope encryption: each secret is encrypted with a per-row 256-bit data key,
// and the data key itself is encrypted by a master key from the
// `IDENTITY_ATLAS_MASTER_KEY` env var (32 bytes, base64-encoded).
//
// Why envelope encryption rather than encrypting the value directly with the
// master key:
//   - Per-row keys mean a single compromised secret doesn't expose the others.
//   - Future master-key rotation only re-encrypts the small data keys, not all
//     the (potentially large) ciphertexts.
//   - The same shape works for an HSM or KMS later — only the master-key
//     wrapping function would change.
//
// AES-256-GCM is the algorithm for both layers. 12-byte IVs (GCM standard),
// 16-byte auth tags. Storing IV + auth tag + ciphertext as separate columns
// rather than a packed blob keeps the schema explicit and debuggable.
//
// If `IDENTITY_ATLAS_MASTER_KEY` is missing the vault refuses to operate at
// startup. The bootstrap module surfaces this as a clear error rather than
// silently writing plaintext.

import crypto from 'crypto';
import * as db from '../db/connection.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;

let cachedMasterKey = null;

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
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('IDENTITY_ATLAS_MASTER_KEY must be valid base64');
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(`IDENTITY_ATLAS_MASTER_KEY must decode to ${KEY_LEN} bytes (got ${buf.length})`);
  }
  cachedMasterKey = buf;
  return buf;
}

// Encrypt a buffer with the master key. Returns {ciphertext, iv, authTag}.
function wrapWithMaster(plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: ct, iv, authTag };
}

function unwrapWithMaster(ciphertext, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Encrypt a plaintext value with a fresh per-row data key, then wrap the data
// key with the master key. Returns the row shape ready for INSERT.
function encryptValue(plaintext) {
  const dataKey = crypto.randomBytes(KEY_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, dataKey, iv);
  const plainBuf = Buffer.from(String(plaintext), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Wrap the data key with the master key
  const wrapped = wrapWithMaster(dataKey);

  return {
    ciphertext,
    iv,
    authTag,
    encryptedKey: wrapped.ciphertext,
    keyIv: wrapped.iv,
    keyAuthTag: wrapped.authTag,
  };
}

function decryptRow(row) {
  const dataKey = unwrapWithMaster(row.encryptedKey, row.keyIv, row.keyAuthTag);
  const decipher = crypto.createDecipheriv(ALGO, dataKey, row.iv);
  decipher.setAuthTag(row.authTag);
  const plain = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

// Public API ──────────────────────────────────────────────────────────

// Set or replace a secret. id is caller-chosen and stable across updates.
export async function putSecret(id, scope, plaintext, label = null) {
  const enc = encryptValue(plaintext);
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

// Read and decrypt a secret. Returns null if not found.
export async function getSecret(id) {
  const r = await db.queryOne(
    `SELECT ciphertext, iv, "authTag", "encryptedKey", "keyIv", "keyAuthTag"
       FROM "Secrets" WHERE id = $1`,
    [id]
  );
  if (!r) return null;
  return decryptRow(r);
}

// Existence check (no decryption — useful for the UI to show "key set")
export async function hasSecret(id) {
  const r = await db.queryOne(`SELECT 1 FROM "Secrets" WHERE id = $1`, [id]);
  return !!r;
}

export async function deleteSecret(id) {
  await db.query(`DELETE FROM "Secrets" WHERE id = $1`, [id]);
}

// List secrets in a scope. Returns metadata only — never the plaintext.
export async function listSecrets(scope) {
  const r = await db.query(
    `SELECT id, scope, label, "createdAt", "updatedAt"
       FROM "Secrets" WHERE scope = $1 ORDER BY id`,
    [scope]
  );
  return r.rows;
}

// Test that the master key is configured correctly. Called from bootstrap.
// Returns true if a round-trip encrypt/decrypt succeeds.
export function selfTest() {
  try {
    getMasterKey();
    const { ciphertext, iv, authTag, encryptedKey, keyIv, keyAuthTag } = encryptValue('selftest');
    const out = decryptRow({ ciphertext, iv, authTag, encryptedKey, keyIv, keyAuthTag });
    return out === 'selftest';
  } catch (err) {
    console.error('Vault self-test failed:', err.message);
    return false;
  }
}
