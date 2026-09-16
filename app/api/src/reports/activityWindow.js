// The measurement moment: what every activity-based report counts back from.
//
// Sign-in activity is a SNAPSHOT, not a stream. `PrincipalActivity` holds the
// timestamps a crawler last read out of the source system, and `updatedAt` says
// when it read them. Counting "stale for 90 days" back from *today* therefore
// answers the wrong question the moment a sync is missed: everyone silently
// ages into staleness because the data stopped moving, not because the people
// did. So the window is anchored to the data's own measurement moment, per
// system, and the report says so out loud.
//
// Shared by every template whose finding is "not used since …", so the anchor,
// the SQL and the wording can't drift between them. The table-reading
// primitives themselves live in lib/principalActivity.js, which the list and
// detail surfaces share.

import * as db from '../db/connection.js';
import { toDateOnly } from '../lib/dateOnly.js';
import { AGG_RESOURCE_ID, AGGREGATE_ACTIVITY_TYPES } from '../lib/principalActivity.js';

/** Older than this and the measurement itself is the finding. */
export const MEASUREMENT_WARNING_DAYS = 2;

const MS_PER_DAY = 86400000;

/**
 * SQL for a CTE body yielding one row per system that HAS activity data:
 * `("systemId", "measuredAt")`. Joined into a report's main query so staleness
 * is evaluated per system in one round trip — and so a system with no activity
 * simply drops out of the join instead of having all its accounts declared
 * stale.
 *
 * Constant-folded rather than parameterised: both values are engine constants,
 * so there is no user input to bind and callers keep their own `$n` numbering.
 */
export function measurementCte() {
  const types = AGGREGATE_ACTIVITY_TYPES.map(t => `'${t}'`).join(', ');
  return `
    SELECT p."systemId", MAX(pa."updatedAt") AS "measuredAt"
      FROM "PrincipalActivity" pa
      JOIN "Principals" p ON p.id = pa."principalId"
     WHERE pa."resourceId" = '${AGG_RESOURCE_ID}'::uuid
       AND pa."activityType" IN (${types})
       AND p."systemId" IS NOT NULL
     GROUP BY p."systemId"`;
}

/**
 * Every system holding principals, with its measurement moment or null when it
 * has none. Drives the notices; the reports join `measurementCte()` directly.
 *
 * @returns {Promise<{systemName: string, measuredAt: Date|null}[]>} ordered by name.
 */
export async function fetchMeasurementMoments() {
  const r = await db.query(`
    WITH measurement AS (${measurementCte()})
    SELECT s."displayName" AS "systemName", m."measuredAt"
      FROM "Systems" s
      LEFT JOIN measurement m ON m."systemId" = s.id
     WHERE EXISTS (SELECT 1 FROM "Principals" p
                    WHERE p."systemId" = s.id AND p."deletedAt" IS NULL)
     ORDER BY s."displayName"`);
  return r.rows.map(row => ({
    systemName: row.systemName,
    measuredAt: row.measuredAt ? new Date(row.measuredAt) : null,
  }));
}

/** Whole days between two moments, floored and never negative. */
export function daysBetween(from, to) {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * The standard notices for an activity-based report: what the rows were
 * measured from, which measurements are too old to trust, and which systems
 * were skipped for having no activity data at all.
 *
 * The last one matters most. Without it, a tenant with no Entra ID P1 — so no
 * `signInActivity` collected at all — reads an empty report as "nothing is
 * stale" rather than "nothing was measured".
 *
 * @param {{systemName: string, measuredAt: Date|null}[]} moments
 * @param {Date} [now] injectable clock, so the age is testable
 * @returns {import('./types.js').ReportNotice[]}
 */
export function activityNotices(moments, now = new Date()) {
  const measured = moments.filter(m => m.measuredAt);
  const unmeasured = moments.filter(m => !m.measuredAt);

  if (measured.length === 0) {
    return [{
      severity: 'warning',
      text: 'No sign-in activity has been collected yet, so no account can be judged on it. '
        + 'Run a full sync of a crawler that collects sign-in activity.',
    }];
  }

  const notices = [{
    severity: 'info',
    text: 'Based on activity data measured on '
      + measured.map(m => `${toDateOnly(m.measuredAt)} (${m.systemName})`).join(', ')
      + '. Sign-ins after that moment are not included.',
  }];

  for (const m of measured) {
    const age = daysBetween(m.measuredAt, now);
    if (age > MEASUREMENT_WARNING_DAYS) {
      notices.push({
        severity: 'warning',
        text: `Activity data is ${age} days old — run a full sync of ${m.systemName}.`,
      });
    }
  }

  if (unmeasured.length) {
    notices.push({
      severity: 'info',
      text: `No activity data for ${unmeasured.map(m => m.systemName).join(', ')} — `
        + 'accounts in those systems are not listed.',
    });
  }

  return notices;
}

/**
 * A threshold parameter as a usable number of days.
 *
 * Query parameters arrive as strings from a URL anyone can edit, so anything
 * that isn't a sensible positive whole number falls back to the template's
 * declared default rather than reaching SQL (or producing a 500).
 */
export function parseDays(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 36500 ? n : fallback;
}

/** The threshold schema shared by the activity reports' `parametersSchema`. */
export function daysParameterSchema(defaultDays, description) {
  return {
    type: 'object',
    required: [],
    properties: {
      days: { type: 'integer', title: 'Days', description, default: defaultDays },
    },
  };
}
