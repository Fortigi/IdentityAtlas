// Crawler-config CRUD endpoints — /api/admin/crawler-configs[...].
//
// Extracted verbatim from routes/jobs.js (audit finding C1). Mounted by
// routes/jobs.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { deleteConfigFolder } from '../crawlerFiles.js';
import { storeConfigSecret, deleteConfigSecret } from '../../secrets/crawlerSecrets.js';
import { validateStoredCrawlerConfig, isPushModeType } from '../../crawlerManifests.js';
import { gate, useSql, SECRET_MASK, maskedConfigForResponse, mergeConfigForUpdate } from './helpers.js';

const router = Router();

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

export default router;
