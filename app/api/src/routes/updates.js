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
import { ALL_PERMISSION_KEYS } from '../auth/permissions.js';
import { resolveChannel, getCurrentVersion } from '../updates/channel.js';
import { runUpdateCheck, recordLog } from '../updates/checkForUpdates.js';
import { isNewer, isValidVersion } from '../updates/versionCompare.js';
import { getComponentVersion, computeSkew } from '../updates/componentVersions.js';

const router = Router();
const writeUpdates = requirePermission('admin.systems');
// Status + history are the Admin → Updates tab (admin.systems) (SEC-2026-09 M-01).
const readUpdates = writeUpdates;
// The apply agent polls intent with an fgr_ read token, which passes this gate.
const readIntent = requirePermission(...ALL_PERMISSION_KEYS);
const AUTO_UPDATE_KEY = 'AUTO_UPDATE_ENABLED';

// "Latest version" comes from the app's own checks (scheduler / manual /
// auto-detected), never from what an agent reported via /admin/updates/record:
// an agent row describes an apply attempt, and letting it steer intent would
// let one bad report trigger a redeploy (SEC-2026-09 L-12).
const LATEST_CHECK_SQL =
  `SELECT * FROM "UpdateLog" WHERE "source" IS DISTINCT FROM 'agent' ORDER BY "createdAt" DESC LIMIT 1`;

// How long the current version can sit "available" with auto-update on and no
// install before we flag that nothing is applying it (a best-effort honesty
// signal until the apply-agent heartbeat lands). One agent window is nightly, so
// a couple of days means at least one window passed with nothing happening.
const APPLY_STALL_MS = 2 * 24 * 60 * 60 * 1000;

async function getAutoUpdateEnabled() {
  const r = await db.queryOne(
    `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
    [AUTO_UPDATE_KEY]
  );
  return r ? r.configValue === 'true' : false;
}

router.get('/admin/updates/status', readUpdates, async (_req, res) => {
  try {
    const runningVersion = getCurrentVersion();
    const [enabled, last, workerRow, dbRow] = await Promise.all([
      getAutoUpdateEnabled(),
      db.queryOne(LATEST_CHECK_SQL),
      getComponentVersion('worker'),
      getComponentVersion('database'),
    ]);
    const latestVersion = last?.latestVersion || null;
    // The DB's stamped schema version (set after migrations complete). Compared to
    // the running web version the same way worker is — Matched / Mismatch, with
    // `ahead` distinguishing a rollback (DB newer than the running code).
    const dbVersion = dbRow?.version || null;
    const database = {
      version: dbVersion,
      mismatch: !!(dbVersion && runningVersion && dbVersion !== runningVersion),
      ahead: !!(dbVersion && runningVersion && isNewer(dbVersion, runningVersion)),
    };
    // Recompute against the running version rather than trusting the stored
    // boolean (see /updates/intent) so the UI never shows a stale "available".
    const updateAvailable = !!(latestVersion && isNewer(latestVersion, runningVersion));
    const skew = computeSkew(runningVersion, workerRow);

    // "Auto-update is on but nothing is applying": the current version has been
    // advertised as available longer than the stall window with no install. A
    // best-effort honesty signal until the apply-agent heartbeat (PR2) makes it
    // precise. Only computed when it could actually fire.
    let applyStalled = false;
    if (enabled && updateAvailable) {
      const since = await db.queryOne(
        `SELECT MIN("createdAt") AS since FROM "UpdateLog"
          WHERE "updateAvailable" = TRUE AND "latestVersion" = $1`,
        [latestVersion]
      );
      applyStalled = !!(since?.since && Date.now() - new Date(since.since).getTime() > APPLY_STALL_MS);
    }

    res.json({
      channel: resolveChannel(),
      currentVersion: runningVersion,
      autoUpdateEnabled: enabled,
      updateAvailable,
      latestVersion,
      lastCheck: last || null,
      components: {
        web: { version: runningVersion },
        worker: {
          version: workerRow?.version || null,
          lastSeenAt: workerRow?.lastSeenAt || null,
          stale: skew.workerStale,
        },
        database,
      },
      skew,
      applyStalled,
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

router.get('/admin/updates/log', readUpdates, async (req, res) => {
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

router.get('/updates/intent', readIntent, async (_req, res) => {
  try {
    const runningVersion = getCurrentVersion();
    const [enabled, last] = await Promise.all([
      getAutoUpdateEnabled(),
      db.queryOne(LATEST_CHECK_SQL),
    ]);
    const latestVersion = last?.latestVersion || null;
    // Recompute against the RUNNING version rather than trusting the last check's
    // stored `updateAvailable`. After an update lands (or a plain restart) the
    // stored row can still read true until the next daily check — which would
    // make an agent re-apply the same tag every run, in a loop.
    const updateAvailable = !!(latestVersion && isNewer(latestVersion, runningVersion));
    res.json({
      autoUpdateEnabled: enabled,
      channel: resolveChannel(),
      currentVersion: runningVersion,
      latestVersion,
      updateAvailable,
      shouldUpdate: enabled && updateAvailable,
    });
  } catch (err) {
    console.error('updates intent failed:', err.message);
    res.status(500).json({ error: 'Failed to read update intent' });
  }
});

// Name of the first supplied-but-malformed version field, or null. Both fields
// stay optional (an agent may not know them); a present one must be a version.
export function invalidVersionField(fields) {
  const bad = Object.entries(fields).find(([, v]) => v != null && v !== '' && !isValidVersion(v));
  return bad ? bad[0] : null;
}

router.post('/admin/updates/record', writeUpdates, async (req, res) => {
  const { status, fromVersion, toVersion, detail } = req.body || {};
  if (!['installed', 'failed', 'applying'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of installed|failed|applying' });
  }
  const badField = invalidVersionField({ fromVersion, toVersion });
  if (badField) {
    return res.status(400).json({ error: `${badField} must be a version like 5.2.1.0 or 5.3.0-beta.1` });
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
