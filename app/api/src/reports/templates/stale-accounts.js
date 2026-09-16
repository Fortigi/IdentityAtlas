// Stale Accounts — enabled accounts that still hold access but stopped being used.
//
// The pair of conditions is the point: an unused account that grants nothing is
// housekeeping, an unused account that still grants something is exposure. The
// threshold counts back from the system's own measurement moment, never from
// today — see reports/activityWindow.js for why.

import * as db from '../../db/connection.js';
import { toDateOnly } from '../../lib/dateOnly.js';
import {
  activityNotices, daysBetween, enabledUserActivityRow, enabledUserActivitySql,
  fetchMeasurementMoments, parseDays, daysParameterSchema,
} from '../activityWindow.js';

const DEFAULT_DAYS = 90;

export default {
  name: 'stale-accounts',
  displayName: 'Stale Accounts',
  description:
    'Enabled user accounts that hold at least one access assignment and have not signed in for '
    + 'longer than the threshold. Staleness is measured from the moment each system\'s activity '
    + 'data was last collected, not from today, so a missed sync cannot turn everyone stale. '
    + 'Systems with no collected activity are left out entirely.',
  form: 'list',
  parametersSchema: daysParameterSchema(
    DEFAULT_DAYS, 'Days without a sign-in before an account counts as stale.'),
  columns: [
    { key: 'displayName', label: 'Account' },
    { key: 'email', label: 'Email' },
    { key: 'systemName', label: 'System' },
    { key: 'lastSignIn', label: 'Last sign-in' },
    { key: 'daysInactive', label: 'Days inactive' },
    { key: 'assignmentCount', label: 'Assignments' },
    { key: 'measuredOn', label: 'Measured on' },
  ],

  async run(params, ctx) {
    const days = parseDays(params?.days, DEFAULT_DAYS);

    const r = await db.query(enabledUserActivitySql({
      condition: `act."lastSignIn" IS NOT NULL
         AND act."lastSignIn" < m."measuredAt" - make_interval(days => $1)
         AND EXISTS (SELECT 1 FROM "ResourceAssignments" ra
                      WHERE ra."principalId" = p.id AND ra."deletedAt" IS NULL)`,
      orderBy: 'act."lastSignIn"',
    }), [days]);

    const rows = r.rows.map(row => ({
      ...enabledUserActivityRow(row),
      lastSignIn: toDateOnly(row.lastSignIn),
      daysInactive: daysBetween(new Date(row.lastSignIn), new Date(row.measuredAt)),
    }));

    ctx?.log?.(`stale-accounts report: ${rows.length} account(s) idle for over ${days} day(s)`);
    return { rows, notices: activityNotices(await fetchMeasurementMoments()) };
  },
};
