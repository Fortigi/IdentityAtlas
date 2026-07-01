/**
 * Crawler job management + crawler configuration endpoints.
 * Jobs are stored in CrawlerJobs and picked up by the worker container.
 * Configs are stored in CrawlerConfigs for persistent crawler settings.
 */
import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as db from '../db/connection.js';
import { readdirSync, promises as fs } from 'fs';
import path from 'path';
import { getUploadFolderPath, deleteConfigFolder } from './crawlerFiles.js';
import { storeConfigSecret, hasConfigSecret, deleteConfigSecret, getConfigSecret, storeJobSecret, storeJobCredentials, OTHER_SECRET_FIELDS } from '../secrets/crawlerSecrets.js';
import { CRAWLER_MANIFESTS_DIR, _crawlerManifests, VALID_JOB_TYPES, validateCrawlerConfig, validateStoredCrawlerConfig, isSingletonJob, isPushModeType } from '../crawlerManifests.js';

// Re-exported for existing consumers (scheduler.js, jobs.*.test.js) that
// import these directly from this file rather than from crawlerManifests.js.
export { VALID_JOB_TYPES, validateCrawlerConfig };

const TRACE_DIR = process.env.TRACE_DIR || '/data/uploads/jobs';
// Pre-resolve once so path-containment checks can use a stable absolute base.
const TRACE_DIR_RESOLVED = path.resolve(TRACE_DIR);
// CSV uploads live under this base; configCsvFolder must stay within it.
const CSV_BASE_DIR = path.resolve(process.env.UPLOAD_ROOT || '/data/uploads');
// Tail endpoint returns at most this many bytes per request. If the file is
// larger than offset + MAX, the client polls again with the new offset. Keeps
// any single response small enough that a ~10 MB log on a long crawl streams
// to the UI in a dozen or so polls rather than one giant payload.
const MAX_TRACE_CHUNK = 256 * 1024;  // 256 KB

const router = Router();
const gate = requirePermission('admin.crawlers');
const useSql = process.env.USE_SQL === 'true';

const MAX_RECENT_JOBS = 50;
const SECRET_MASK = '••••••••';

const SECRET_FIELDS = ['clientSecret', ...OTHER_SECRET_FIELDS];

export function maskConfig(config) {
  if (!config) return null;
  const parsed = typeof config === 'string' ? JSON.parse(config) : config;
  const masked = { ...parsed };
  for (const field of SECRET_FIELDS) {
    if (masked[field]) masked[field] = SECRET_MASK;
  }
  return masked;
}


// Like maskConfig, but also surfaces the mask when the clientSecret lives in the
// vault (the normal case now) rather than in the stored config JSON.
async function maskedConfigForResponse(id, config) {
  const masked = maskConfig(config);
  if (await hasConfigSecret(id)) return { ...(masked || {}), clientSecret: SECRET_MASK };
  return masked;
}

// Merge an incoming config-patch onto the stored config for PATCH. clientSecret
// (if a real value, not the mask) is pulled out for the vault; other secret
// fields are kept from the existing config when blank/masked. Returns the merged
// config (never carries plaintext clientSecret) + the new secret to vault (if any).
// Pure. Exported for unit tests.
export function mergeConfigForUpdate(existingConfig, incomingConfig) {
  let mergedConfig = (typeof existingConfig === 'string' ? JSON.parse(existingConfig) : existingConfig) || {};
  let newSecret = null;
  if (incomingConfig) {
    const incoming = { ...incomingConfig };
    // clientSecret goes to the vault; mask or empty means "keep existing"
    if (incoming.clientSecret && incoming.clientSecret !== SECRET_MASK) newSecret = incoming.clientSecret;
    // Other secret fields (password, apiToken, cookieString): preserve existing if blank/masked
    for (const field of SECRET_FIELDS.filter(f => f !== 'clientSecret')) {
      if (!incoming[field] || incoming[field] === SECRET_MASK) {
        if (mergedConfig[field]) incoming[field] = mergedConfig[field];
        else delete incoming[field];
      }
    }
    delete incoming.clientSecret;
    mergedConfig = { ...mergedConfig, ...incoming };
  }
  delete mergedConfig.clientSecret; // never persist plaintext in the JSON
  return { mergedConfig, newSecret };
}

