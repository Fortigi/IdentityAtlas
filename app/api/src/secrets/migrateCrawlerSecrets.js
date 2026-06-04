// One-time migration: move any plaintext Graph clientSecret out of
// CrawlerConfigs / CrawlerJobs and into the encrypted vault, stripping the
// plaintext from the JSON. Idempotent — only touches rows that still hold a
// plaintext clientSecret. Runs at startup after the vault is initialised and
// migrations have run (so the Secrets table and jsonb columns exist).

import * as db from '../db/connection.js';
import { storeConfigSecret, storeJobSecret } from './crawlerSecrets.js';

export async function migrateCrawlerSecretsToVault() {
  let migrated = 0;

  // Saved configs → vault keyed by config id; strip the plaintext.
  try {
    const configs = await db.query(
      `SELECT id, config->>'clientSecret' AS secret
         FROM "CrawlerConfigs"
        WHERE config ? 'clientSecret' AND COALESCE(config->>'clientSecret', '') <> ''`
    );
    for (const row of configs.rows) {
      await storeConfigSecret(row.id, row.secret);
      await db.query(`UPDATE "CrawlerConfigs" SET config = config - 'clientSecret' WHERE id = $1`, [row.id]);
      migrated++;
    }
  } catch (err) {
    console.warn('Crawler-config secret migration skipped:', err.message);
  }

  // Jobs → inline jobs (no source config) keep their secret as a job-scoped
  // vault entry; config-derived jobs just drop the plaintext (the secret lives
  // on the config now and is injected at claim time). Either way, strip it.
  try {
    const jobs = await db.query(
      `SELECT id, config->>'clientSecret' AS secret, config->>'_scheduledByConfigId' AS src
         FROM "CrawlerJobs"
        WHERE config ? 'clientSecret' AND COALESCE(config->>'clientSecret', '') <> ''`
    );
    for (const row of jobs.rows) {
      if (!row.src) await storeJobSecret(row.id, row.secret);
      await db.query(`UPDATE "CrawlerJobs" SET config = config - 'clientSecret' WHERE id = $1`, [row.id]);
      migrated++;
    }
  } catch (err) {
    console.warn('Crawler-job secret migration skipped:', err.message);
  }

  if (migrated > 0) console.log(`Migrated ${migrated} crawler secret(s) to the encrypted vault`);
}
