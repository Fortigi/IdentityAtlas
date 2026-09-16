// Never Signed In — enabled accounts that were created, and then never used.
//
// The age filter is what separates a finding from noise: an account created
// yesterday has not signed in yet either, and listing it would bury the ones
// that were provisioned months ago and forgotten. Both the age and the
// "never" are judged against the system's measurement moment, so an account
// created after the last activity collection is never reported on data that
// could not have seen it.

import * as db from '../../db/connection.js';
import { toDateOnly } from '../../lib/dateOnly.js';
import { aggregateActivityLateral } from '../../lib/principalActivity.js';
import {
  activityNotices, daysBetween, fetchMeasurementMoments, measurementCte,
  parseDays, daysParameterSchema,
} from '../activityWindow.js';

const DEFAULT_DAYS = 30;

export default {
  name: 'never-signed-in',
  displayName: 'Never Signed In',
  description:
    'Enabled user accounts created more than the threshold before their system\'s activity data '
    + 'was collected, that carry no sign-in timestamp at all. Accounts created after that '
    + 'measurement moment are not listed — the data could not have seen them sign in.',
  form: 'list',
  parametersSchema: daysParameterSchema(
    DEFAULT_DAYS, 'How long an account must have existed before never signing in counts.'),
  columns: [
    { key: 'displayName', label: 'Account' },
    { key: 'email', label: 'Email' },
    { key: 'systemName', label: 'System' },
    { key: 'createdOn', label: 'Created' },
    { key: 'daysSinceCreated', label: 'Days since created' },
    { key: 'assignmentCount', label: 'Assignments' },
    { key: 'measuredOn', label: 'Measured on' },
  ],

  async run(params, ctx) {
    const days = parseDays(params?.days, DEFAULT_DAYS);

    const r = await db.query(`
      WITH measurement AS (${measurementCte()})
      SELECT p.id, p."displayName", p.email, p."createdDateTime",
             s."displayName" AS "systemName", m."measuredAt",
             (SELECT COUNT(*) FROM "ResourceAssignments" ra
               WHERE ra."principalId" = p.id AND ra."deletedAt" IS NULL)::int AS "assignmentCount"
        FROM "Principals" p
        JOIN measurement m ON m."systemId" = p."systemId"
        LEFT JOIN "Systems" s ON s.id = p."systemId"
        ${aggregateActivityLateral('p')}
       WHERE p."deletedAt" IS NULL
         AND p."principalType" = 'User'
         AND p."accountEnabled" IS TRUE
         AND act."lastSignIn" IS NULL
         AND p."createdDateTime" IS NOT NULL
         AND p."createdDateTime" < m."measuredAt" - make_interval(days => $1)
       ORDER BY p."createdDateTime"`, [days]);

    const rows = r.rows.map(row => ({
      displayName: row.displayName,
      email: row.email,
      systemName: row.systemName,
      createdOn: toDateOnly(row.createdDateTime),
      daysSinceCreated: daysBetween(new Date(row.createdDateTime), new Date(row.measuredAt)),
      assignmentCount: row.assignmentCount,
      measuredOn: toDateOnly(row.measuredAt),
      _entity: { kind: 'user', id: row.id },
    }));

    ctx?.log?.(`never-signed-in report: ${rows.length} unused account(s) older than ${days} day(s)`);
    return { rows, notices: activityNotices(await fetchMeasurementMoments()) };
  },
};
