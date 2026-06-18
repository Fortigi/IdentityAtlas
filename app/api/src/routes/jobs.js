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
import { CRAWLER_MANIFESTS_DIR, _crawlerManifests, VALID_JOB_TYPES, validateCrawlerConfig } from '../crawlerManifests.js';

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

    let mergedConfig = (typeof existing.recordset[0].config === "string" ? JSON.parse(existing.recordset[0].config) : existing.recordset[0].config) || {};
    let newSecret = null;
    if (config) {
      const incoming = { ...config };
      // clientSecret goes to the vault; mask or empty means "keep existing"
      if (incoming.clientSecret && incoming.clientSecret !== SECRET_MASK) {
        newSecret = incoming.clientSecret;
      }
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

    const crawlerType = existing.recordset[0].crawlerType;
    if (config) {
      const configErr = validateCrawlerConfig(crawlerType, mergedConfig);
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
      .query(`SELECT "crawlerType" FROM "CrawlerConfigs" WHERE id = @id`);
    if (existing.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });
    const crawlerType = existing.recordset[0].crawlerType;
    const result = await pool.request().input('id', id)
      .query(`DELETE FROM "CrawlerConfigs" WHERE id = @id`);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Config not found' });
    // Best-effort cleanup of any uploaded files + the vaulted secret.
    deleteConfigFolder(crawlerType, id).catch(() => {});
    deleteConfigSecret(id).catch(() => {});
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

  const { jobType, config, configId: rawConfigId, syncMode: explicitSyncMode } = req.body;
  const configId = rawConfigId != null ? parseInt(rawConfigId, 10) : null;
  if (rawConfigId != null && (isNaN(configId) || configId <= 0)) {
    return res.status(400).json({ error: 'configId must be a positive integer' });
  }
  if (!jobType || !VALID_JOB_TYPES.includes(jobType)) {
    return res.status(400).json({ error: `jobType must be one of: ${VALID_JOB_TYPES.join(', ')}` });
  }
  if (explicitSyncMode !== undefined && explicitSyncMode !== 'full' && explicitSyncMode !== 'delta') {
    return res.status(400).json({ error: 'syncMode must be "full" or "delta"' });
  }

  try {
    const pool = await db.getPool();
    const createdBy = req.user?.preferred_username || req.user?.name || 'ui';

    // Prevent duplicate demo jobs
    if (jobType === 'demo') {
      const dup = await pool.request().query(
        `SELECT 1 FROM "CrawlerJobs" WHERE "jobType" = 'demo' AND status IN ('queued', 'running')`
      );
      if (dup.recordset.length > 0) {
        return res.status(409).json({ error: 'A demo data job is already queued or running' });
      }
    }

    // Resolve config: from configId (stored config) or inline
    let resolvedConfig = config || null;
    let configNextRunMode = null;
    if (configId) {
      const cfgResult = await pool.request().input('configId', configId)
        .query(`SELECT config, "nextRunMode" FROM "CrawlerConfigs" WHERE id = @configId AND "enabled" = TRUE`);
      if (cfgResult.recordset.length === 0) {
        return res.status(404).json({ error: 'Crawler config not found' });
      }
      // jsonb is auto-parsed by pg; legacy string column may still appear in tests.
      const raw = cfgResult.recordset[0].config;
      resolvedConfig = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      configNextRunMode = cfgResult.recordset[0].nextRunMode || 'delta';
    }

    // Validate entra-id credentials: clientSecret may live in the vault rather
    // than the config JSON, so we can't rely solely on the JSON Schema check.
    if (jobType === 'entra-id') {
      const hasSecret = configId ? await hasConfigSecret(configId) : !!resolvedConfig?.clientSecret;
      if (!resolvedConfig?.tenantId || !resolvedConfig?.clientId || !hasSecret) {
        return res.status(400).json({ error: 'Entra ID jobs require tenantId, clientId, and clientSecret' });
      }
    }

    // Validate config against the manifest's JSON Schema (all crawler types).
    const configErr = validateCrawlerConfig(jobType, resolvedConfig);
    if (configErr) return res.status(400).json({ error: configErr });

    // For crawler types that support file uploads (per their manifest), inject
    // the per-config upload folder so the worker knows where to read files
    // from. The folder must already exist and contain at least one file.
    if (_crawlerManifests[jobType]?.supportsFileUploads) {
      if (!configId) {
        return res.status(400).json({ error: `${jobType} jobs require a configId — inline configs are not supported` });
      }
      // Use the config's stored csvFolder if it exists and is within the
      // allowed base directory, otherwise fall back to the standard upload path.
      const configCsvFolder = resolvedConfig?.csvFolder;
      let folder = getUploadFolderPath(jobType, configId);
      if (configCsvFolder) {
        // Derive a relative path and rebuild from the trusted base so the
        // resulting path is constructed from a constant, not raw user data.
        const relPart = path.relative(CSV_BASE_DIR, path.resolve(configCsvFolder));
        if (relPart && !relPart.startsWith('..') && !path.isAbsolute(relPart)) {
          const safeCustom = path.join(CSV_BASE_DIR, relPart);
          try { readdirSync(safeCustom); folder = safeCustom; } catch { /* fall back to default */ }
        }
      }
      // Check for uploaded files — use try/catch to avoid TOCTOU (existsSync + read)
      let uploadedFiles = [];
      try { uploadedFiles = readdirSync(folder); } catch { /* folder missing or unreadable */ }
      if (uploadedFiles.length === 0) {
        return res.status(400).json({ error: 'No files found. Upload files or configure the folder path.' });
      }
      resolvedConfig = { ...(resolvedConfig || {}), csvFolder: folder };
    }

    // Stamp the source config id into the stored job config so the UI can
    // tell WHICH config is running when two configs of the same crawlerType
    // exist. The scheduler already stamps this field on scheduled runs
    // (see scheduler.js → queueScheduledJob); we were missing the mirror on
    // manual "Run Now" requests, which made the Crawlers page render the
    // "Force Stop" button on EVERY config of that type. Workers ignore
    // unknown fields so this is non-breaking.
    // Explicit syncMode in the request body wins (the "Run Delta" / "Run
    // Full" buttons). Falls back to the stored config's nextRunMode toggle,
    // then delta. Inline configs without a configId still accept an explicit
    // syncMode so API clients can control it.
    const effectiveSyncMode = explicitSyncMode || configNextRunMode || 'delta';
    // Strip all credential fields before storing — they are vaulted per-job and
    // injected at claim time by injectJobSecret.  Config-based jobs reference the
    // config's vaulted clientSecret via _scheduledByConfigId; inline jobs get both
    // clientSecret and any Omada credentials vaulted under the job id.
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
