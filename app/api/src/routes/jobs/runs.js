// Crawler-job lifecycle, system status + live-discovery endpoints —
// /api/admin/crawler-jobs[...], /api/admin/status, /api/admin/crawlers/:type/discover.
//
// Extracted verbatim from routes/jobs.js (audit finding C1). Mounted by
// routes/jobs.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { promises as fs } from 'fs';
import path from 'path';
import { getConfigSecret, storeJobSecret, storeJobCredentials } from '../../secrets/crawlerSecrets.js';
import { assertPublicUrl } from '../../lib/ssrfGuard.js';
import { CRAWLER_MANIFESTS_DIR, _crawlerManifests, validateStoredCrawlerConfig } from '../../crawlerManifests.js';
import { gate, useSql, VALID_JOB_TYPES, validateCreateJobBody, resolveJobConfig, resolveUploadFolder, prepareJobConfig, checkSingletonConflict, resolveCreatedBy } from './helpers.js';

const router = Router();

const TRACE_DIR = process.env.TRACE_DIR || '/data/uploads/jobs';
// Pre-resolve once so path-containment checks can use a stable absolute base.
const TRACE_DIR_RESOLVED = path.resolve(TRACE_DIR);
// Tail endpoint returns at most this many bytes per request.
const MAX_TRACE_CHUNK = 256 * 1024;  // 256 KB
const MAX_RECENT_JOBS = 50;

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

    const result = await pool.query(
      `INSERT INTO "CrawlerJobs" ("jobType", config, "createdBy")
              VALUES ($1, $2, $3)
              RETURNING *`,
      [jobType, configJson, createdBy]
    );
    const newJobId = result.rows[0].id;
    if (inlineSecret) await storeJobSecret(newJobId, inlineSecret);
    if (Object.keys(extraCreds).length) await storeJobCredentials(newJobId, extraCreds);

    // Update lastRunAt on the source config
    if (configId) {
      await pool.query(
        `UPDATE "CrawlerConfigs" SET "lastRunAt" = (now() AT TIME ZONE 'utc') WHERE id = $1`,
        [configId]
      );
    }

    res.status(201).json(result.rows[0]);
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
    const result = await pool.query(
      `SELECT * FROM "CrawlerJobs" ORDER BY "createdAt" DESC LIMIT $1`, [limit]);
    res.json(result.rows);
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
    const result = await pool.query(`SELECT * FROM "CrawlerJobs" WHERE id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
    res.json(result.rows[0]);
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
    const result = await pool.query(`
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

    const row = result.rows[0];
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
  // assertPublicUrl lets a handler reject an admin-supplied base URL that
  // resolves to a private/loopback/metadata address before it fetches it with a
  // credential (SSRF guard, audit L-6).
  return handler(req, res, { db, getConfigSecret, assertPublicUrl });
});

export default router;