// Validate the create-job request body. Returns { jobType, configId,
// explicitSyncMode } on success, or { error: { status, body } }. Pure.
// Exported for unit tests.
export function validateCreateJobBody(body) {
  const { jobType, configId: rawConfigId, syncMode: explicitSyncMode } = body;
  const configId = rawConfigId != null ? parseInt(rawConfigId, 10) : null;
  if (rawConfigId != null && (isNaN(configId) || configId <= 0)) {
    return { error: { status: 400, body: { error: 'configId must be a positive integer' } } };
  }
  if (!jobType || !VALID_JOB_TYPES.includes(jobType)) {
    return { error: { status: 400, body: { error: `jobType must be one of: ${VALID_JOB_TYPES.join(', ')}` } } };
  }
  if (explicitSyncMode !== undefined && explicitSyncMode !== 'full' && explicitSyncMode !== 'delta') {
    return { error: { status: 400, body: { error: 'syncMode must be "full" or "delta"' } } };
  }
  return { jobType, configId, explicitSyncMode };
}

// Resolve the config a job should run with: inline (no configId) or the stored
// CrawlerConfigs row. Returns { resolvedConfig, configNextRunMode } or
// { error: { status, body } }. Exported for unit tests.
export async function resolveJobConfig(pool, inlineConfig, configId) {
  if (!configId) return { resolvedConfig: inlineConfig || null, configNextRunMode: null };
  const cfgResult = await pool.request().input('configId', configId)
    .query(`SELECT config, "nextRunMode" FROM "CrawlerConfigs" WHERE id = @configId AND "enabled" = TRUE`);
  if (cfgResult.recordset.length === 0) return { error: { status: 404, body: { error: 'Crawler config not found' } } };
  // jsonb is auto-parsed by pg; legacy string column may still appear in tests.
  const raw = cfgResult.recordset[0].config;
  return {
    resolvedConfig: (typeof raw === 'string') ? JSON.parse(raw) : raw,
    configNextRunMode: cfgResult.recordset[0].nextRunMode || 'delta',
  };
}

// For file-upload crawler types: resolve the upload folder (the config's stored
// csvFolder if it's inside CSV_BASE_DIR, else the standard per-config path) and
// confirm it contains at least one file. Returns { folder } or
// { error: { status, body } }. Exported for unit tests.
export function resolveUploadFolder(jobType, configId, resolvedConfig) {
  if (!configId) {
    return { error: { status: 400, body: { error: `${jobType} jobs require a configId — inline configs are not supported` } } };
  }
  const configCsvFolder = resolvedConfig?.csvFolder;
  let folder = getUploadFolderPath(jobType, configId);
  if (configCsvFolder) {
    // Derive a relative path and rebuild from the trusted base so the resulting
    // path is constructed from a constant, not raw user data.
    const relPart = path.relative(CSV_BASE_DIR, path.resolve(configCsvFolder));
    if (relPart && !relPart.startsWith('..') && !path.isAbsolute(relPart)) {
      const safeCustom = path.join(CSV_BASE_DIR, relPart);
      try { readdirSync(safeCustom); folder = safeCustom; } catch { /* fall back to default */ }
    }
  }
  // Check for uploaded files — use try/catch to avoid TOCTOU (existsSync + read).
  let uploadedFiles = [];
  try { uploadedFiles = readdirSync(folder); } catch { /* folder missing or unreadable */ }
  if (uploadedFiles.length === 0) {
    return { error: { status: 400, body: { error: 'No files found. Upload files or configure the folder path.' } } };
  }
  return { folder };
}

// Prepare the job's stored config: pick the effective syncMode, stamp the source
// configId, and strip every credential field (vaulted per-job, injected at claim
// time). Returns { inlineSecret, configToStore, configJson, extraCreds }. Pure.
// Exported for unit tests.
export function prepareJobConfig(resolvedConfig, configId, effectiveSyncMode) {
  const inlineSecret = (!configId && resolvedConfig?.clientSecret) ? resolvedConfig.clientSecret : null;
  const configToStore = configId
    ? { ...(resolvedConfig || {}), _scheduledByConfigId: configId, _syncMode: effectiveSyncMode }
    : (resolvedConfig ? { ...resolvedConfig, _syncMode: effectiveSyncMode } : null);
  const extraCreds = {};
  if (configToStore) {
    delete configToStore.clientSecret;
    for (const f of OTHER_SECRET_FIELDS) {
      if (configToStore[f]) { extraCreds[f] = configToStore[f]; delete configToStore[f]; }
    }
  }
  const configJson = configToStore ? JSON.stringify(configToStore) : null;
  return { inlineSecret, configToStore, configJson, extraCreds };
}

