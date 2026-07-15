// Crawler self-service endpoints (API-key auth) — /api/crawlers/* : whoami,
// key rotation, job progress, the worker job-claim protocol and delta-token
// persistence.
//
// Extracted verbatim from routes/crawlers.js (audit finding C1). Re-exported by
// routes/crawlers.js and mounted in app.js exactly as before. No behaviour
// change — pure code move.

import { Router } from 'express';
import crypto from 'crypto';
import * as db from '../../db/connection.js';
import { injectJobSecret, deleteJobSecret } from '../../secrets/crawlerSecrets.js';
import { runPostCrawlJobs } from '../../postCrawlJobs.js';
import { crawlerHasPermission, crawlerHasSystemAccess } from '../../middleware/crawlerAuth.js';
import { recordComponentVersion } from '../../updates/componentVersions.js';
import { useSql, generateApiKey, hashKey } from './shared.js';

const selfServiceCrawlersRouter = Router();

// ─── Crawler self-service endpoints (API key auth) ───────────────

// GET /api/crawlers/whoami — Return own metadata
selfServiceCrawlersRouter.get('/crawlers/whoami', (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.crawler);
});

// POST /api/crawlers/rotate — Rotate own key
selfServiceCrawlersRouter.post('/crawlers/rotate', async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  try {
    const pool = await db.getPool();
    const apiKey = generateApiKey();
    const salt = crypto.randomBytes(32);
    const hash = hashKey(apiKey, salt);
    const prefix = apiKey.slice(0, 8);

    await pool.query(
      `UPDATE "Crawlers"
              SET "apiKeyHash" = $1, "apiKeySalt" = $2, "apiKeyPrefix" = $3,
                  "lastRotatedAt" = (now() AT TIME ZONE 'utc')
              WHERE id = $4`,
      [hash, salt, prefix, req.crawler.id]
    );

    // Log rotation
    await pool.query(
      `INSERT INTO "CrawlerAuditLog" ("crawlerId", action, "statusCode", "ipAddress")
              VALUES ($1, 'key_rotated', 200, $2)`,
      [req.crawler.id, (req.ip || '').slice(0, 45)]
    );

    res.json({
      apiKey,
      apiKeyPrefix: prefix,
      rotatedAt: new Date().toISOString(),
      message: 'Store this API key securely. The previous key is now invalid.',
    });
  } catch (err) {
    console.error('Error rotating crawler key:', err.message);
    res.status(500).json({ error: 'Failed to rotate key' });
  }
});

