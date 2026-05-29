// department-from-principal plugin.
//
// Derives one Department context per unique Principals.department value and
// assigns every matching principal as a member.  Run this after a CSV or
// Entra sync to populate the Department contexts that the Matrix wizard can
// then filter on.
//
// Optional parameter `scopeSystemId` restricts which principals are
// considered.  Omit it to derive departments across all systems.

import * as db from '../../db/connection.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'department-from-principal',
  displayName: 'Department from Principal',
  description:
    'Creates one Department context per unique department value on Principals and assigns each principal as a member. Run after a CSV or Entra sync.',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    properties: {
      scopeSystemId: {
        type: 'integer',
        description: 'Restrict to principals in this system. Omit to include all systems.',
      },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;

    const whereClause = scopeSystemId ? `WHERE "systemId" = $1 AND department IS NOT NULL AND department <> ''`
                                      : `WHERE department IS NOT NULL AND department <> ''`;
    const queryArgs   = scopeSystemId ? [scopeSystemId] : [];

    const rows = (await db.query(
      `SELECT id, department FROM "Principals" ${whereClause}`,
      queryArgs,
    )).rows;

    if (rows.length === 0) {
      ctx.log?.('No principals with a department value — nothing to do.');
      return { contexts: [], members: [] };
    }

    // One context per unique department name.
    const seen = new Map(); // department value → externalId
    for (const r of rows) {
      const dept = r.department.trim();
      if (!seen.has(dept)) {
        seen.set(dept, `dept:${dept}`);
      }
    }

    const contexts = [...seen.entries()].map(([dept, extId]) => ({
      externalId:  extId,
      displayName: dept,
      contextType: 'Department',
    }));

    const members = rows.map(r => ({
      contextExternalId: seen.get(r.department.trim()),
      memberId:          r.id,
    }));

    ctx.log?.(`Derived ${contexts.length} department(s), ${members.length} member links.`);
    return { contexts, members };
  },
};
