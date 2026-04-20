// Read-only API tokens (`fgr_…`) used by downstream tooling — chiefly the
// generated Excel Power Query workbook — to refresh the read API on
// auth-enabled deployments without an interactive sign-in.
//
// Storage: only the SHA-256 hash of the plaintext is kept in `ReadApiKeys`.
// We can use plain SHA-256 (no salt) because the plaintext is 32 random
// bytes of url-safe base64 — there's no dictionary to attack with rainbow
// tables, and a per-row salt would just complicate lookup without buying
// security against an attacker who already has the database.
//
// Plaintext is shown to the operator exactly once at creation; subsequent
// listings only show the prefix and a hash-of-the-prefix-style display.

import crypto from 'crypto';
import * as db from '../db/connection.js';

const TOKEN_PREFIX = 'fgr_';
const TOKEN_RANDOM_BYTES = 32;
const PREFIX_DISPLAY_LEN = 12; // length of leading characters stored for display

export function hashToken(plaintext) {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// Generate a new plaintext token. The caller is responsible for showing it to
// the operator exactly once and persisting only the hash + display prefix.
export function generateToken() {
  const random = crypto.randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
  return `${TOKEN_PREFIX}${random}`;
}

// Return true if the bearer token looks like a read-API token. Cheap check
// to skip the JWT path quickly when called from the auth middleware.
export function isReadTokenFormat(bearer) {
  return typeof bearer === 'string' && bearer.startsWith(TOKEN_PREFIX);
}

// Insert a new read token. Returns the row + plaintext (for one-time display).
export async function createToken({ name, createdBy, expiresAt }) {
  const plaintext = generateToken();
  const tokenHash = hashToken(plaintext);
  const tokenPrefix = plaintext.slice(0, PREFIX_DISPLAY_LEN);
  const r = await db.query(
    `INSERT INTO "ReadApiKeys" ("name", "tokenHash", "tokenPrefix", "createdBy", "expiresAt")
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, "tokenPrefix", "createdAt", "createdBy", "expiresAt", "lastUsedAt", revoked`,
    [name, tokenHash, tokenPrefix, createdBy || null, expiresAt || null]
  );
  return { token: plaintext, row: r.rows[0] };
}

export async function listTokens() {
  const r = await db.query(
    `SELECT id, name, "tokenPrefix", "createdAt", "createdBy", "expiresAt", "lastUsedAt", revoked
       FROM "ReadApiKeys"
      ORDER BY "createdAt" DESC`
  );
  return r.rows;
}

export async function revokeToken(id) {
  const r = await db.query(
    `UPDATE "ReadApiKeys" SET revoked = TRUE WHERE id = $1 RETURNING id`,
    [id]
  );
  return r.rowCount > 0;
}

// Look up an active token by its plaintext value (called by authMiddleware on
// every request that uses an `fgr_` bearer). Returns the row or null. Also
// updates lastUsedAt fire-and-forget — we don't await it because we don't want
// auth latency to depend on a write.
export async function findActiveByPlaintext(plaintext) {
  const tokenHash = hashToken(plaintext);
  const r = await db.query(
    `SELECT id, name, "expiresAt", revoked
       FROM "ReadApiKeys"
      WHERE "tokenHash" = $1`,
    [tokenHash]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (row.revoked) return null;
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;

  db.query(`UPDATE "ReadApiKeys" SET "lastUsedAt" = now() WHERE id = $1`, [row.id]).catch(() => {});
  return row;
}
