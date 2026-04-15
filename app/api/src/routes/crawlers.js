import { Router } from 'express';
import crypto from 'crypto';
import * as db from '../db/connection.js';

const adminCrawlersRouter = Router();
const selfServiceCrawlersRouter = Router();
const useSql = process.env.USE_SQL === 'true';

const KEY_PREFIX = 'fgc_';
const KEY_RANDOM_BYTES = 32;

function generateApiKey() {
  const random = crypto.randomBytes(KEY_RANDOM_BYTES).toString('hex');
  return `${KEY_PREFIX}${random}`;
}

function hashKey(apiKey, salt) {
  return crypto.createHash('sha256').update(Buffer.concat([salt, Buffer.from(apiKey, 'utf8')])).digest();
}

// In v5 the schema is created by the migrations runner at startup. This
// function is a no-op kept for backward compatibility with the existing
// callers — it used to lazily CREATE TABLE on first request.
async function ensureCrawlerTables(_pool) { /* no-op in v5 */ }

// ─── Admin endpoints (Entra ID auth) ─────────────────────────────

// GET /api/admin/crawlers — List all crawlers
adminCrawlersRouter.get('/admin/crawlers', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    await ensureCrawlerTables(pool);
    const result = await pool.request().query(`
      SELECT id, "displayName", description, "apiKeyPrefix", "systemIds", permissions,
             enabled, "createdAt", "createdBy", "lastUsedAt", "lastRotatedAt", "expiresAt", "rateLimit"
      FROM "Crawlers"
      ORDER BY "createdAt" DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Error listing crawlers:', err.message);
    res.status(500).json({ error: 'Failed to list crawlers' });
  }
});

// POST /api/admin/crawlers — Register a new crawler
adminCrawlersRouter.post('/admin/crawlers', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { displayName, description, systemIds, permissions, expiresAt, rateLimit } = req.body;

  if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
    return res.status(400).json({ error: 'displayName is required' });
  }

  try {
    const pool = await db.getPool();
    await ensureCrawlerTables(pool);

    const apiKey = generateApiKey();
    const salt = crypto.randomBytes(32);
    const hash = hashKey(apiKey, salt);
    const prefix = apiKey.slice(0, 8);
    const createdBy = req.user?.preferred_username || req.user?.name || 'system';

    const result = await pool.request()
      .input('displayName', displayName.trim().slice(0, 255))
      .input('description', (description || '').slice(0, 4000))
      .input('apiKeyHash', hash)
      .input('apiKeySalt', salt)
      .input('apiKeyPrefix', prefix)
      .input('systemIds', systemIds ? JSON.stringify(systemIds) : null)
      .input('permissions', JSON.stringify(permissions || ['ingest']))
      .input('createdBy', createdBy)
      .input('expiresAt', expiresAt || null)
      .input('rateLimit', rateLimit || 100)
      .query(`INSERT INTO "Crawlers"
              ("displayName", "description", "apiKeyHash", "apiKeySalt", "apiKeyPrefix", "systemIds", "permissions", "createdBy", "expiresAt", "rateLimit")
              VALUES (@displayName, @description, @apiKeyHash, @apiKeySalt, @apiKeyPrefix, @systemIds::jsonb, @permissions::jsonb, @createdBy, @expiresAt, @rateLimit)
              RETURNING id, "displayName", "apiKeyPrefix", "createdAt"`);

    const crawler = result.recordset[0];

    res.status(201).json({
      ...crawler,
      apiKey, // Plaintext key — shown ONCE
      message: 'Store this API key securely. It will not be shown again.',
    });
  } catch (err) {
    console.error('Error registering crawler:', err.message);
    res.status(500).json({ error: 'Failed to register crawler' });
  }
});

// PATCH /api/admin/crawlers/:id — Update crawler metadata
adminCrawlersRouter.patch('/admin/crawlers/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid crawler ID' });

  const { displayName, description, enabled, systemIds, permissions, expiresAt, rateLimit } = req.body;
  const sets = [];
  const request = (await db.getPool()).request().input('id', id);

  if (displayName !== undefined) {
    sets.push('"displayName" = @displayName');
    request.input('displayName', String(displayName).slice(0, 255));
  }
  if (description !== undefined) {
    sets.push('"description" = @description');
    request.input('description', String(description).slice(0, 4000));
  }
  if (enabled !== undefined) {
    sets.push('"enabled" = @enabled');
    request.input('enabled', enabled ? true : false);
  }
  if (systemIds !== undefined) {
    sets.push('"systemIds" = @systemIds');
    request.input('systemIds', systemIds ? JSON.stringify(systemIds) : null);
  }
  if (permissions !== undefined) {
    sets.push('"permissions" = @permissions');
    request.input('permissions', JSON.stringify(permissions));
  }
  if (expiresAt !== undefined) {
    sets.push('"expiresAt" = @expiresAt');
    request.input('expiresAt', expiresAt || null);
  }
  if (rateLimit !== undefined) {
    sets.push('"rateLimit" = @rateLimit');
    request.input('rateLimit', parseInt(rateLimit, 10) || 100);
  }

  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

  try {
    const result = await request.query(`UPDATE "Crawlers" SET ${sets.join(', ')} WHERE id = @id RETURNING *`);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Crawler not found' });
    const row = result.recordset[0];
    // Strip sensitive fields
    const { apiKeyHash, apiKeySalt, ...safe } = row;
    res.json(safe);
  } catch (err) {
    console.error('Error updating crawler:', err.message);
    res.status(500).json({ error: 'Failed to update crawler' });
  }
});

// DELETE /api/admin/crawlers/:id — Disable or permanently remove crawler
adminCrawlersRouter.delete('/admin/crawlers/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid crawler ID' });

  const permanent = req.body?.permanent === true;

  try {
    const pool = await db.getPool();

    if (permanent) {
      // CrawlerAuditLog has ON DELETE CASCADE so deleting the parent is enough
      const result = await pool.request().input('id', id)
        .query('DELETE FROM "Crawlers" WHERE id = @id');
      if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Crawler not found' });
      res.json({ message: 'Crawler permanently removed' });
    } else {
      // Soft delete — just disable
      const result = await pool.request().input('id', id)
        .query('UPDATE "Crawlers" SET enabled = false WHERE id = @id');
      if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Crawler not found' });
      res.json({ message: 'Crawler disabled' });
    }
  } catch (err) {
    console.error('Error deleting crawler:', err.message);
    res.status(500).json({ error: 'Failed to delete crawler' });
  }
});

// GET /api/admin/crawlers/:id/audit — Paginated audit log
adminCrawlersRouter.get('/admin/crawlers/:id/audit', async (req, res) => {
  if (!useSql) return res.json({ data: [], total: 0 });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid crawler ID' });

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const pool = await db.getPool();
    const result = await pool.request()
      .input('id', id)
      .input('limit', limit)
      .input('offset', offset)
      .query(`SELECT action, endpoint, "recordCount", "statusCode", "ipAddress", timestamp
              FROM "CrawlerAuditLog"
              WHERE "crawlerId" = @id
              ORDER BY timestamp DESC
              LIMIT @limit OFFSET @offset;
              SELECT COUNT(*) AS total FROM "CrawlerAuditLog" WHERE "crawlerId" = @id;`);
    res.json({
      data: result.recordsets[0],
      total: result.recordsets[1][0].total,
    });
  } catch (err) {
    console.error('Error fetching audit log:', err.message);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// POST /api/admin/crawlers/:id/reset — Admin-initiated key reset
adminCrawlersRouter.post('/admin/crawlers/:id/reset', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid crawler ID' });

  try {
    const pool = await db.getPool();
    const apiKey = generateApiKey();
    const salt = crypto.randomBytes(32);
    const hash = hashKey(apiKey, salt);
    const prefix = apiKey.slice(0, 8);

    const result = await pool.request()
      .input('id', id)
      .input('apiKeyHash', hash)
      .input('apiKeySalt', salt)
      .input('apiKeyPrefix', prefix)
      .query(`UPDATE "Crawlers"
              SET "apiKeyHash" = @apiKeyHash, "apiKeySalt" = @apiKeySalt, "apiKeyPrefix" = @apiKeyPrefix,
                  "lastRotatedAt" = (now() AT TIME ZONE 'utc')
              WHERE id = @id AND "enabled" = TRUE`);

    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Crawler not found or disabled' });

    res.json({
      apiKey,
      apiKeyPrefix: prefix,
      rotatedAt: new Date().toISOString(),
      message: 'Store this API key securely. It will not be shown again.',
    });
  } catch (err) {
    console.error('Error resetting crawler key:', err.message);
    res.status(500).json({ error: 'Failed to reset key' });
  }
});

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

    await pool.request()
      .input('id', req.crawler.id)
      .input('apiKeyHash', hash)
      .input('apiKeySalt', salt)
      .input('apiKeyPrefix', prefix)
      .query(`UPDATE "Crawlers"
              SET "apiKeyHash" = @apiKeyHash, "apiKeySalt" = @apiKeySalt, "apiKeyPrefix" = @apiKeyPrefix,
                  "lastRotatedAt" = (now() AT TIME ZONE 'utc')
              WHERE id = @id`);

    // Log rotation
    await pool.request()
      .input('crawlerId', req.crawler.id)
      .input('ipAddress', (req.ip || '').slice(0, 45))
      .query(`INSERT INTO "CrawlerAuditLog" ("crawlerId", action, "statusCode", "ipAddress")
              VALUES (@crawlerId, 'key_rotated', 200, @ipAddress)`);

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
    const cur = await pool.request().input('id', id)
      .query(`SELECT progress, status FROM "CrawlerJobs" WHERE id = @id`);
    if (cur.recordset.length === 0) return res.status(404).json({ error: 'Job not found' });
    if (cur.recordset[0].status !== 'running' && cur.recordset[0].status !== 'queued') {
      // Don't keep updating finished/failed/cancelled jobs
      return res.status(409).json({ error: `Job is ${cur.recordset[0].status}` });
    }

    let merged = {};
    try { if (cur.recordset[0].progress) merged = JSON.parse(cur.recordset[0].progress); }
    catch { merged = {}; }

    if (safeStep   !== null) merged.step   = safeStep;
    if (safePct    !== null) merged.pct    = safePct;
    if (safeDetail !== null) merged.detail = safeDetail;
    merged.updatedAt = new Date().toISOString();

    await pool.request()
      .input('id', id)
      .input('progress', JSON.stringify(merged))
      .query(`UPDATE "CrawlerJobs" SET progress = @progress WHERE id = @id`);

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

selfServiceCrawlersRouter.post('/crawlers/jobs/claim', async (req, res) => {
  if (!req.crawler) return res.status(401).json({ error: 'Not authenticated' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

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
    res.json({ job: r.rows[0] });
  } catch (err) {
    console.error('Job claim failed:', err.message);
    res.status(500).json({ error: 'Failed to claim job' });
  }
});

selfServiceCrawlersRouter.post('/crawlers/jobs/:id/complete', async (req, res) => {
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
    res.json({ ok: true });
  } catch (err) {
    console.error('Job complete failed:', err.message);
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

selfServiceCrawlersRouter.post('/crawlers/jobs/:id/fail', async (req, res) => {
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
    res.json({ ok: true });
  } catch (err) {
    console.error('Job fail failed:', err.message);
    res.status(500).json({ error: 'Failed to mark job failed' });
  }
});

export { adminCrawlersRouter, selfServiceCrawlersRouter };
