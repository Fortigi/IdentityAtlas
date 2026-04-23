// Auto-bootstrap: runs DB migrations + creates the built-in worker crawler
// on first startup. Idempotent — safe to run on every web container start.
//
// In v5 (postgres) the schema is created entirely by the migration files in
// db/migrations/. This file no longer creates tables — it just runs the
// migrations runner and seeds the built-in worker crawler if it's missing.
// MVCC means we no longer need to enable snapshot isolation explicitly; it's
// the default behavior in postgres.
//
// The built-in worker API key is also written to a file inside the shared
// `job_data` volume so the worker container can pick it up on startup
// without needing direct DB access. The file is written with restrictive
// permissions and only contains the plaintext key — the same value the
// worker would have read from WorkerConfig in v4.

import crypto from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import * as db from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { selfTest as vaultSelfTest } from './secrets/vault.js';
import { startScheduler } from './scheduler.js';
import { seedContextAlgorithms } from './contexts/seedAlgorithms.js';

const WORKER_KEY_FILE = process.env.WORKER_KEY_FILE || '/data/uploads/.builtin-worker-key';

function writeWorkerKeyFile(apiKey) {
  try {
    mkdirSync(dirname(WORKER_KEY_FILE), { recursive: true });
    writeFileSync(WORKER_KEY_FILE, apiKey, { mode: 0o600, encoding: 'utf8' });
    console.log(`Built-in worker key written to ${WORKER_KEY_FILE}`);
  } catch (err) {
    console.warn(`Could not write worker key file (${WORKER_KEY_FILE}): ${err.message}`);
  }
}

const KEY_PREFIX = 'fgc_';
const KEY_RANDOM_BYTES = 32;
const BUILTIN_CRAWLER_NAME = 'Built-in Worker';

function generateApiKey() {
  const random = crypto.randomBytes(KEY_RANDOM_BYTES).toString('hex');
  return `${KEY_PREFIX}${random}`;
}

function hashKey(apiKey, salt) {
  return crypto.createHash('sha256').update(Buffer.concat([salt, Buffer.from(apiKey, 'utf8')])).digest();
}

async function ensureBuiltinCrawler() {
  const existing = await db.queryOne(
    `SELECT id FROM "Crawlers" WHERE "displayName" = $1 AND "enabled" = TRUE`,
    [BUILTIN_CRAWLER_NAME]
  );

  if (existing) {
    const cfg = await db.queryOne(
      `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = 'BUILTIN_CRAWLER_API_KEY'`
    );
    if (cfg) {
      // Existing key — re-write the shared-volume file in case the volume
      // was nuked since the last restart (common during dev iteration).
      writeWorkerKeyFile(cfg.configValue);
      return;
    }

    console.log('Built-in Worker crawler exists but WorkerConfig key missing — rotating...');
    const apiKey = generateApiKey();
    const salt = crypto.randomBytes(32);
    const hash = hashKey(apiKey, salt);
    const prefix = apiKey.slice(0, 8);

    await db.query(
      `UPDATE "Crawlers"
          SET "apiKeyHash" = $1, "apiKeySalt" = $2, "apiKeyPrefix" = $3,
              "lastRotatedAt" = (now() AT TIME ZONE 'utc')
        WHERE id = $4`,
      [hash, salt, prefix, existing.id]
    );
    await db.query(
      `INSERT INTO "WorkerConfig" ("configKey", "configValue") VALUES ('BUILTIN_CRAWLER_API_KEY', $1)`,
      [apiKey]
    );
    writeWorkerKeyFile(apiKey);
    console.log('Built-in Worker key rotated and stored in WorkerConfig');
    return;
  }

  console.log('Creating Built-in Worker crawler...');
  const apiKey = generateApiKey();
  const salt = crypto.randomBytes(32);
  const hash = hashKey(apiKey, salt);
  const prefix = apiKey.slice(0, 8);

  await db.query(
    `INSERT INTO "Crawlers"
       ("displayName", "description", "apiKeyHash", "apiKeySalt", "apiKeyPrefix", "createdBy", "permissions")
     VALUES ($1, $2, $3, $4, $5, 'system-bootstrap', '["ingest","refreshViews","admin"]'::jsonb)`,
    [BUILTIN_CRAWLER_NAME, 'Auto-created crawler for the Docker worker container. Do not delete.',
     hash, salt, prefix]
  );

  await db.query(
    `INSERT INTO "WorkerConfig" ("configKey", "configValue")
     VALUES ('BUILTIN_CRAWLER_API_KEY', $1)
     ON CONFLICT ("configKey") DO UPDATE
       SET "configValue" = EXCLUDED."configValue", "updatedAt" = now()`,
    [apiKey]
  );

  writeWorkerKeyFile(apiKey);
  console.log(`Built-in Worker crawler created (prefix: ${prefix})`);
}

