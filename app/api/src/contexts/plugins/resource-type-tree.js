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
      roleLeaves: {
        type: 'boolean',
        default: false,
        description:
          'Also add, under each type, "Data plane access" / "Control plane access" groups and a ' +
          'leaf per role (the role@resource capability-resources). Lets you ask "who has any ' +
          'data-plane access to a storage account?" or "who has Owner on any storage account?". ' +
          'Needs the crawler to record each capability\'s plane.',
      },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = parseInt(params.scopeSystemId, 10);
    if (!Number.isFinite(scopeSystemId)) throw new Error('scopeSystemId is required and must be an integer');
    const attribute = (typeof params.attribute === 'string' && params.attribute.trim()) ? params.attribute.trim() : 'azureResourceType';
    const rootName = (params.rootName || 'Resource Types').slice(0, 500);
    const resourceType = typeof params.resourceType === 'string' ? params.resourceType.trim() : '';
    const roleLeaves = params.roleLeaves === true;

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

    // Optional: per-type plane groups (Data plane / Control plane) → per-role leaves, built from
    // the role@resource capability-resources whose target scope is a resource of that type.
    if (roleLeaves) {
      const capConds = ['cap."systemId" = $1', 'cap."capabilityId" IS NOT NULL', `sc."extendedAttributes" ->> $2 IS NOT NULL`];
      const capQp = [scopeSystemId, attribute];
      if (resourceType) { capQp.push(resourceType); capConds.push(`sc."resourceType" = $${capQp.length}`); }
      const capRows = (await db.query(
        `SELECT cap.id::text AS capid,
                cap."extendedAttributes" ->> 'roleName' AS role,
                cap."extendedAttributes" ->> 'plane'    AS plane,
                sc."extendedAttributes"  ->> $2         AS typeval
           FROM "Resources" cap
           JOIN "Resources" sc ON sc.id::text = cap."targetNodeId" AND sc."capabilityId" IS NULL
          WHERE ${capConds.join(' AND ')}`,
        capQp,
      )).rows;

      const PLANE_NAME = { data: 'Data plane access', control: 'Control plane access' };
      const planeSeen = new Set();
      const roleSeen = new Set();
      let leafCount = 0;
      for (const c of capRows) {
        const val = (c.typeval || '').trim();
        const role = (c.role || '').trim();
        if (!val || !role) continue;
        if (!seen.has(val)) {
          const ext = `type:${val}`;
          seen.set(val, ext);
          contexts.push({ externalId: ext, displayName: val, contextType: 'ResourceType', parentExternalId: rootExt });
        }
        const typeExt = seen.get(val);
        // A capability lands under "Data plane" if its role grants dataActions (plane data/both),
        // and under "Control plane" if it grants control actions (plane control/both). Unknown
        // plane (older crawl) falls back to control.
        const planes = [];
        if (c.plane === 'data' || c.plane === 'both') planes.push('data');
        if (c.plane === 'control' || c.plane === 'both' || !c.plane) planes.push('control');
        for (const pl of planes) {
          const planeExt = `${typeExt}|plane:${pl}`;
          if (!planeSeen.has(planeExt)) {
            planeSeen.add(planeExt);
            contexts.push({ externalId: planeExt, displayName: PLANE_NAME[pl], contextType: 'ResourcePlane', parentExternalId: typeExt });
          }
          members.push({ contextExternalId: planeExt, memberId: c.capid }); // "any <plane> access"
          const roleExt = `${planeExt}|role:${role}`;
          if (!roleSeen.has(roleExt)) {
            roleSeen.add(roleExt);
            contexts.push({ externalId: roleExt, displayName: role, contextType: 'ResourceRole', parentExternalId: planeExt });
            leafCount++;
          }
          members.push({ contextExternalId: roleExt, memberId: c.capid });
        }
      }
      ctx.log?.(`Added ${planeSeen.size} plane group(s) + ${leafCount} role leaf(ves) from ${capRows.length} capability-resources.`);
    }

    ctx.log?.(`Grouped ${members.length} resources into ${seen.size} type(s) by "${attribute}".`);
    return { contexts, members };
  },
};
