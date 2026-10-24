// Privileged Accounts — everyone holding a directory role, and who they are.
//
// The list of role holders is the easy half. The audit question is the second
// half: *which person* is behind each privileged account. Two answers are
// findings in themselves — an admin account linked to no identity is one nobody
// owns (often a shared account), and one identity holding several admin
// accounts is a single person whose real privilege is the union of them.
//
// Active (Direct) and eligible (PIM) assignments are separate rows: they are
// different standing risk, and collapsing them would hide which is which.

import * as db from '../../db/connection.js';

export default {
  name: 'privileged-accounts',
  displayName: 'Privileged Accounts',
  description:
    'Every account holding a directory role, listed once per role and assignment type — active '
    + '(Direct) and eligible (PIM) shown separately. The cross-check columns show whether the '
    + 'account belongs to an identity at all, and how many admin accounts that identity holds.',
  form: 'list',
  parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [
    { key: 'displayName', label: 'Account' },
    { key: 'email', label: 'Email' },
    { key: 'roleName', label: 'Directory role' },
    { key: 'assignmentType', label: 'Assignment' },
    { key: 'identityName', label: 'Identity' },
    { key: 'adminAccountCount', label: 'Admin accounts' },
    { key: 'crossCheck', label: 'Cross-check' },
  ],

  async run(params, ctx) {
    const r = await db.query(`
      WITH admin_assignment AS (
        SELECT ra."principalId", ra."assignmentType", r."displayName" AS "roleName"
          FROM "ResourceAssignments" ra
          JOIN "Resources" r ON r.id = ra."resourceId"
                            AND r."resourceType" = 'EntraDirectoryRole'
                            AND r."deletedAt" IS NULL
         WHERE ra."deletedAt" IS NULL
           AND ra."assignmentType" IN ('Direct', 'Eligible')
      ),
      identity_admins AS (
        SELECT im."identityId", COUNT(DISTINCT im."principalId")::int AS "adminAccountCount"
          FROM "IdentityMembers" im
         WHERE EXISTS (SELECT 1 FROM admin_assignment a WHERE a."principalId" = im."principalId")
         GROUP BY im."identityId"
      )
      SELECT p.id, p."displayName", p.email,
             aa."roleName", aa."assignmentType",
             link."identityName", COALESCE(link."adminAccountCount", 0) AS "adminAccountCount"
        FROM admin_assignment aa
        JOIN "Principals" p ON p.id = aa."principalId" AND p."deletedAt" IS NULL
        LEFT JOIN LATERAL (
          SELECT i."displayName" AS "identityName", ia."adminAccountCount"
            FROM "IdentityMembers" im
            JOIN "Identities" i ON i.id = im."identityId"
            LEFT JOIN identity_admins ia ON ia."identityId" = i.id
           WHERE im."principalId" = p.id
           ORDER BY im."isPrimary" DESC NULLS LAST, i."displayName"
           LIMIT 1
        ) link ON TRUE
       ORDER BY aa."roleName", p."displayName", aa."assignmentType"`);

    const rows = r.rows.map(row => ({
      displayName: row.displayName,
      email: row.email,
      roleName: row.roleName,
      assignmentType: row.assignmentType,
      identityName: row.identityName,
      adminAccountCount: row.adminAccountCount,
      crossCheck: crossCheck(row),
      _entity: { kind: 'user', id: row.id },
    }));

    ctx?.log?.(`privileged-accounts report: ${rows.length} directory-role assignment(s)`);
    return { rows };
  },
};

// The one-line reading of the two cross-check columns, so a reviewer scanning
// the list does not have to compare them by eye.
function crossCheck(row) {
  if (!row.identityName) return 'Not linked to an identity — possible shared admin account';
  if (row.adminAccountCount > 1) return `Identity holds ${row.adminAccountCount} admin accounts`;
  return '';
}
