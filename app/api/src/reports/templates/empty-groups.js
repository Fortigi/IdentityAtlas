// Empty Groups — groups that grant access to nobody.
//
// An empty group is clutter until someone adds a member, at which point it is a
// grant nobody reviewed the creation of. They also hide the real shape of the
// access model: a role-mining view padded with groups that have never granted
// anything.
//
// Note the model puts owners on a separate `GroupOwnership` resource, so a
// group with owners but no members IS listed here. That is the audit-relevant
// reading — owning an empty group grants nothing to anyone.

import * as db from '../../db/connection.js';
import { toDateOnly } from '../../lib/dateOnly.js';

export default {
  name: 'empty-groups',
  displayName: 'Empty Groups',
  description:
    'Groups with no member assignments at all. Owners live on a separate ownership resource in '
    + 'this model, so a group that has owners but no members is still listed — it grants nobody '
    + 'anything.',
  form: 'list',
  parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [
    { key: 'displayName', label: 'Group' },
    { key: 'description', label: 'Description' },
    { key: 'systemName', label: 'System' },
    { key: 'createdOn', label: 'Created' },
  ],

  async run(params, ctx) {
    const r = await db.query(`
      SELECT r.id, r."displayName", r.description, r."createdDateTime",
             s."displayName" AS "systemName"
        FROM "Resources" r
        LEFT JOIN "Systems" s ON s.id = r."systemId"
       WHERE r."deletedAt" IS NULL
         AND r."resourceType" = 'Group'
         AND NOT EXISTS (SELECT 1 FROM "ResourceAssignments" ra
                          WHERE ra."resourceId" = r.id AND ra."deletedAt" IS NULL)
       ORDER BY r."displayName"`);

    const rows = r.rows.map(row => ({
      displayName: row.displayName,
      description: row.description,
      systemName: row.systemName,
      createdOn: toDateOnly(row.createdDateTime),
      _entity: { kind: 'group', id: row.id },
    }));

    ctx?.log?.(`empty-groups report: ${rows.length} group(s) with no members`);
    return { rows };
  },
};
