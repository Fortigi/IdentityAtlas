// Admin crawler-management endpoints (Entra ID auth) — /api/admin/crawlers[...].
//
// Extracted verbatim from routes/crawlers.js (audit finding C1). Re-exported by
// routes/crawlers.js and mounted in app.js exactly as before. No behaviour
// change — pure code move.

import { Router } from 'express';
import crypto from 'crypto';
import { requirePermission } from '../../middleware/auth.js';
import * as db from '../../db/connection.js';
import { getPushModeType } from '../../crawlerManifests.js';
import { useSql, generateApiKey, hashKey } from './shared.js';

const adminCrawlersRouter = Router();
const gate = requirePermission('admin.crawlers');

// In v5 the schema is created by the migrations runner at startup. This
// function is a no-op kept for backward compatibility with the existing callers.
async function ensureCrawlerTables(_pool) { /* no-op in v5 */ }

// ─── Admin endpoints (Entra ID auth) ─────────────────────────────

// GET /api/admin/crawlers — List all crawlers
adminCrawlersRouter.get('/admin/crawlers', gate, async (req, res) => {
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
adminCrawlersRouter.post('/admin/crawlers', gate, async (req, res) => {
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

    // Also creates a paired CrawlerConfigs row for the push-mode crawler type
    // (config={crawlerId}) in the same statement, so this connector shows up as
    // a normal card in the "Configured Crawlers" grid instead of needing its
    // own UI surface. The type is resolved from the manifest (pushMode flag),
    // not hardcoded, so core carries no per-type knowledge (see issue #368).
    // See tools/crawlers/CLAUDE.md -> "Push-mode crawler types" for why these
    // are two tables instead of one.
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
      .input('connectorType', getPushModeType())
      .query(`WITH new_crawler AS (
                INSERT INTO "Crawlers"
                ("displayName", "description", "apiKeyHash", "apiKeySalt", "apiKeyPrefix", "systemIds", "permissions", "createdBy", "expiresAt", "rateLimit")
                VALUES (@displayName, @description, @apiKeyHash, @apiKeySalt, @apiKeyPrefix, @systemIds::jsonb, @permissions::jsonb, @createdBy, @expiresAt, @rateLimit)
                RETURNING id, "displayName", "apiKeyPrefix", "createdAt"
              ), new_config AS (
                INSERT INTO "CrawlerConfigs" ("crawlerType", "displayName", config)
                SELECT @connectorType, "displayName", jsonb_build_object('crawlerId', id) FROM new_crawler
                RETURNING id
              )
              SELECT * FROM new_crawler`);

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
adminCrawlersRouter.patch('/admin/crawlers/:id', gate, async (req, res) => {
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
adminCrawlersRouter.delete('/admin/crawlers/:id', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid crawler ID' });

  const permanent = req.body?.permanent === true;

  try {
    const pool = await db.getPool();

    if (permanent) {
      // CrawlerAuditLog has ON DELETE CASCADE so deleting the parent is enough.
      // Also deletes the paired CrawlerConfigs row created at registration
      // (see POST handler above) so the card disappears from the UI too —
      // mirrors the same cleanup DELETE /admin/crawler-configs/:id does in
      // the other direction (routes/jobs.js).
      const result = await pool.request().input('id', id)
        .input('connectorType', getPushModeType())
        .query(`WITH del_config AS (
                  DELETE FROM "CrawlerConfigs"
                  WHERE "crawlerType" = @connectorType AND (config->>'crawlerId')::int = @id
                )
                DELETE FROM "Crawlers" WHERE id = @id`);
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
adminCrawlersRouter.get('/admin/crawlers/:id/audit', gate, async (req, res) => {
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
adminCrawlersRouter.post('/admin/crawlers/:id/reset', gate, async (req, res) => {
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


export { adminCrawlersRouter };