// POST /api/crawlers/job-progress — Crawlers report fine-grained progress here.
// The body merges into CrawlerJobs.progress so the UI can show what the crawler
// is doing right now ("Group memberships: 1500 of 9633") instead of sitting on the
// last big-step update from the worker dispatcher.
selfServiceCrawlersRouter.post('/crawlers/job-progress', async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const { jobId, step, pct, detail } = req.body || {};
  const id = parseInt(jobId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'jobId must be a positive integer' });
  }

  // Length caps so a misbehaving crawler can't fill the column with junk
  const safeStep   = step   != null ? String(step).slice(0, 200)   : null;
  const safeDetail = detail != null ? String(detail).slice(0, 500) : null;
  const safePct    = (typeof pct === 'number' && pct >= 0 && pct <= 100) ? Math.round(pct) : null;

  try {
    const pool = await db.getPool();
    // Read existing progress, merge in the new fields, write back. Doing the merge
    // server-side keeps the crawler's payload tiny — it only sends what changed.
    const cur = await pool.query(`SELECT progress, status FROM "CrawlerJobs" WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
    if (cur.rows[0].status !== 'running' && cur.rows[0].status !== 'queued') {
      // Don't keep updating finished/failed/cancelled jobs
      return res.status(409).json({ error: `Job is ${cur.rows[0].status}` });
    }

    let merged = {};
    try { if (cur.rows[0].progress) merged = JSON.parse(cur.rows[0].progress); }
    catch { merged = {}; }

    if (safeStep   !== null) merged.step   = safeStep;
    if (safePct    !== null) merged.pct    = safePct;
    if (safeDetail !== null) merged.detail = safeDetail;
    merged.updatedAt = new Date().toISOString();

    await pool.query(`UPDATE "CrawlerJobs" SET progress = $1 WHERE id = $2`, [JSON.stringify(merged), id]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Job progress update failed:', err.message);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

// ─── Worker job-claiming endpoints ──────────────────────────────────────────
// In v5 the worker container has no database access. It calls these endpoints
// to claim and complete jobs. The web container handles all SQL.
//
// Auth: crawler API key (the built-in worker holds the only valid one).
//
// Security (SEC-NEW-2): these job-orchestration endpoints are the web<->worker
// protocol. /claim in particular returns the vaulted clientSecret (injectJobSecret),
// so any valid fgc_ key could otherwise drain the queue and harvest another
// system's Graph credentials. Restrict them to the privileged worker: the
// built-in worker holds the 'admin' crawler permission; external ingest-only
// keys (default ['ingest']) are rejected. Crawlers that only push data use
// /api/ingest, not this protocol.
function requireWorkerCrawler(req, res, next) {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!crawlerHasPermission(req, 'admin')) {
    return res.status(403).json({ error: 'This endpoint requires a worker crawler key' });
  }
  next();
}

selfServiceCrawlersRouter.post('/crawlers/jobs/claim', requireWorkerCrawler, async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  // Piggyback worker-version reporting on the regular claim poll (every ~30s):
  // the worker has no DB access, so this header is how the app learns which
  // version the worker is running, for skew detection on Admin → Updates.
  // Best-effort and fire-and-forget — it must never block or fail the claim.
  const workerVersion = req.get('X-Worker-Version');
  if (workerVersion) recordComponentVersion('worker', workerVersion).catch(() => {});

  try {
    // Atomic claim using FOR UPDATE SKIP LOCKED — postgres-native pattern that
    // lets multiple workers (if we ever scale out) safely contend for the next
    // queued job without double-pickup.
    const r = await db.query(`
      WITH next_job AS (
        SELECT id FROM "CrawlerJobs"
         WHERE "status" = 'queued'
         ORDER BY "createdAt" ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE "CrawlerJobs" cj
         SET "status" = 'running', "startedAt" = (now() AT TIME ZONE 'utc')
        FROM next_job
       WHERE cj.id = next_job.id
       RETURNING cj.id, cj."jobType", cj."config"
    `);
    if (r.rows.length === 0) {
      return res.json({ job: null });
    }
    // Inject the Graph clientSecret (from the vault) into the config handed to
    // the authenticated worker — it is never stored in plaintext in the job row.
    const job = r.rows[0];
    job.config = await injectJobSecret(job);
    res.json({ job });
  } catch (err) {
    console.error('Job claim failed:', err.message);
    res.status(500).json({ error: 'Failed to claim job' });
  }
});

// POST /api/crawlers/configs/:id/mark-delta-mode — Called by the worker
// dispatcher after a successful FULL sync to flip the config back to
// delta-mode-next-run. Operators explicitly request a full sync via the
// UI (setting nextRunMode='full'); once that full run lands successfully,
// we auto-reset so the subsequent scheduled run uses the fast delta path.
selfServiceCrawlersRouter.post('/crawlers/configs/:id/mark-delta-mode', requireWorkerCrawler, async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid config id' });
  try {
    await db.query(
      `UPDATE "CrawlerConfigs" SET "nextRunMode" = 'delta' WHERE id = $1`,
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('mark-delta-mode failed:', err.message);
    res.status(500).json({ error: 'Failed to update run mode' });
  }
});

// ─── Delta-token persistence (Graph /delta endpoints) ──────────────────────
// Crawlers use Graph's /users/delta, /groups/delta, /servicePrincipals/delta
// to fetch only what changed since the last call. Graph hands back an
// `@odata.deltaLink` on the last page; we persist the token portion here and
// give it back on the next run. Tokens are scoped to (systemId, endpoint)
// since the exact query shape ($select etc.) is baked into the token.
//
// Lifecycle:
//   - No row for (system, endpoint) → crawler does a full fetch (no token).
//   - Successful full/delta fetch   → crawler PUTs the new token.
//   - Graph 410/400 on stored token → crawler DELETEs the row and retries full.
//   - Operator forces full resync   → config.nextRunMode='full' triggers the
//                                     crawler to DELETE the token at phase start.
selfServiceCrawlersRouter.get('/crawlers/delta-tokens/:endpoint', async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const systemId = parseInt(req.query.systemId, 10);
  if (!Number.isInteger(systemId) || systemId <= 0) {
    return res.status(400).json({ error: 'systemId query param required' });
  }
  // Security (SEC-NEW-3): scope delta tokens to systems this crawler may access.
  // The built-in worker (systemIds=null) keeps full access; a system-scoped
  // external crawler can no longer read another system's token.
  if (!crawlerHasSystemAccess(req, systemId)) {
    return res.status(403).json({ error: 'Crawler not authorized for this system' });
  }
  // Permit alphanumerics + / - . : _ — matches Graph endpoint path fragments.
  const endpoint = String(req.params.endpoint || '');
  if (!/^[a-zA-Z0-9/_\-.:]+$/.test(endpoint) || endpoint.length > 200) {
    return res.status(400).json({ error: 'Invalid endpoint format' });
  }
  try {
    const r = await db.query(
      `SELECT "token", "lastSyncAt", "recordsLastSeen"
         FROM "DeltaTokens"
        WHERE "systemId" = $1 AND "endpoint" = $2`,
      [systemId, endpoint]
    );
    if (r.rows.length === 0) return res.json({ token: null, lastSyncAt: null });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Delta-token read failed:', err.message);
    res.status(500).json({ error: 'Failed to read delta token' });
  }
});

selfServiceCrawlersRouter.put('/crawlers/delta-tokens/:endpoint', async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const endpoint = String(req.params.endpoint || '');
  if (!/^[a-zA-Z0-9/_\-.:]+$/.test(endpoint) || endpoint.length > 200) {
    return res.status(400).json({ error: 'Invalid endpoint format' });
  }
  const { systemId, token, recordsLastSeen } = req.body || {};
  const sid = parseInt(systemId, 10);
  if (!Number.isInteger(sid) || sid <= 0) return res.status(400).json({ error: 'systemId is required' });
  // Security (SEC-NEW-3): scope delta-token writes to systems this crawler may access.
  if (!crawlerHasSystemAccess(req, sid)) return res.status(403).json({ error: 'Crawler not authorized for this system' });
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token is required' });
  // Graph delta tokens run a few KB. Cap at 64 KB to catch runaway payloads
  // while still accommodating the nested $select/$filter tokens Graph hands out.
  if (token.length > 64 * 1024) return res.status(400).json({ error: 'token too large' });
  const seen = Number.isInteger(recordsLastSeen) && recordsLastSeen >= 0 ? recordsLastSeen : null;
  try {
    await db.query(
      `INSERT INTO "DeltaTokens" ("systemId", "endpoint", "token", "lastSyncAt", "recordsLastSeen")
       VALUES ($1, $2, $3, (now() AT TIME ZONE 'utc'), $4)
       ON CONFLICT ("systemId", "endpoint") DO UPDATE
          SET "token" = EXCLUDED."token",
              "lastSyncAt" = EXCLUDED."lastSyncAt",
              "recordsLastSeen" = EXCLUDED."recordsLastSeen"`,
      [sid, endpoint, token, seen]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Delta-token write failed:', err.message);
    res.status(500).json({ error: 'Failed to write delta token' });
  }
});

selfServiceCrawlersRouter.delete('/crawlers/delta-tokens/:endpoint', async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const systemId = parseInt(req.query.systemId, 10);
  if (!Number.isInteger(systemId) || systemId <= 0) return res.status(400).json({ error: 'systemId query param required' });
  // Security (SEC-NEW-3): scope delta-token deletes to systems this crawler may access.
  if (!crawlerHasSystemAccess(req, systemId)) return res.status(403).json({ error: 'Crawler not authorized for this system' });
  const endpoint = String(req.params.endpoint || '');
  if (!/^[a-zA-Z0-9/_\-.:]+$/.test(endpoint) || endpoint.length > 200) {
    return res.status(400).json({ error: 'Invalid endpoint format' });
  }
  try {
    await db.query(
      `DELETE FROM "DeltaTokens" WHERE "systemId" = $1 AND "endpoint" = $2`,
      [systemId, endpoint]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Delta-token delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete delta token' });
  }
});

// POST /api/crawlers/jobs/:id/phases — Crawlers write the structured per-phase
// outcome here at end-of-run. This is what drives the "Details" drawer in the
// Sync Log / Jobs UI. Called once just before the crawler returns (or throws)
// so the data lands regardless of whether the scheduler ends up in `/complete`
// or `/fail`. Idempotent: a re-call replaces the previous phases array.
selfServiceCrawlersRouter.post('/crawlers/jobs/:id/phases', requireWorkerCrawler, async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid job id' });

  const phases = req.body?.phases;
  if (!Array.isArray(phases)) {
    return res.status(400).json({ error: 'phases must be an array' });
  }
  // Cap at 200 entries and trim string fields so a runaway crawler can't
  // blow up the row. Per-phase shape is loose on purpose — the UI renders
  // whatever fields are present.
  if (phases.length > 200) {
    return res.status(400).json({ error: 'phases cannot exceed 200 entries' });
  }

  try {
    await db.query(
      `UPDATE "CrawlerJobs" SET "phases" = $2::jsonb WHERE id = $1`,
      [id, JSON.stringify(phases)]
    );
    res.json({ ok: true, count: phases.length });
  } catch (err) {
    console.error('Job phases write failed:', err.message);
    res.status(500).json({ error: 'Failed to write phases' });
  }
});

selfServiceCrawlersRouter.post('/crawlers/jobs/:id/complete', requireWorkerCrawler, async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid job id' });

  const { result } = req.body || {};
  try {
    await db.query(
      `UPDATE "CrawlerJobs"
          SET "status" = 'completed',
              "completedAt" = (now() AT TIME ZONE 'utc'),
              "result" = COALESCE($2::jsonb, "result")
        WHERE id = $1`,
      [id, result ? JSON.stringify(result) : null]
    );
    deleteJobSecret(id).catch(() => {}); // best-effort cleanup of any inline-job secret
    // Run the post-crawl derived-data jobs (account linking → context plugins → risk
    // scoring) in order, each to completion before the next — see postCrawlJobs.js.
    // Fire-and-forget so /complete returns immediately; the pipeline is ordered.
    runPostCrawlJobs('crawl-complete').catch((e) => console.error('[post-crawl]', e.message));
    res.json({ ok: true });
  } catch (err) {
    console.error('Job complete failed:', err.message);
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

selfServiceCrawlersRouter.post('/crawlers/jobs/:id/fail', requireWorkerCrawler, async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid job id' });

  const errorMessage = req.body?.errorMessage ? String(req.body.errorMessage).slice(0, 4000) : null;
  try {
    await db.query(
      `UPDATE "CrawlerJobs"
          SET "status" = 'failed',
              "completedAt" = (now() AT TIME ZONE 'utc'),
              "errorMessage" = $2
        WHERE id = $1`,
      [id, errorMessage]
    );
    deleteJobSecret(id).catch(() => {}); // best-effort cleanup of any inline-job secret
    res.json({ ok: true });
  } catch (err) {
    console.error('Job fail failed:', err.message);
    res.status(500).json({ error: 'Failed to mark job failed' });
  }
});


export { selfServiceCrawlersRouter };
