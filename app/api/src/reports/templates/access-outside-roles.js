// Access Outside Roles — access granted by hand where a business role exists.
//
// A resource that a business role already grants has an approved, reviewable
// way in. A direct, ungoverned assignment on that same resource is the same
// access obtained around that path — invisible to the role model, unreviewed by
// the role's policy, and unaffected when someone is removed from the role.
//
// Only meaningful where governance data exists at all, so a tenant with no
// business roles gets that stated rather than an empty table it has to
// interpret.

import * as db from '../../db/connection.js';

export default {
  name: 'access-outside-roles',
  displayName: 'Access Outside Roles',
  description:
    'Direct, ungoverned assignments on resources that a business role also grants. The same '
    + 'access exists inside the role model, so these were granted around it and are not covered '
    + 'by the role\'s policy or reviews.',
  form: 'list',
  parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [
    { key: 'displayName', label: 'Account' },
    { key: 'email', label: 'Email' },
    { key: 'resourceName', label: 'Resource' },
    { key: 'resourceType', label: 'Resource type' },
    { key: 'businessRoles', label: 'Also granted by' },
  ],

  async run(params, ctx) {
    const r = await db.query(`
      SELECT p.id, p."displayName", p.email,
             r."displayName" AS "resourceName", r."resourceType",
             string_agg(DISTINCT br."displayName", ', ') AS "businessRoles"
        FROM "ResourceAssignments" ra
        JOIN "Principals" p ON p.id = ra."principalId" AND p."deletedAt" IS NULL
        JOIN "Resources" r ON r.id = ra."resourceId" AND r."deletedAt" IS NULL
        JOIN "ResourceRelationships" rr
          ON rr."childResourceId" = r.id AND rr."relationshipType" = 'Contains'
        JOIN "Resources" br
          ON br.id = rr."parentResourceId"
         AND br."resourceType" = 'BusinessRole'
         AND br."deletedAt" IS NULL
       WHERE ra."deletedAt" IS NULL
         AND ra."assignmentType" = 'Direct'
         AND ra."governed" IS NOT TRUE
       GROUP BY p.id, p."displayName", p.email, r."displayName", r."resourceType"
       ORDER BY p."displayName", r."displayName"`);

    const rows = r.rows.map(row => ({
      displayName: row.displayName,
      email: row.email,
      resourceName: row.resourceName,
      resourceType: row.resourceType,
      businessRoles: row.businessRoles,
      _entity: { kind: 'user', id: row.id },
    }));

    const notices = [];
    if (rows.length === 0) {
      const { count } = await db.queryOne(
        `SELECT COUNT(*)::int AS count FROM "Resources"
          WHERE "resourceType" = 'BusinessRole' AND "deletedAt" IS NULL`) || { count: 0 };
      if (count === 0) {
        notices.push({
          severity: 'info',
          text: 'No business roles are loaded, so there is no role model to grant access around. '
            + 'This report is only meaningful once governance data has been synced.',
        });
      }
    }

    ctx?.log?.(`access-outside-roles report: ${rows.length} ungoverned direct assignment(s)`);
    return { rows, notices };
  },
};