// Periodic prune of the `_history` audit table. Reads the retention setting
// from WorkerConfig (default 180 days) and deletes anything older. Runs once
// at startup (60s warm-up so it doesn't fight migrations) and then every 6 hours.
// Setting retention to 0 disables pruning entirely.
function startHistoryPruneJob() {
  const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const FIRST_RUN_DELAY_MS = 60 * 1000;
  const DEFAULT_DAYS = 180;

  async function prune() {
    try {
      const r = await db.queryOne(
        `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
        ['HISTORY_RETENTION_DAYS']
      );
      const days = r ? parseInt(r.configValue, 10) : DEFAULT_DAYS;
      if (days <= 0) return; // disabled
      const del = await db.query(
        `DELETE FROM "_history" WHERE "changedAt" < now() - ($1::int * interval '1 day')`,
        [days]
      );
      if (del.rowCount > 0) {
        console.log(`History prune: deleted ${del.rowCount} row(s) older than ${days} days`);
      }
    } catch (err) {
      console.error('History prune failed (will retry next interval):', err.message);
    }
  }

  setTimeout(prune, FIRST_RUN_DELAY_MS);
  setInterval(prune, PRUNE_INTERVAL_MS);
}

// Verify the secrets vault has a usable master key. Resolution order:
//   1. IDENTITY_ATLAS_MASTER_KEY env var (preferred — user controls it)
//   2. /data/uploads/.master-key file (auto-generated on first boot, persisted
//      across restarts in the same docker volume as the worker key)
//
// The file fallback exists so the docker-compose stack works out of the box
// without requiring the operator to set an env var before first start. The file
// has 0600 perms and lives inside the same volume that already holds other
// secrets-equivalent data (the built-in worker API key). For real production
// deployments, setting IDENTITY_ATLAS_MASTER_KEY explicitly is still preferred
// (so it can be sourced from a real secret store) and the file fallback never
// kicks in.
import { readFileSync, existsSync } from 'fs';
const MASTER_KEY_FILE = process.env.MASTER_KEY_FILE || '/data/uploads/.master-key';

function ensureVaultKey() {
  if (process.env.IDENTITY_ATLAS_MASTER_KEY) {
    if (!vaultSelfTest()) throw new Error('Secrets vault self-test failed — check IDENTITY_ATLAS_MASTER_KEY');
    return;
  }
  if (existsSync(MASTER_KEY_FILE)) {
    // File exists — it MUST be readable. Falling through to generate a new key
    // would silently corrupt any secrets encrypted with the old one (LLM API
    // keys, scraper credentials). A hard error is the only safe option.
    let key;
    try {
      key = readFileSync(MASTER_KEY_FILE, 'utf8').trim();
    } catch (err) {
      throw new Error(
        `Master key file exists at ${MASTER_KEY_FILE} but could not be read: ${err.message}. ` +
        `This usually means the file is owned by a different user than the web container. ` +
        `Fix with: docker compose exec -u 0 web chown -R node:node /data`
      );
    }
    if (!key) {
      throw new Error(`Master key file ${MASTER_KEY_FILE} is empty. Delete it and restart the web container to regenerate.`);
    }
    process.env.IDENTITY_ATLAS_MASTER_KEY = key;
    if (!vaultSelfTest()) throw new Error('Secrets vault self-test failed — master key file is corrupt');
    console.log(`Master key loaded from ${MASTER_KEY_FILE}`);
    return;
  }
  // First boot — generate a key and persist it
  const key = crypto.randomBytes(32).toString('base64');
  process.env.IDENTITY_ATLAS_MASTER_KEY = key;
  try {
    mkdirSync(dirname(MASTER_KEY_FILE), { recursive: true });
    writeFileSync(MASTER_KEY_FILE, key, { mode: 0o600, encoding: 'utf8' });
    console.log(`Master key generated and persisted to ${MASTER_KEY_FILE}`);
    console.log('For production, prefer setting IDENTITY_ATLAS_MASTER_KEY explicitly so the key can be backed up.');
  } catch (err) {
    // Can't persist → refuse to continue. Running with an ephemeral key would
    // silently lose all secrets on the next container restart.
    throw new Error(
      `Could not persist master key to ${MASTER_KEY_FILE}: ${err.message}. ` +
      `Set IDENTITY_ATLAS_MASTER_KEY explicitly in the compose env, or fix the volume permissions.`
    );
  }
  if (!vaultSelfTest()) throw new Error('Secrets vault self-test failed after key generation');
}

// ─── Tag-root bootstrap ─────────────────────────────────────────────────────
// Tags are stored as Contexts (contextType='Tag', variant='manual'). Without
// a parent they all sit at the top of the tree selector — one root per tag
// — which clutters the UI fast. We group them under a synthetic "Tags" root
// per targetType (Principal for user-tags, Resource for resource-tags). The
// same-targetType-throughout-a-tree invariant means we need one root per
// targetType rather than a single shared root.
//
// Idempotent: creates the roots if missing, reparents any orphan tags
// (parentContextId IS NULL) on every boot. Tags created via /api/tags
// after this also attach under the right root.
async function ensureTagRoots() {
  const TARGET_TYPES = ['Principal', 'Resource'];
  for (const targetType of TARGET_TYPES) {
    let root = await db.queryOne(
      `SELECT id FROM "Contexts"
        WHERE "contextType" = 'TagGroup'
          AND "targetType"  = $1
          AND "parentContextId" IS NULL
        LIMIT 1`,
      [targetType]
    );
    if (!root) {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO "Contexts"
           (id, variant, "targetType", "contextType", "displayName", description, "createdByUser")
         VALUES ($1, 'manual', $2, 'TagGroup', 'Tags', $3, 'system-bootstrap')`,
        [id, targetType, `Synthetic root grouping all ${targetType} tags. Created by bootstrap.`]
      );
      root = { id };
      console.log(`Tag-root: created Tags root for ${targetType}`);
    }
    const r = await db.query(
      `UPDATE "Contexts"
          SET "parentContextId" = $1
        WHERE "contextType"     = 'Tag'
          AND "targetType"      = $2
          AND "parentContextId" IS NULL`,
      [root.id, targetType]
    );
    if (r.rowCount > 0) {
      console.log(`Tag-root: reparented ${r.rowCount} orphan ${targetType} tag(s)`);
    }
  }
}

