// Auto-update API.
//
// The app owns intent + detection + log; a deployment-specific external agent
// (Docker-host cron, Azure scheduled job, local cron) does the privileged apply.
//
//   GET  /api/admin/updates/status  — current version/channel + last check + flag
//   PUT  /api/admin/updates/auto    — flip the AUTO_UPDATE_ENABLED switch
//   GET  /api/admin/updates/log     — the check + install history
//   POST /api/admin/updates/check   — run a check now
//   GET  /api/updates/intent        — what the external agent polls (not /admin so
//                                     a read token can reach it): should I update,
//                                     and to which version?
//   POST /api/admin/updates/record  — agent reports an apply result (optional;
//                                     installs are also auto-detected on version change)

import { Router } from 'express';
import * as db from '../db/connection.js';
import { requirePermission } from '../middleware/auth.js';
import { resolveChannel, getCurrentVersion } from '../updates/channel.js';
import { runUpdateCheck, recordLog } from '../updates/checkForUpdates.js';

const router = Router();
const writeUpdates = requirePermission('admin.systems');
const AUTO_UPDATE_KEY = 'AUTO_UPDATE_ENABLED';

async function getAutoUpdateEnabled() {
  const r = await db.queryOne(
    `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
    [AUTO_UPDATE_KEY]
  );
  return r ? r.configValue === 'true' : false;
}

router.get('/admin/updates/status', async (_req, res) => {
  try {
    const [enabled, last] = await Promise.all([
      getAutoUpdateEnabled(),
      db.queryOne(`SELECT * FROM "UpdateLog" ORDER BY "createdAt" DESC LIMIT 1`),
    ]);
    res.json({
      channel: resolveChannel(),
      currentVersion: getCurrentVersion(),
      autoUpdateEnabled: enabled,
      lastCheck: last || null,
    });
  } catch (err) {
    console.error('updates status failed:', err.message);
    res.status(500).json({ error: 'Failed to read update status' });
  }
});

router.put('/admin/updates/auto', writeUpdates, async (req, res) => {
  const enabled = req.body?.enabled === true;
  try {
    await db.query(
      `INSERT INTO "WorkerConfig" ("configKey","configValue")
       VALUES ($1, $2)
       ON CONFLICT ("configKey") DO UPDATE
         SET "configValue" = EXCLUDED."configValue",
             "updatedAt"   = now() AT TIME ZONE 'utc'`,
      [AUTO_UPDATE_KEY, enabled ? 'true' : 'false']
    );
    res.json({ autoUpdateEnabled: enabled });
  } catch (err) {
    console.error('updates auto toggle failed:', err.message);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

router.get('/admin/updates/log', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  try {
    const r = await db.query(`SELECT * FROM "UpdateLog" ORDER BY "createdAt" DESC LIMIT $1`, [limit]);
    res.json({ data: r.rows });
  } catch (err) {
    console.error('updates log failed:', err.message);
    res.status(500).json({ error: 'Failed to read update log' });
  }
});

router.post('/admin/updates/check', writeUpdates, async (_req, res) => {
  try {
    const result = await runUpdateCheck({ source: 'manual' });
    res.json(result);
  } catch (err) {
    console.error('manual update check failed:', err.message);
    res.status(500).json({ error: 'Update check failed' });
  }
});

router.get('/updates/intent', async (_req, res) => {
  try {
    const [enabled, last] = await Promise.all([
      getAutoUpdateEnabled(),
      db.queryOne(
        `SELECT "latestVersion","updateAvailable" FROM "UpdateLog" ORDER BY "createdAt" DESC LIMIT 1`
      ),
    ]);
    const updateAvailable = !!last?.updateAvailable;
    res.json({
      autoUpdateEnabled: enabled,
      channel: resolveChannel(),
      currentVersion: getCurrentVersion(),
      latestVersion: last?.latestVersion || null,
      updateAvailable,
      shouldUpdate: enabled && updateAvailable,
    });
  } catch (err) {
    console.error('updates intent failed:', err.message);
    res.status(500).json({ error: 'Failed to read update intent' });
  }
});

router.post('/admin/updates/record', writeUpdates, async (req, res) => {
  const { status, fromVersion, toVersion, detail } = req.body || {};
  if (!['installed', 'failed', 'applying'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of installed|failed|applying' });
  }
  try {
    await recordLog({
      channel: resolveChannel(),
      currentVersion: fromVersion || getCurrentVersion(),
      latestVersion: toVersion || null,
      updateAvailable: false,
      status,
      detail: detail || null,
      source: 'agent',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('updates record failed:', err.message);
    res.status(500).json({ error: 'Failed to record update' });
  }
});

export default router;
