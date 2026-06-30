// Orchestrates one update check and writes the result to UpdateLog.
//
// Two things happen per run:
//  1. Install detection — if the running MODULE_VERSION differs from the version
//     recorded on the previous check, an update was applied (by whatever external
//     agent / manual pull) since we last looked, so we log an 'installed' row.
//     This makes the "installed updates" history work for EVERY apply path
//     without the app needing any Docker privilege.
//  2. Availability check — resolve the channel, ask GitHub for the newest version
//     on it, and log whether we're up-to-date or an update is available.

import * as db from '../db/connection.js';
import { resolveChannel, getCurrentVersion } from './channel.js';
import { getLatestForChannel } from './detect.js';
import { isNewer } from './versionCompare.js';

export async function recordLog(entry, client = db) {
  await client.query(
    `INSERT INTO "UpdateLog"
       ("channel","currentVersion","latestVersion","updateAvailable","status","detail","source")
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.channel,
      entry.currentVersion || null,
      entry.latestVersion || null,
      !!entry.updateAvailable,
      entry.status,
      entry.detail || null,
      entry.source || null,
    ]
  );
}

// Detect that the running version changed since the last check → log it as an
// applied update. Best-effort: never let this throw out of the check.
async function detectInstalled(channel, currentVersion, client = db) {
  if (!currentVersion) return;
  try {
    const prev = await client.query(
      `SELECT "currentVersion" FROM "UpdateLog"
         WHERE "currentVersion" IS NOT NULL
         ORDER BY "createdAt" DESC LIMIT 1`
    );
    const prevVersion = prev.rows?.[0]?.currentVersion;
    if (prevVersion && prevVersion !== currentVersion) {
      await recordLog(
        {
          channel,
          currentVersion: prevVersion,
          latestVersion: currentVersion,
          updateAvailable: false,
          status: 'installed',
          detail: `Updated ${prevVersion} → ${currentVersion}`,
          source: 'auto-detected',
        },
        client
      );
    }
  } catch {
    /* best-effort install detection */
  }
}

export async function runUpdateCheck({ source = 'scheduler', fetchImpl } = {}) {
  const channel = resolveChannel();
  const currentVersion = getCurrentVersion();

  await detectInstalled(channel, currentVersion);

  let latestVersion = null;
  let updateAvailable = false;
  let status = 'up-to-date';
  let detail = null;

  try {
    latestVersion = await getLatestForChannel(channel, fetchImpl);
    if (!latestVersion) {
      status = 'checked';
      detail =
        channel === 'pinned'
          ? 'Pinned to a fixed version — auto-update not applicable'
          : 'No version information available for this channel';
    } else if (currentVersion && isNewer(latestVersion, currentVersion)) {
      updateAvailable = true;
      status = 'available';
    } else {
      status = 'up-to-date';
    }
  } catch (err) {
    status = 'failed';
    detail = err.message;
  }

  await recordLog({ channel, currentVersion, latestVersion, updateAvailable, status, detail, source });
  return { channel, currentVersion, latestVersion, updateAvailable, status, detail };
}
