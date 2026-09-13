// Crawler-config CRUD endpoints — /api/admin/crawler-configs[...].
//
// Extracted verbatim from routes/jobs.js (audit finding C1). Mounted by
// routes/jobs.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { createParams } from '../../db/sqlParams.js';
import { deleteConfigFolder } from '../crawlerFiles.js';
import { storeConfigFields, deleteConfigSecrets, vaultedConfigFields } from '../../secrets/crawlerSecrets.js';
import { validateStoredCrawlerConfig, isPushModeType, isExperimentalType, hostBearingFields } from '../../crawlerManifests.js';
import { isFeatureEnabled } from '../../featureFlags.js';
import {
  gate, useSql, maskedConfigForResponse, mergeConfigForUpdate, splitConfigSecrets,
  changedHostFields, credentialReentryError,
} from './helpers.js';

const router = Router();

// GET /api/admin/crawler-configs — List all configs (secrets masked)
router.get('/admin/crawler-configs', gate, async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const result = await pool.query(
      `SELECT * FROM "CrawlerConfigs" WHERE "enabled" = TRUE ORDER BY "createdAt" DESC`
    );
    const configs = await Promise.all(result.rows.map(async r => ({
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

  // Experimental crawler types can only be added while the feature flag is on.
  // This is the enforcement point for the Add-Crawler picker's filter — turning
  // the flag off must stop NEW configs being created, never break existing ones,
  // so nothing here touches update, run or delete. See featureFlags.js.
  if (isExperimentalType(crawlerType) && !(await isFeatureEnabled('experimentalCrawlers'))) {
    return res.status(403).json({
      error: `'${crawlerType}' is an experimental crawler. Enable Admin → Experimental → Experimental crawlers to add one.`,
    });
  }

  try {
    // Strip every credential field out of the stored JSON — they go to the
    // vault, one row per field (SEC-2026-09 M-10).
    const { rest: incoming, secrets } = splitConfigSecrets(config);

    const pool = await db.getPool();
    const result = await pool.query(
      `INSERT INTO "CrawlerConfigs" ("crawlerType", "displayName", config)
              VALUES ($1, $2, $3)
              RETURNING *`,
      [crawlerType, displayName.trim().slice(0, 255), JSON.stringify(incoming)]
    );

    const row = result.rows[0];
    await storeConfigFields(row.id, secrets);
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
    const result = await pool.query(`SELECT * FROM "CrawlerConfigs" WHERE id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Config not found' });
    const row = result.rows[0];
    res.json({ ...row, config: await maskedConfigForResponse(row.id, row.config) });
  } catch (err) {
    console.error('Error fetching crawler config:', err.message);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// SEC-2026-09 M-02: refuse an edit that moves a host-bearing field (baseUrl,
// tokenEndpoint, any URL-typed manifest field) to a different scheme/host while
// keeping a credential already stored for this config. Returns { status, body }
// or null.
async function checkCredentialCustody(id, crawlerType, existingConfig, mergedConfig, newSecrets, keptFields) {
  const changed = changedHostFields(hostBearingFields(crawlerType), existingConfig, mergedConfig);
  if (changed.length === 0) return null;
  const vaulted = await vaultedConfigFields(id);
  const keptStored = keptFields.filter(f => vaulted.includes(f) || newSecrets[f]);
  return credentialReentryError(changed, keptStored);
}

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
    const existing = await pool.query(`SELECT config, "crawlerType" FROM "CrawlerConfigs" WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Config not found' });

    const { mergedConfig, newSecrets, keptFields } = mergeConfigForUpdate(existing.rows[0].config, config);

    const crawlerType = existing.rows[0].crawlerType;
    if (config) {
      const custodyErr = await checkCredentialCustody(id, crawlerType, existing.rows[0].config, mergedConfig, newSecrets, keptFields);
      if (custodyErr) return res.status(custodyErr.status).json(custodyErr.body);
      // mergedConfig never carries credential fields — use the vault-aware
      // validator so a schema that requires one doesn't reject an edit that
      // doesn't touch credentials. Newly entered values count as present.
      const configErr = await validateStoredCrawlerConfig(crawlerType, { ...mergedConfig, ...newSecrets }, id);
      if (configErr) return res.status(400).json({ error: configErr });
    }

    const { params, bind } = createParams();
    const sets = [`config = ${bind(JSON.stringify(mergedConfig))}`, '"updatedAt" = now()'];

    if (displayName !== undefined) {
      sets.push(`"displayName" = ${bind(displayName.trim().slice(0, 255))}`);
    }

    if (nextRunMode !== undefined) {
      sets.push(`"nextRunMode" = ${bind(nextRunMode)}`);
    }

    const result = await pool.query(
      `UPDATE "CrawlerConfigs" SET ${sets.join(', ')} WHERE id = ${bind(id)} RETURNING *`,
      params
    );
    const row = result.rows[0];
    await storeConfigFields(id, newSecrets);
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
    const existing = await pool.query(`SELECT "crawlerType", config FROM "CrawlerConfigs" WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Config not found' });
    const { crawlerType, config: existingConfig } = existing.rows[0];
    const result = await pool.query(`DELETE FROM "CrawlerConfigs" WHERE id = $1`, [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Config not found' });
    // Best-effort cleanup of any uploaded files + the vaulted secret.
    deleteConfigFolder(crawlerType, id).catch(() => {});
    deleteConfigSecrets(id).catch(() => {});
    // A push-mode type's card is a CrawlerConfigs row paired with a Crawlers
    // row (the API key) created together in routes/crawlers.js's POST
    // handler — clean up the other side too so removing the card doesn't
    // orphan a still-live API key.
    if (isPushModeType(crawlerType)) {
      const crawlerId = (typeof existingConfig === 'string' ? JSON.parse(existingConfig) : existingConfig)?.crawlerId;
      if (crawlerId) {
        pool.query(`DELETE FROM "Crawlers" WHERE id = $1`, [crawlerId]).catch(() => {});
      }
    }
    res.json({ message: 'Config removed' });
  } catch (err) {
    console.error('Error removing crawler config:', err.message);
    res.status(500).json({ error: 'Failed to remove config' });
  }
});

export default router;
