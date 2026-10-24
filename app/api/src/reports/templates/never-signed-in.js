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
import {
  activityNotices, daysBetween, enabledUserActivityRow, enabledUserActivitySql,
  fetchMeasurementMoments, parseDays, daysParameterSchema,
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

    const r = await db.query(enabledUserActivitySql({
      columns: 'p."createdDateTime"',
      condition: `act."lastSignIn" IS NULL
         AND p."createdDateTime" IS NOT NULL
         AND p."createdDateTime" < m."measuredAt" - make_interval(days => $1)`,
      orderBy: 'p."createdDateTime"',
    }), [days]);

    const rows = r.rows.map(row => ({
      ...enabledUserActivityRow(row),
      createdOn: toDateOnly(row.createdDateTime),
      daysSinceCreated: daysBetween(new Date(row.createdDateTime), new Date(row.measuredAt)),
    }));

    ctx?.log?.(`never-signed-in report: ${rows.length} unused account(s) older than ${days} day(s)`);
    return { rows, notices: activityNotices(await fetchMeasurementMoments()) };
  },
};
