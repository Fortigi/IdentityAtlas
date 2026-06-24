// resource-type-tree plugin.
//
// Groups a system's resources by a chosen extendedAttributes key (default: azureResourceType)
// into a two-level tree: a synthetic root with one child context per distinct value, each holding
// the matching resources as members. Answers "who can access any VM / any storage account?".
//
// Generic: the grouping attribute is config, so the same plugin groups DevOps repos, file-share
// types, etc. — whatever attribute a crawler records on its resources.

import * as db from '../../db/connection.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'resource-type-tree',
  displayName: 'Resource Type Tree',
  description:
    'Groups a system\'s resources by an attribute (default: azureResourceType) into a root with ' +
    'one child context per distinct value, each holding the matching resources as members. Lets ' +
    'you ask "who can access any VM / any storage account?".',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: { type: 'integer', description: 'Systems.id — whose resources to group.' },
      attribute: { type: 'string', default: 'azureResourceType', description: 'extendedAttributes key to group resources by.' },
      rootName: { type: 'string', default: 'Resource Types', description: 'Display name of the synthetic root node.' },
      resourceType: { type: 'string', default: 'AzureResource', description: 'Only group resources of this resourceType. Blank = all resources that carry the attribute.' },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = parseInt(params.scopeSystemId, 10);
    if (!Number.isFinite(scopeSystemId)) throw new Error('scopeSystemId is required and must be an integer');
    const attribute = (typeof params.attribute === 'string' && params.attribute.trim()) ? params.attribute.trim() : 'azureResourceType';
    const rootName = (params.rootName || 'Resource Types').slice(0, 500);
    const resourceType = typeof params.resourceType === 'string' ? params.resourceType.trim() : '';

    // The attribute is passed as a bound parameter (->> $2), never interpolated, so it can't reach
    // SQL unsafely. Still, validate it's a plain JSON key as defence-in-depth.
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(attribute)) {
      throw new Error('attribute must be a simple key (letters, digits, _ . -)');
    }

    const conds = ['"systemId" = $1', '"extendedAttributes" ->> $2 IS NOT NULL'];
    const qp = [scopeSystemId, attribute];
    if (resourceType) { qp.push(resourceType); conds.push(`"resourceType" = $${qp.length}`); }

    const rows = (await db.query(
      `SELECT id::text AS id, "extendedAttributes" ->> $2 AS val FROM "Resources" WHERE ${conds.join(' AND ')}`,
      qp,
    )).rows;
    if (rows.length === 0) {
      ctx.log?.(`No resources in system ${scopeSystemId} carry attribute "${attribute}".`);
      return { contexts: [], members: [] };
    }

    const rootExt = 'type-root';
    const contexts = [{ externalId: rootExt, displayName: rootName, contextType: 'ResourceTypeRoot' }];
    const members = [];
    const seen = new Map(); // value → externalId
    for (const r of rows) {
      const val = (r.val || '').trim();
      if (!val) continue;
      if (!seen.has(val)) {
        const ext = `type:${val}`;
        seen.set(val, ext);
        contexts.push({ externalId: ext, displayName: val, contextType: 'ResourceType', parentExternalId: rootExt });
      }
      members.push({ contextExternalId: seen.get(val), memberId: r.id });
    }

    ctx.log?.(`Grouped ${members.length} resources into ${seen.size} type(s) by "${attribute}".`);
    return { contexts, members };
  },
};
