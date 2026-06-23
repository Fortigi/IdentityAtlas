// scope-hierarchy plugin.
//
// Builds a context tree that mirrors a system's resource *containment* — for Azure RM that's
// Management Group → Subscription → Resource Group → Resource — from the `Contains`
// ResourceRelationships the crawler emits. Generic: any source that emits Contains edges
// (DevOps, file shares, SharePoint) gets the same tree with no extra code.
//
// The shape decision is config, not code: `leafResourceTypes` chooses where the tree stops.
// Empty → every resource is its own node (full depth). e.g. ["AzureResourceGroup"] → resource
// groups are the leaf nodes and the resources beneath them are attached as MEMBERS, not nodes.

import * as db from '../../db/connection.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'scope-hierarchy',
  displayName: 'Scope Hierarchy',
  description:
    'Mirrors a system\'s resource containment (e.g. Azure Management Group → Subscription → ' +
    'Resource Group → Resource) as a context tree, from the Contains relationships the crawler ' +
    'emits. Use leafResourceTypes to stop the tree at chosen types and attach their descendants ' +
    'as members instead of nodes.',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: { type: 'integer', description: 'Systems.id — whose resources / Contains edges to walk.' },
      rootName: { type: 'string', default: 'Scope Hierarchy', description: 'Display name of the synthetic root node.' },
      leafResourceTypes: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description:
          'Resource types to treat as tree leaves: their descendants are attached as MEMBERS ' +
          'rather than child nodes. Empty = every resource is its own node (full depth). ' +
          'Example: ["AzureResourceGroup"] stops at resource groups and lists resources as members.',
      },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = parseInt(params.scopeSystemId, 10);
    if (!Number.isFinite(scopeSystemId)) throw new Error('scopeSystemId is required and must be an integer');
    const rootName = (params.rootName || 'Scope Hierarchy').slice(0, 500);
    const leafTypes = new Set(
      (Array.isArray(params.leafResourceTypes) ? params.leafResourceTypes : []).filter((t) => typeof t === 'string'),
    );

    const nodes = (await db.query(
      `SELECT id::text AS id, "displayName" AS name, "resourceType" AS rtype
         FROM "Resources" WHERE "systemId" = $1`,
      [scopeSystemId],
    )).rows;
    if (nodes.length === 0) {
      ctx.log?.(`No resources in system ${scopeSystemId} — nothing to do.`);
      return { contexts: [], members: [] };
    }

    const edges = (await db.query(
      `SELECT rr."parentResourceId"::text AS parent, rr."childResourceId"::text AS child
         FROM "ResourceRelationships" rr
         JOIN "Resources" rc ON rc.id = rr."childResourceId" AND rc."systemId" = $1
        WHERE rr."relationshipType" = 'Contains'
          AND COALESCE((rr."extendedAttributes" ->> 'propagates')::boolean, true) = true`,
      [scopeSystemId],
    )).rows;

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const parentOf = new Map();
    for (const e of edges) { if (!parentOf.has(e.child)) parentOf.set(e.child, e.parent); }

    // The nearest ancestor (if any) whose resourceType is a leaf type — that ancestor "absorbs"
    // this node as a member instead of letting it be its own context. Memoised; cycle-safe.
    const leafAncCache = new Map();
    function leafAncestor(id, seen = new Set()) {
      if (leafAncCache.has(id)) return leafAncCache.get(id);
      if (seen.has(id)) return null; // defensive: a containment cycle
      seen.add(id);
      const parent = parentOf.get(id);
      let result = null;
      if (parent && byId.has(parent)) {
        result = leafTypes.has(byId.get(parent).rtype) ? parent : leafAncestor(parent, seen);
      }
      leafAncCache.set(id, result);
      return result;
    }

    const rootExt = 'scope-root';
    const contexts = [{ externalId: rootExt, displayName: rootName, contextType: 'ScopeHierarchy' }];
    const members = [];

    for (const n of nodes) {
      const leafAnc = leafAncestor(n.id);
      if (leafAnc) {
        members.push({ contextExternalId: leafAnc, memberId: n.id }); // absorbed into a leaf node
        continue;
      }
      const parent = parentOf.get(n.id);
      const parentIsContext = parent && byId.has(parent) && !leafAncestor(parent);
      contexts.push({
        externalId: n.id,
        displayName: n.name || n.id,
        contextType: n.rtype || 'Scope',
        parentExternalId: parentIsContext ? parent : rootExt,
      });
    }

    ctx.log?.(`Built ${contexts.length} scope contexts, ${members.length} member rows (leaf types: ${[...leafTypes].join(', ') || 'none'}).`);
    return { contexts, members };
  },
};
