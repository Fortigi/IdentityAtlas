#!/usr/bin/env node
//
// Master-key rotation CLI for the secrets vault (SEC-2026-09 L-05).
//
// Every vault row stores its value encrypted with a per-row data key, and that
// data key encrypted ("wrapped") with the master key. Rotating the master key
// therefore only re-wraps the small `encryptedKey` column of each row — the
// value ciphertext is never decrypted, and no plaintext secret is ever printed.
//
// Keys come from the environment only (never argv, which lands in shell
// history and process listings):
//   IDENTITY_ATLAS_MASTER_KEY_PREVIOUS  the key the vault is encrypted with now
//   IDENTITY_ATLAS_MASTER_KEY           the new key (32 bytes, base64)
//
// Usage (see docs/architecture/llm-and-risk-scoring.md → Master key rotation):
//   node /app/backend/src/cli/rotate-master-key.js [--dry-run]
//
// All rows are re-wrapped in one transaction. If any row opens with neither
// key, nothing is changed and the unreadable row ids are listed. Re-running
// after a successful rotation is a no-op (rows already under the new key are
// skipped).

import { fileURLToPath } from 'url';
import { parseArgs, withClient } from './auth-config.js';
import { parseMasterKey, rewrapDataKey } from '../secrets/vault.js';

const PREVIOUS_ENV = 'IDENTITY_ATLAS_MASTER_KEY_PREVIOUS';
const CURRENT_ENV = 'IDENTITY_ATLAS_MASTER_KEY';

// Read + validate both keys from an env object. Throws a user-facing message.
export function loadRotationKeys(env) {
  if (!env[PREVIOUS_ENV]) throw new Error(`${PREVIOUS_ENV} must be set to the key the vault is currently encrypted with`);
  if (!env[CURRENT_ENV]) throw new Error(`${CURRENT_ENV} must be set to the new master key`);
  const previousKey = parseMasterKey(env[PREVIOUS_ENV], PREVIOUS_ENV);
  const currentKey = parseMasterKey(env[CURRENT_ENV], CURRENT_ENV);
  if (previousKey.equals(currentKey)) throw new Error(`${PREVIOUS_ENV} and ${CURRENT_ENV} are the same key`);
  return { previousKey, currentKey };
}

// Re-wrap every row in one transaction. Commits only when every row opened and
// this is not a dry run. Returns counts + the ids of rows neither key opens.
export async function rotateMasterKey(client, { previousKey, currentKey, dryRun = false }) {
  const summary = { total: 0, rewrapped: 0, alreadyCurrent: 0, failedIds: [] };
  await client.query('BEGIN');
  try {
    const r = await client.query(
      `SELECT id, scope, "encryptedKey", "keyIv", "keyAuthTag" FROM "Secrets" ORDER BY id FOR UPDATE`
    );
    summary.total = r.rows.length;
    for (const row of r.rows) {
      let cols;
      try {
        cols = rewrapDataKey(row, previousKey, currentKey);
      } catch {
        summary.failedIds.push(row.id);
        continue;
      }
      if (!cols) { summary.alreadyCurrent++; continue; }
      await client.query(
        `UPDATE "Secrets" SET "encryptedKey" = $1, "keyIv" = $2, "keyAuthTag" = $3, "updatedAt" = now() WHERE id = $4`,
        [cols.encryptedKey, cols.keyIv, cols.keyAuthTag, row.id]
      );
      summary.rewrapped++;
    }
    const commit = !dryRun && summary.failedIds.length === 0;
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    summary.committed = commit;
    return summary;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export function describeResult(s, dryRun) {
  const lines = [
    `Vault rows: ${s.total}`,
    `  re-wrapped to the new key: ${s.rewrapped}`,
    `  already on the new key:    ${s.alreadyCurrent}`,
    `  unreadable with either key: ${s.failedIds.length}`,
  ];
  if (s.failedIds.length) {
    lines.push(`Unreadable row ids: ${s.failedIds.join(', ')}`);
    lines.push('No changes were written. Check IDENTITY_ATLAS_MASTER_KEY_PREVIOUS.');
  } else if (dryRun) {
    lines.push('Dry run — no changes were written.');
  } else {
    lines.push('Rotation committed. Point the web container at the new key and restart it.');
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const dryRun = args['dry-run'] === true;
  const keys = loadRotationKeys(env);
  const summary = await withClient(client => rotateMasterKey(client, { ...keys, dryRun }));
  console.log(describeResult(summary, dryRun));
  return summary.failedIds.length ? 1 : 0;
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
