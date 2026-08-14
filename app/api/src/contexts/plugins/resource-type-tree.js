// resource-type-tree plugin.
//
// Groups a system's resources by a chosen extendedAttributes key (default: azureResourceType)
// into a two-level tree: a synthetic root with one child context per distinct value, each holding
// the matching resources as members. Answers "who can access any VM / any storage account?".
//
// Generic: the grouping attribute is config, so the same plugin groups DevOps repos, file-share
// types, etc. — whatever attribute a crawler records on its resources.

import * as db from '../../db/connection.js';

const PLANE_NAME = { data: 'Data plane access', control: 'Control plane access' };

// Normalise the plugin's raw parameters into typed, defaulted values (and validate the attribute).
export function parseParams(params) {
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
  return { scopeSystemId, attribute, rootName, resourceType, roleLeaves };
}

// Build the resources query: every in-scope resource that carries the grouping attribute.
export function buildResourceQuery({ scopeSystemId, attribute, resourceType }) {
  const conds = ['"systemId" = $1', '"extendedAttributes" ->> $2 IS NOT NULL'];
  const qp = [scopeSystemId, attribute];
  if (resourceType) { qp.push(resourceType); conds.push(`"resourceType" = $${qp.length}`); }
  return {
    text: `SELECT id::text AS id, "extendedAttributes" ->> $2 AS val FROM "Resources" WHERE ${conds.join(' AND ')}`,
    params: qp,
  };
}

// Build the capability-resources query used for the optional per-role leaves.
export function buildCapabilityQuery({ scopeSystemId, attribute, resourceType }) {
  const capConds = ['cap."systemId" = $1', 'cap."capabilityId" IS NOT NULL', `sc."extendedAttributes" ->> $2 IS NOT NULL`];
  const capQp = [scopeSystemId, attribute];
  if (resourceType) { capQp.push(resourceType); capConds.push(`sc."resourceType" = $${capQp.length}`); }
  return {
    text: `SELECT cap.id::text AS capid,
                cap."extendedAttributes" ->> 'roleName' AS role,
                cap."extendedAttributes" ->> 'plane'    AS plane,
                sc."extendedAttributes"  ->> $2         AS typeval
           FROM "Resources" cap
           JOIN "Resources" sc ON sc.id::text = cap."targetNodeId" AND sc."capabilityId" IS NULL
          WHERE ${capConds.join(' AND ')}`,
    params: capQp,
  };
}

// Ensure a ResourceType context exists for `val` under the root, returning its externalId.
export function ensureTypeContext(seen, contexts, val, rootExt) {
  if (!seen.has(val)) {
    const ext = `type:${val}`;
    seen.set(val, ext);
    contexts.push({ externalId: ext, displayName: val, contextType: 'ResourceType', parentExternalId: rootExt });
  }
  return seen.get(val);
}

// Fold the attribute rows into the two-level tree (synthetic root + one child per distinct value).
export function buildTree(rows, rootName) {
  const rootExt = 'type-root';
  const contexts = [{ externalId: rootExt, displayName: rootName, contextType: 'ResourceTypeRoot' }];
  const members = [];
  const seen = new Map(); // value → externalId
  for (const r of rows) {
    const val = (r.val || '').trim();
    if (!val) continue;
    const ext = ensureTypeContext(seen, contexts, val, rootExt);
    members.push({ contextExternalId: ext, memberId: r.id });
  }
  return { rootExt, contexts, members, seen };
}

// A capability lands under "Data plane" if its role grants dataActions (plane data/both), and under
// "Control plane" if it grants control actions (plane control/both). Unknown plane (older crawl)
// falls back to control.
export function planesFor(plane) {
  const planes = [];
  if (plane === 'data' || plane === 'both') planes.push('data');
  if (plane === 'control' || plane === 'both' || !plane) planes.push('control');
  return planes;
}

// Place one capability under a plane group and its role leaf, creating either on first sight.
// Mutates state.contexts/members/planeSeen/roleSeen. Returns true when a new role leaf was created.
function placeCapability(state, { capid, role, typeExt, plane }) {
  const { contexts, members, planeSeen, roleSeen } = state;
  const planeExt = `${typeExt}|plane:${plane}`;
  if (!planeSeen.has(planeExt)) {
    planeSeen.add(planeExt);
    contexts.push({ externalId: planeExt, displayName: PLANE_NAME[plane], contextType: 'ResourcePlane', parentExternalId: typeExt });
  }
  members.push({ contextExternalId: planeExt, memberId: capid }); // "any <plane> access"
  const roleExt = `${planeExt}|role:${role}`;
  let addedLeaf = false;
  if (!roleSeen.has(roleExt)) {
    roleSeen.add(roleExt);
    contexts.push({ externalId: roleExt, displayName: role, contextType: 'ResourceRole', parentExternalId: planeExt });
    addedLeaf = true;
  }
  members.push({ contextExternalId: roleExt, memberId: capid });
  return addedLeaf;
}

// Extend the tree with per-type plane groups (Data plane / Control plane) → per-role leaves, built
// from the role@resource capability-resources whose target scope is a resource of that type. Mutates
// the passed contexts/members/seen; returns counts for logging.
export function addRoleLeaves({ contexts, members, seen, rootExt }, capRows) {
  const state = { contexts, members, planeSeen: new Set(), roleSeen: new Set() };
  let leafCount = 0;
  for (const c of capRows) {
    const val = (c.typeval || '').trim();
    const role = (c.role || '').trim();
    if (!val || !role) continue;
    const typeExt = ensureTypeContext(seen, contexts, val, rootExt);
    for (const plane of planesFor(c.plane)) {
      if (placeCapability(state, { capid: c.capid, role, typeExt, plane })) leafCount++;
    }
  }
  return { planeCount: state.planeSeen.size, leafCount, capCount: capRows.length };
}

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
    const opts = parseParams(params);

    const rq = buildResourceQuery(opts);
    const rows = (await db.query(rq.text, rq.params)).rows;
    if (rows.length === 0) {
      ctx.log?.(`No resources in system ${opts.scopeSystemId} carry attribute "${opts.attribute}".`);
      return { contexts: [], members: [] };
    }

    const tree = buildTree(rows, opts.rootName);

    // Optional: per-type plane groups (Data plane / Control plane) → per-role leaves, built from
    // the role@resource capability-resources whose target scope is a resource of that type.
    if (opts.roleLeaves) {
      const cq = buildCapabilityQuery(opts);
      const capRows = (await db.query(cq.text, cq.params)).rows;
      const { planeCount, leafCount, capCount } = addRoleLeaves(tree, capRows);
      ctx.log?.(`Added ${planeCount} plane group(s) + ${leafCount} role leaf(ves) from ${capCount} capability-resources.`);
    }

    ctx.log?.(`Grouped ${tree.members.length} resources into ${tree.seen.size} type(s) by "${opts.attribute}".`);
    return { contexts: tree.contexts, members: tree.members };
  },
};
