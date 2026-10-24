// Stale Guest Accounts — external people who stopped using their access, or
// never started.
//
// Guests age differently from members: nobody offboards them, so the threshold
// is shorter, and the never-accepted invitation is its own finding. An
// unaccepted invitation is not an activity question, so those rows are listed
// even in a system with no collected activity — only the staleness half needs
// a measurement moment.

import * as db from '../../db/connection.js';
import { toDateOnly } from '../../lib/dateOnly.js';
import { aggregateActivityLateral } from '../../lib/principalActivity.js';
import {
  activityNotices, daysBetween, fetchMeasurementMoments, measurementCte,
  parseDays, daysParameterSchema,
} from '../activityWindow.js';

const DEFAULT_DAYS = 30;
const PENDING_STATE = 'PendingAcceptance';

export default {
  name: 'stale-guest-accounts',
  displayName: 'Stale Guest Accounts',
  description:
    'Guest (external) accounts that have not signed in since the threshold, measured from their '
    + 'system\'s activity collection moment, plus guests whose invitation was never accepted. '
    + 'Member accounts are never listed here.',
  form: 'list',
  parametersSchema: daysParameterSchema(
    DEFAULT_DAYS, 'Days without a sign-in before a guest counts as stale.'),
  columns: [
    { key: 'displayName', label: 'Guest' },
    { key: 'email', label: 'Email' },
    { key: 'systemName', label: 'System' },
    { key: 'reason', label: 'Reason' },
    { key: 'lastSignIn', label: 'Last sign-in' },
    { key: 'daysInactive', label: 'Days inactive' },
    { key: 'invitationState', label: 'Invitation' },
    { key: 'measuredOn', label: 'Measured on' },
  ],

  async run(params, ctx) {
    const days = parseDays(params?.days, DEFAULT_DAYS);

    const r = await db.query(`
      WITH measurement AS (${measurementCte()})
      SELECT p.id, p."displayName", p.email,
             s."displayName" AS "systemName",
             p."extendedAttributes"->>'externalUserState' AS "invitationState",
             act."lastSignIn", m."measuredAt"
        FROM "Principals" p
        LEFT JOIN measurement m ON m."systemId" = p."systemId"
        LEFT JOIN "Systems" s ON s.id = p."systemId"
        ${aggregateActivityLateral('p')}
       WHERE p."deletedAt" IS NULL
         AND p."extendedAttributes"->>'userType' = 'Guest'
         AND (
              p."extendedAttributes"->>'externalUserState' = $2
              OR (m."measuredAt" IS NOT NULL
                  AND act."lastSignIn" IS NOT NULL
                  AND act."lastSignIn" < m."measuredAt" - make_interval(days => $1))
             )
       ORDER BY p."displayName"`, [days, PENDING_STATE]);

    const rows = r.rows.map(row => {
      const stale = row.lastSignIn && row.measuredAt
        && new Date(row.lastSignIn) < new Date(row.measuredAt);
      const pending = row.invitationState === PENDING_STATE;
      const reasons = [];
      if (pending) reasons.push('Invitation never accepted');
      if (stale) reasons.push(`No sign-in for over ${days} days`);
      return {
        displayName: row.displayName,
        email: row.email,
        systemName: row.systemName,
        reason: reasons.join('; '),
        lastSignIn: toDateOnly(row.lastSignIn),
        daysInactive: row.lastSignIn && row.measuredAt
          ? daysBetween(new Date(row.lastSignIn), new Date(row.measuredAt))
          : null,
        invitationState: row.invitationState,
        measuredOn: toDateOnly(row.measuredAt),
        _entity: { kind: 'user', id: row.id },
      };
    });

    ctx?.log?.(`stale-guest-accounts report: ${rows.length} guest account(s)`);
    return { rows, notices: activityNotices(await fetchMeasurementMoments()) };
  },
};
