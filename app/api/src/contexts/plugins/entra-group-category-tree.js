// entra-group-category-tree plugin.
//
// Groups Entra groups by their crawler-derived `groupCategory` (Team,
// Microsoft365, SecurityGroup, DistributionList, MailEnabledSecurity and the
// Dynamic* variants) into a two-level tree: a single "EntraID Groups" root with
// one child context per distinct category, each holding the matching Group
// resources as members. Lets an analyst browse/filter "all the Teams", "all the
// dynamic security groups", etc.
//
// The groupCategory value is stamped once by the Entra crawler transform
// (see tools/crawlers/entra-id/EntraIDCrawler.Transform.ps1 →
// Get-EntraGroupClassification), so this plugin only reads it — it never
// re-derives the classification from the raw Graph flags.

import * as db from '../../db/connection.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'entra-group-category-tree',
  displayName: 'Entra Group Category Tree',
  description:
    'Groups Entra groups by their derived groupCategory (Team, Microsoft365, SecurityGroup, ' +
    'DistributionList, … and the Dynamic* variants) under a single "EntraID Groups" root, one ' +
    'child context per category holding the matching groups. Lets you browse or filter by the ' +
    'kind of group.',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    properties: {
      rootName: { type: 'string', default: 'EntraID Groups', description: 'Display name of the synthetic root node.' },
      scopeSystemId: { type: 'integer', description: 'Optional Systems.id to restrict to one Entra system. Blank = all Group resources.' },
    },
  },
  async run(params, ctx) {
    const rootName = (params.rootName || 'EntraID Groups').slice(0, 500);
    const hasScope = params.scopeSystemId !== undefined && params.scopeSystemId !== null && params.scopeSystemId !== '';
    const scopeSystemId = hasScope ? parseInt(params.scopeSystemId, 10) : null;
    if (hasScope && !Number.isFinite(scopeSystemId)) {
      throw new Error('scopeSystemId must be an integer when provided');
    }

    const conds = [`"resourceType" = 'Group'`, `"extendedAttributes" ->> 'groupCategory' IS NOT NULL`];
    const qp = [];
    if (scopeSystemId !== null) { qp.push(scopeSystemId); conds.push(`"systemId" = $${qp.length}`); }

    const rows = (await db.query(
      `SELECT id::text AS id, "extendedAttributes" ->> 'groupCategory' AS val
         FROM "Resources" WHERE ${conds.join(' AND ')}`,
      qp,
    )).rows;
    if (rows.length === 0) {
      ctx.log?.('No Group resources carry a groupCategory attribute yet — run the Entra crawler first.');
      return { contexts: [], members: [] };
    }

    const rootExt = 'entra-groups-root';
    const contexts = [{ externalId: rootExt, displayName: rootName, contextType: 'EntraGroupRoot' }];
    const members = [];
    const seen = new Map(); // category → externalId
    for (const r of rows) {
      const val = (r.val || '').trim();
      if (!val) continue;
      if (!seen.has(val)) {
        const ext = `category:${val}`;
        seen.set(val, ext);
        contexts.push({ externalId: ext, displayName: val, contextType: 'EntraGroupCategory', parentExternalId: rootExt });
      }
      members.push({ contextExternalId: seen.get(val), memberId: r.id });
    }

    ctx.log?.(`Grouped ${members.length} Entra group(s) into ${seen.size} category context(s).`);
    return { contexts, members };
  },
};
