// Sign-in activity for one principal — the query behind GET /api/user/:id/activity.
//
// Reads the generic `PrincipalActivity` table, not anything Entra-shaped: any
// crawler posting to `ingest/principal-activity` shows up here. The aggregate
// row carries the three core timestamps (plus whatever extra flavours the
// source had, in `extendedAttributes` — the service-principal report's
// application-auth and delegated-client variants land there); the per-app rows
// answer "when did this account last use app X?".
//
// Every timestamp travels with `measuredAt`, because a sign-in time without its
// measurement moment is actively misleading: someone who signed in an hour ago
// reads as untouched for weeks if the last crawl was weeks ago.

import * as db from '../../db/connection.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { aggregateRowWhere, PER_APP_ACTIVITY_TYPE } from '../../lib/principalActivity.js';

/**
 * @returns {Promise<{aggregates: Object[], perApp: Object[]}>} both lists,
 *          empty when the principal has no activity at all — "no activity
 *          recorded" is a normal state, not an error.
 */
export async function fetchPrincipalActivity(principalId) {
  const [aggregate, perApp] = await Promise.all([
    db.query(`
      SELECT pa."activityType", pa."lastSignInDateTime", pa."lastNonInteractiveSignInDateTime",
             pa."lastSuccessfulSignInDateTime", pa."lastFailedSignInDateTime",
             pa."signInCount", pa."extendedAttributes", pa."updatedAt" AS "measuredAt"
        FROM "PrincipalActivity" pa
       WHERE pa."principalId"::text = $1 AND ${aggregateRowWhere('pa')}
       ORDER BY pa."activityType"`, [principalId]),
    // The per-app resourceId is the app's service principal, which lives in
    // Principals (an SP represents an app in Entra) — but it may also be a
    // Resources row for other sources, so both are tried before falling back to
    // the raw id. LEFT JOINs so an app we never crawled still lists its usage.
    db.query(`
      SELECT pa."resourceId",
             COALESCE(sp."displayName", r."displayName") AS "appDisplayName",
             pa."lastSignInDateTime", pa."lastSuccessfulSignInDateTime",
             pa."signInCount", pa."updatedAt" AS "measuredAt"
        FROM "PrincipalActivity" pa
        LEFT JOIN "Principals" sp ON sp.id = pa."resourceId"
        LEFT JOIN "Resources"  r  ON r.id  = pa."resourceId"
       WHERE pa."principalId"::text = $1 AND pa."activityType" = $2
       ORDER BY pa."lastSignInDateTime" DESC NULLS LAST`, [principalId, PER_APP_ACTIVITY_TYPE]),
  ]);

  return {
    aggregates: aggregate.rows.map(row => ({
      ...row,
      extendedAttributes: parseJsonbColumn(row.extendedAttributes),
    })),
    perApp: perApp.rows.map(row => ({
      ...row,
      appDisplayName: row.appDisplayName || null,
    })),
  };
}
