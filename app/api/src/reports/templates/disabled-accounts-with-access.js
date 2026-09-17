// Disabled Accounts With Access — accounts switched off, but never stripped.
//
// Disabling an account blocks the sign-in, not the entitlement. The assignments
// survive, so a re-enable (support ticket, mistaken cleanup, an attacker with
// directory write) restores everything at once. Every control framework asks
// for this list; it needs no activity data, only the two facts already stored.

import * as db from '../../db/connection.js';

export default {
  name: 'disabled-accounts-with-access',
  displayName: 'Disabled Accounts With Access',
  description:
    'Accounts that are disabled in their source system yet still hold access assignments. '
    + 'Disabling blocks sign-in but leaves entitlements in place, so re-enabling the account '
    + 'restores all of them at once.',
  form: 'list',
  parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [
    { key: 'displayName', label: 'Account' },
    { key: 'email', label: 'Email' },
    { key: 'principalType', label: 'Type' },
    { key: 'systemName', label: 'System' },
    { key: 'assignmentCount', label: 'Assignments' },
  ],

  async run(params, ctx) {
    const r = await db.query(`
      SELECT p.id, p."displayName", p.email, p."principalType",
             s."displayName" AS "systemName",
             COUNT(ra.*)::int AS "assignmentCount"
        FROM "Principals" p
        JOIN "ResourceAssignments" ra
          ON ra."principalId" = p.id AND ra."deletedAt" IS NULL
        LEFT JOIN "Systems" s ON s.id = p."systemId"
       WHERE p."deletedAt" IS NULL
         AND p."accountEnabled" IS FALSE
       GROUP BY p.id, p."displayName", p.email, p."principalType", s."displayName"
       ORDER BY COUNT(ra.*) DESC, p."displayName"`);

    const rows = r.rows.map(row => ({
      displayName: row.displayName,
      email: row.email,
      principalType: row.principalType,
      systemName: row.systemName,
      assignmentCount: row.assignmentCount,
      _entity: { kind: 'user', id: row.id },
    }));

    ctx?.log?.(`disabled-accounts-with-access report: ${rows.length} disabled account(s) with access`);
    return { rows };
  },
};