// Singleton-job types (manifest `singletonJob: true`) allow only one
// queued/running job at a time. Returns a 409 { status, body } when one is
// already active, else null. Exported for unit tests.
export async function checkSingletonConflict(pool, jobType) {
  if (!isSingletonJob(jobType)) return null;
  const dup = await pool.request().input('jobType', jobType).query(
    `SELECT 1 FROM "CrawlerJobs" WHERE "jobType" = @jobType AND status IN ('queued', 'running')`
  );
  if (dup.recordset.length > 0) return { status: 409, body: { error: `A ${jobType} job is already queued or running` } };
  return null;
}

// Best display name to stamp as the job's creator. Exported for unit tests.
export function resolveCreatedBy(req) {
  return req.user?.preferred_username || req.user?.name || 'ui';
}

// ═══════════════════════════════════════════════════════════════════
// CRAWLER CONFIGS — Persistent crawler configurations
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/crawler-configs — List all configs (secrets masked)
router.get('/admin/crawler-configs', gate, async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const result = await pool.request().query(
      `SELECT * FROM "CrawlerConfigs" WHERE "enabled" = TRUE ORDER BY "createdAt" DESC`
    );
    const configs = await Promise.all(result.recordset.map(async r => ({
      ...r,
      config: await maskedConfigForResponse(r.id, r.config),
    })));
    res.json(configs);
  } catch (err) {
    console.error('Error listing crawler configs:', err.message);
    res.status(500).json({ error: 'Failed to list configs' });
  }
});

// POST /api/admin/crawler-configs — Create a new config
router.post('/admin/crawler-configs', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { crawlerType, displayName, config } = req.body;

  if (!crawlerType || !displayName?.trim()) {
    return res.status(400).json({ error: 'crawlerType and displayName are required' });
  }

  try {
    // Strip the clientSecret out of the stored JSON — it goes to the vault.
    const incoming = { ...(config || {}) };
    const clientSecret = incoming.clientSecret;
    delete incoming.clientSecret;

    const pool = await db.getPool();
    const result = await pool.request()
      .input('crawlerType', crawlerType)
      .input('displayName', displayName.trim().slice(0, 255))
      .input('config', JSON.stringify(incoming))
      .query(`INSERT INTO "CrawlerConfigs" ("crawlerType", "displayName", config)
              VALUES (@crawlerType, @displayName, @config)
              RETURNING *`);

    const row = result.recordset[0];
    if (clientSecret && clientSecret !== SECRET_MASK) await storeConfigSecret(row.id, clientSecret);
    res.status(201).json({ ...row, config: await maskedConfigForResponse(row.id, row.config) });
  } catch (err) {
    console.error('Error creating crawler config:', err.message);
    res.status(500).json({ error: 'Failed to create config' });
  }
});

