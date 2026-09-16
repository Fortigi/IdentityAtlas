// Startup migration: move any plaintext crawler credential — clientSecret,
// password, apiToken, cookieString — out of CrawlerConfigs / CrawlerJobs and
// into the encrypted vault, stripping the plaintext from the JSON. Idempotent:
// only touches rows that still hold one of those keys. Runs at startup after the
// vault is initialised and migrations have run (so the Secrets table and jsonb
// columns exist).
//
// password / apiToken / cookieString were stored in plaintext at config level
// until SEC-2026-09 M-10; this pass vaults them per config the same way
// clientSecret has been.

import * as db from '../db/connection.js';
import {
  storeConfigFields, storeJobSecret, storeJobCredentials, CONFIG_SECRET_FIELDS,
} from './crawlerSecrets.js';

// The non-empty credential values in a stored config object.
function credentialValues(config) {
  const out = {};
  for (const field of CONFIG_SECRET_FIELDS) {
    const v = config?.[field];
    if (v !== undefined && v !== null && v !== '') out[field] = String(v);
  }
  return out;
}

async function migrateConfigs() {
  let migrated = 0;
  const configs = await db.query(
    `SELECT id, config FROM "CrawlerConfigs" WHERE config ?| $1::text[]`,
    [CONFIG_SECRET_FIELDS]
  );
  for (const row of configs.rows) {
    await storeConfigFields(row.id, credentialValues(row.config));
    await db.query(`UPDATE "CrawlerConfigs" SET config = config - $2::text[] WHERE id = $1`, [row.id, CONFIG_SECRET_FIELDS]);
    migrated++;
  }
  return migrated;
}

// Inline jobs (no source config) keep their credentials as job-scoped vault
// entries; config-derived jobs just drop the plaintext (the credentials live on
// the config and are injected at claim time). Either way, strip it.
async function migrateJobs() {
  let migrated = 0;
  const jobs = await db.query(
    `SELECT id, config, "configId" FROM "CrawlerJobs" WHERE config ?| $1::text[]`,
    [CONFIG_SECRET_FIELDS]
  );
  for (const row of jobs.rows) {
    if (!row.configId) {
      const { clientSecret, ...others } = credentialValues(row.config);
      if (clientSecret) await storeJobSecret(row.id, clientSecret);
      await storeJobCredentials(row.id, others);
    }
    await db.query(`UPDATE "CrawlerJobs" SET config = config - $2::text[] WHERE id = $1`, [row.id, CONFIG_SECRET_FIELDS]);
    migrated++;
  }
  return migrated;
}

export async function migrateCrawlerSecretsToVault() {
  let migrated = 0;
  try {
    migrated += await migrateConfigs();
  } catch (err) {
    console.warn('Crawler-config secret migration skipped:', err.message);
  }
  try {
    migrated += await migrateJobs();
  } catch (err) {
    console.warn('Crawler-job secret migration skipped:', err.message);
  }
  if (migrated > 0) console.log(`Moved plaintext crawler credentials of ${migrated} row(s) into the encrypted vault`);
}