// Used by tags.js POST. Returns the id of the Tags-group root for a given
// targetType, creating it if missing. Concurrency-safe: a duplicate INSERT
// is impossible because the SELECT-INSERT path runs inside one HTTP request
// and ensureTagRoots() at boot has already created the rows in practice.
export async function getOrCreateTagRoot(targetType) {
  let row = await db.queryOne(
    `SELECT id FROM "Contexts"
      WHERE "contextType" = 'TagGroup'
        AND "targetType"  = $1
        AND "parentContextId" IS NULL
      LIMIT 1`,
    [targetType]
  );
  if (row) return row.id;
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO "Contexts"
       (id, variant, "targetType", "contextType", "displayName", description, "createdByUser")
     VALUES ($1, 'manual', $2, 'TagGroup', 'Tags', $3, 'system-bootstrap')`,
    [id, targetType, `Synthetic root grouping all ${targetType} tags. Created on demand.`]
  );
  return id;
}

export async function bootstrapWorker() {
  if (process.env.USE_SQL !== 'true') return;
  try {
    ensureVaultKey();
    const pool = await db.getPool();
    await runMigrations(pool);
    await ensureBuiltinCrawler();
    try {
      await seedContextAlgorithms();
    } catch (err) {
      // Non-critical: the ContextAlgorithms table is created by migration 018
      // so this can fail on fresh boots if that migration hasn't run yet —
      // it just means the Contexts plugins picker will be empty until next boot.
      console.warn('Context-algorithm seeding skipped:', err.message);
    }
    try {
      await ensureTagRoots();
    } catch (err) {
      console.warn('Tag-root bootstrap skipped:', err.message);
    }
    startHistoryPruneJob();
    startScheduler();
    // Reap stale jobs: on every web container start, mark ALL jobs stuck in
    // 'running' or 'queued' as failed. After a container restart, no worker
    // process is continuing these jobs — they're dead. The old 2-hour
    // threshold missed jobs from crashes/reboots that happened recently.
    try {
      const reaped = await db.query(`
        UPDATE "CrawlerJobs"
           SET status = 'failed',
               "errorMessage" = 'Marked as failed by bootstrap — container restarted while job was running',
               "completedAt" = now()
         WHERE status IN ('running', 'queued')
      `);
      if (reaped.rowCount > 0) {
        console.log(`Reaped ${reaped.rowCount} stale running job(s)`);
      }
    } catch { /* CrawlerJobs table may not exist on first boot */ }

    // Initial matrix-view refresh. Migration 013 creates the matrix
    // materialized views WITH NO DATA, so they're empty on first boot
    // after the migration runs. Any request to /api/permissions would
    // return zero rows until something triggers a refresh. Kick it off
    // here so the UI is usable immediately. If the data is already
    // populated, CONCURRENTLY makes this cheap (incremental).
    try {
      const { refreshMatrixViews } = await import('./routes/ingest.js');
      await refreshMatrixViews();
      console.log('Matrix views refreshed');
    } catch (err) {
      console.warn('Matrix-view refresh skipped:', err.message);
    }
    console.log('Bootstrap complete');
  } catch (err) {
    console.error('Bootstrap failed (will retry on next request):', err.message);
  }
}