// GET /api/admin/crawler-configs/:id — Single config (secret masked)
router.get('/admin/crawler-configs/:id', gate, async (req, res) => {
  if (!useSql) return res.status(404).json({ error: 'Not found' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid config ID' });

  try {
    const pool = await db.getPool();
    const result = await pool.request().input('id', id)
      .query(`SELECT * FROM "CrawlerConfigs" WHERE id = @id`);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });
    const row = result.recordset[0];
    res.json({ ...row, config: await maskedConfigForResponse(row.id, row.config) });
  } catch (err) {
    console.error('Error fetching crawler config:', err.message);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// PATCH /api/admin/crawler-configs/:id — Update config
router.patch('/admin/crawler-configs/:id', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid config ID' });

  const { displayName, config, nextRunMode } = req.body;
  if (nextRunMode !== undefined && nextRunMode !== 'full' && nextRunMode !== 'delta') {
    return res.status(400).json({ error: 'nextRunMode must be "full" or "delta"' });
  }

  try {
    const pool = await db.getPool();

    // Read existing config. The clientSecret lives in the vault, not here.
    const existing = await pool.request().input('id', id)
      .query(`SELECT config, "crawlerType" FROM "CrawlerConfigs" WHERE id = @id`);
    if (existing.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });

    const { mergedConfig, newSecret } = mergeConfigForUpdate(existing.recordset[0].config, config);

    const crawlerType = existing.recordset[0].crawlerType;
    if (config) {
      // mergedConfig never has clientSecret (just stripped above) — use the
      // vault-aware validator so types whose schema requires it (entra-id,
      // omada/midPoint's OAuth2 methods) don't reject an edit that doesn't
      // touch credentials.
      const configErr = await validateStoredCrawlerConfig(crawlerType, mergedConfig, id);
      if (configErr) return res.status(400).json({ error: configErr });
    }

    const sets = ['config = @config', '"updatedAt" = now()'];
    const request = pool.request().input('id', id).input('config', JSON.stringify(mergedConfig));

    if (displayName !== undefined) {
      sets.push('"displayName" = @displayName');
      request.input('displayName', displayName.trim().slice(0, 255));
    }

    if (nextRunMode !== undefined) {
      sets.push('"nextRunMode" = @nextRunMode');
      request.input('nextRunMode', nextRunMode);
    }

    const result = await request.query(
      `UPDATE "CrawlerConfigs" SET ${sets.join(', ')} WHERE id = @id RETURNING *`
    );
    const row = result.recordset[0];
    if (newSecret) await storeConfigSecret(id, newSecret);
    res.json({ ...row, config: await maskedConfigForResponse(row.id, row.config) });
  } catch (err) {
    console.error('Error updating crawler config:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// DELETE /api/admin/crawler-configs/:id — Remove config
router.delete('/admin/crawler-configs/:id', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid config ID' });

  try {
    const pool = await db.getPool();
    const existing = await pool.request().input('id', id)
      .query(`SELECT "crawlerType", config FROM "CrawlerConfigs" WHERE id = @id`);
    if (existing.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });
    const { crawlerType, config: existingConfig } = existing.recordset[0];
    const result = await pool.request().input('id', id)
      .query(`DELETE FROM "CrawlerConfigs" WHERE id = @id`);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Config not found' });
    // Best-effort cleanup of any uploaded files + the vaulted secret.
    deleteConfigFolder(crawlerType, id).catch(() => {});
    deleteConfigSecret(id).catch(() => {});
    // A push-mode type's card is a CrawlerConfigs row paired with a Crawlers
    // row (the API key) created together in routes/crawlers.js's POST
    // handler — clean up the other side too so removing the card doesn't
    // orphan a still-live API key.
    if (isPushModeType(crawlerType)) {
      const crawlerId = (typeof existingConfig === 'string' ? JSON.parse(existingConfig) : existingConfig)?.crawlerId;
      if (crawlerId) {
        pool.request().input('crawlerId', crawlerId)
          .query(`DELETE FROM "Crawlers" WHERE id = @crawlerId`).catch(() => {});
      }
    }
    res.json({ message: 'Config removed' });
  } catch (err) {
    console.error('Error removing crawler config:', err.message);
    res.status(500).json({ error: 'Failed to remove config' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CRAWLER JOBS — Create and manage jobs
// ═══════════════════════════════════════════════════════════════════

// POST /api/admin/crawler-jobs — Create a new job
router.post('/admin/crawler-jobs', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const v = validateCreateJobBody(req.body);
  if (v.error) return res.status(v.error.status).json(v.error.body);
  const { jobType, configId, explicitSyncMode } = v;

  try {
    const pool = await db.getPool();
    const createdBy = resolveCreatedBy(req);

    const singletonErr = await checkSingletonConflict(pool, jobType);
    if (singletonErr) return res.status(singletonErr.status).json(singletonErr.body);

    // Resolve config: from configId (stored config) or inline.
    const cfg = await resolveJobConfig(pool, req.body.config, configId);
    if (cfg.error) return res.status(cfg.error.status).json(cfg.error.body);
    let { resolvedConfig } = cfg;

    // Validate config against the manifest's JSON Schema (all crawler types).
    // A configId-sourced config never has clientSecret (vault-only) —
    // validateStoredCrawlerConfig checks the vault instead of failing on its
    // absence for types whose schema requires it.
    const configErr = await validateStoredCrawlerConfig(jobType, resolvedConfig, configId);
    if (configErr) return res.status(400).json({ error: configErr });

    // For crawler types that support file uploads (per their manifest), inject
    // the per-config upload folder so the worker knows where to read files from.
    if (_crawlerManifests[jobType]?.supportsFileUploads) {
      const up = resolveUploadFolder(jobType, configId, resolvedConfig);
      if (up.error) return res.status(up.error.status).json(up.error.body);
      resolvedConfig = { ...(resolvedConfig || {}), csvFolder: up.folder };
    }

    // Explicit syncMode in the request body wins (the "Run Delta" / "Run Full"
    // buttons). Falls back to the stored config's nextRunMode toggle, then delta.
    const effectiveSyncMode = explicitSyncMode || cfg.configNextRunMode || 'delta';
    const { inlineSecret, configJson, extraCreds } = prepareJobConfig(resolvedConfig, configId, effectiveSyncMode);

    const result = await pool.request()
      .input('jobType', jobType)
      .input('config', configJson)
      .input('createdBy', createdBy)
      .query(`INSERT INTO "CrawlerJobs" ("jobType", config, "createdBy")
              VALUES (@jobType, @config, @createdBy)
              RETURNING *`);
    const newJobId = result.recordset[0].id;
    if (inlineSecret) await storeJobSecret(newJobId, inlineSecret);
    if (Object.keys(extraCreds).length) await storeJobCredentials(newJobId, extraCreds);

    // Update lastRunAt on the source config
    if (configId) {
      await pool.request().input('configId', configId)
        .query(`UPDATE "CrawlerConfigs" SET "lastRunAt" = (now() AT TIME ZONE 'utc') WHERE id = @configId`);
    }

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    console.error('Error creating crawler job:', err.message);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// GET /api/admin/crawler-jobs — List recent jobs
router.get('/admin/crawler-jobs', gate, async (req, res) => {
  if (!useSql) return res.json([]);

  try {
    const pool = await db.getPool();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, MAX_RECENT_JOBS);
    const result = await pool.request()
      .input('limit', limit)
      .query(`SELECT * FROM "CrawlerJobs" ORDER BY "createdAt" DESC LIMIT @limit`);
    res.json(result.recordset);
  } catch (err) {
    console.error('Error listing crawler jobs:', err.message);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

// GET /api/admin/crawler-jobs/:id — Single job with progress
router.get('/admin/crawler-jobs/:id', gate, async (req, res) => {
  if (!useSql) return res.status(404).json({ error: 'Not found' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid job ID' });

  try {
    const pool = await db.getPool();
    const result = await pool.request()
      .input('id', id)
      .query(`SELECT * FROM "CrawlerJobs" WHERE id = @id`);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Job not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Error fetching crawler job:', err.message);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// GET /api/admin/crawler-jobs/:id/log — tail the per-job trace log.
//
// The worker's Invoke-CrawlerJob.ps1 wraps each run in Start-Transcript,
// writing every Write-Host line (plus child script output) to
// /data/uploads/jobs/{id}.log. That volume is also mounted into the web
// container, so we can read it here.
//
// Query params:
//   offset — byte position to read from (client passes back the totalLength
//            it received last time for efficient incremental polling)
// Response:
//   { text: <string>, offset: <int>, totalLength: <int>, truncated: <bool>,
//     exists: <bool> }
//
// `truncated=true` means the response was capped at MAX_TRACE_CHUNK bytes
// — the client should poll again with the new offset (offset + text.length).
router.get('/admin/crawler-jobs/:id/log', gate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 0) return res.status(400).json({ error: 'Invalid job ID' });
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const logPath = path.resolve(TRACE_DIR_RESOLVED, `${id}.log`);
  if (!logPath.startsWith(TRACE_DIR_RESOLVED + path.sep)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }
  try {
    const fh = await fs.open(logPath, 'r');
    try {
      const stat = await fh.stat();
      const totalLength = stat.size;
      if (offset >= totalLength) {
        return res.json({ text: '', offset, totalLength, truncated: false, exists: true });
      }
      const length = Math.min(MAX_TRACE_CHUNK, totalLength - offset);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      const text = buf.toString('utf8');
      const truncated = (offset + length) < totalLength;
      return res.json({ text, offset, totalLength, truncated, exists: true });
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json({ text: '', offset: 0, totalLength: 0, truncated: false, exists: false });
    }
    console.error(`Error reading trace log for job ${id}:`, err.message);
    res.status(500).json({ error: 'Failed to read trace log' });
  }
});

// DELETE /api/admin/crawler-jobs/:id — Cancel a queued job
// DELETE /api/admin/crawler-jobs/:id — cancel a queued job
router.delete('/admin/crawler-jobs/:id', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid job ID' });

  try {
    const result = await db.query(
      `UPDATE "CrawlerJobs" SET status = 'cancelled', "completedAt" = now()
        WHERE id = $1 AND status = 'queued'`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Job not found or not in queued state' });
    }
    res.json({ message: 'Job cancelled' });
  } catch (err) {
    console.error('Error cancelling job:', err.message);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

// POST /api/admin/crawler-jobs/:id/force-stop — force-stop a running job.
//
// This marks the job as failed in the database. The worker process will notice
// the status change on its next progress-report cycle and stop. If the worker
// has already crashed (the most common reason to use this), the job just gets
// marked failed so the UI stops showing it as running.
//
// This does NOT kill the PowerShell process — there's no clean way to do that
// from the web container. The worker's scheduler.ps1 checks job status before
// starting new work, so a force-stopped job won't block the next run.
router.post('/admin/crawler-jobs/:id/force-stop', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid job ID' });

  try {
    const result = await db.query(
      `UPDATE "CrawlerJobs"
          SET status = 'failed',
              "errorMessage" = COALESCE("errorMessage", '') || ' [Force-stopped by admin]',
              "completedAt" = now()
        WHERE id = $1 AND status IN ('running', 'queued')
        RETURNING id, status`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Job not found or already completed/failed' });
    }
    res.json({ message: 'Job force-stopped', id });
  } catch (err) {
    console.error('Error force-stopping job:', err.message);
    res.status(500).json({ error: 'Failed to force-stop job' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// SYSTEM STATUS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/status — System status for getting-started UI
router.get('/admin/status', gate, async (req, res) => {
  if (!useSql) {
    return res.json({ hasData: true, hasCrawlers: false, hasConfigs: false, pendingJobs: 0, runningJobs: 0 });
  }

  try {
    const pool = await db.getPool();
    // Postgres: use to_regclass() instead of INFORMATION_SCHEMA EXISTS subqueries.
    // After migrations have run all five tables exist, but we keep the safety
    // checks so a stack started before migrations don't return 500.
    const result = await pool.request().query(`
      SELECT
        CASE WHEN to_regclass('"Principals"')     IS NULL THEN 0
             WHEN (SELECT COUNT(*) FROM "Principals") > 0 THEN 1 ELSE 0 END AS "hasData",
        CASE WHEN to_regclass('"Crawlers"')       IS NULL THEN 0
             ELSE (SELECT COUNT(*)::int FROM "Crawlers" WHERE "enabled" = TRUE) END AS "crawlerCount",
        CASE WHEN to_regclass('"CrawlerConfigs"') IS NULL THEN 0
             ELSE (SELECT COUNT(*)::int FROM "CrawlerConfigs" WHERE "enabled" = TRUE) END AS "configCount",
        CASE WHEN to_regclass('"CrawlerJobs"')    IS NULL THEN 0
             ELSE (SELECT COUNT(*)::int FROM "CrawlerJobs" WHERE "status" = 'queued') END AS "pendingJobs",
        CASE WHEN to_regclass('"CrawlerJobs"')    IS NULL THEN 0
             ELSE (SELECT COUNT(*)::int FROM "CrawlerJobs" WHERE "status" = 'running') END AS "runningJobs"
    `);

    const row = result.recordset[0];
    res.json({
      hasData: row.hasData === 1,
      hasCrawlers: row.crawlerCount > 0,
      hasConfigs: row.configCount > 0,
      pendingJobs: row.pendingJobs,
      runningJobs: row.runningJobs,
    });
  } catch (err) {
    console.error('Error fetching status:', err.message);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─── Generic per-crawler live discovery ─────────────────────────────────────
// Crawlers that support live discovery (e.g. populating wizard dropdowns)
// export a default handler(req, res, ctx) from their own crawler folder
// (tools/crawlers/<type>/discover.js, bundled into /app/crawlers at build time).
// No core file needs to know which crawlers exist.
router.post('/admin/crawlers/:type/discover', gate, async (req, res) => {
  const { type } = req.params;
  if (!/^[a-z][a-z0-9-]*$/.test(type) || !VALID_JOB_TYPES.includes(type)) {
    return res.status(404).json({ error: `Unknown crawler type: ${type}` });
  }
  let handler;
  try {
    const discoverPath = path.join(CRAWLER_MANIFESTS_DIR, type, 'discover.js');
    const { pathToFileURL } = await import('url');
    const mod = await import(pathToFileURL(discoverPath).href);
    handler = mod.default;
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      return res.status(404).json({ error: `Crawler '${type}' does not support live discovery` });
    }
    console.error(`${type}/discover load error:`, err.message);
    return res.status(500).json({ error: 'Failed to load discovery handler' });
  }
  // Pass API dependencies as context — the handler must not import them directly
  // because its path in the Docker image differs from the API source tree.
  return handler(req, res, { db, getConfigSecret });
});

export default router;
