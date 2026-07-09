// Admin settings endpoints — /api/admin/features/toggle (feature-flag override,
// persisted in WorkerConfig) and /api/admin/auth-settings (read-only auth snapshot).
//
// Extracted verbatim from routes/admin.js (audit finding C1). Mounted by
// routes/admin.js via router.use(), so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { requirePermission } from '../../middleware/auth.js';
import { getAuthState } from '../../config/authConfig.js';

const router = Router();

const writeFeatures = requirePermission('admin.feature-flags');
const writeAuth     = requirePermission('admin.auth');

// ─── Feature flag toggle (persisted in WorkerConfig) ─────────────────────────
// POST /api/admin/features/toggle  body: { feature: 'riskScoring'|'accountLinking', enabled: boolean }
//
// Stores the override in WorkerConfig as FEATURE_<UPPER_SNAKE>. The /api/features
// endpoint reads this and overrides the matching env var. Survives container restarts.
router.post('/admin/features/toggle', writeFeatures, async (req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  const { feature, enabled } = req.body || {};
  const VALID = { riskScoring: 'FEATURE_RISK_SCORING', accountLinking: 'FEATURE_ACCOUNT_LINKING' };
  const key = VALID[feature];
  if (!key) return res.status(400).json({ error: `feature must be one of: ${Object.keys(VALID).join(', ')}` });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  try {
    await db.query(
      `INSERT INTO "WorkerConfig" ("configKey", "configValue")
       VALUES ($1, $2)
       ON CONFLICT ("configKey") DO UPDATE
         SET "configValue" = EXCLUDED."configValue",
             "updatedAt"   = now() AT TIME ZONE 'utc'`,
      [key, enabled ? 'true' : 'false']
    );
    res.json({ feature, enabled });
  } catch (err) {
    console.error('Feature toggle failed:', err.message);
    res.status(500).json({ error: 'Feature toggle failed' });
  }
});
// ─── Authentication settings (read-only) ────────────────────────────────────
// Returns the current snapshot so the Admin → Authentication page can show
// status. There is intentionally NO mutation endpoint — changing auth requires
// `docker compose exec web node /app/backend/src/cli/auth-config.js`. This
// avoids the chicken-and-egg of an unauthenticated mutation surface (the only
// time you'd ever need to change auth from inside the app is when you're
// not signed in yet, which would require leaving the API write-open).
router.get('/admin/auth-settings', writeAuth, (req, res) => {
  const s = getAuthState();
  // WEBSITE_SITE_NAME is set automatically by Azure App Service. Use it to
  // render Azure-appropriate CLI instructions instead of `docker compose exec`.
  const platform = process.env.WEBSITE_SITE_NAME ? 'azure-app-service' : 'docker';
  res.json({
    enabled:       s.enabled,
    tenantId:      s.tenantId || '',
    clientId:      s.clientId || '',
    requiredRoles: s.requiredRoles || [],
    loaded:        s.loaded,
    platform,
    azureWebAppName: process.env.WEBSITE_SITE_NAME || null,
    azureResourceGroup: process.env.WEBSITE_RESOURCE_GROUP || null,
  });
});

export default router;
