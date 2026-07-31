// "Which Contexts is this resource a member of" — the single ContextMembers ⋈
// Contexts join, shared by GET /resources/:id/contexts (one resource) and the
// /matrix/data flat-grid batch (every visible resource, #870). One builder so
// the two call sites can't drift apart.

import { createParams } from '../db/sqlParams.js';
import { timedQuery } from '../perf/sqlTimer.js';

// Render the join. `batch: true` adds the memberId (as "resourceId") to the
// SELECT and ORDER BY so rows can be grouped per resource; the per-context
// ordering (contextType, then displayName) is identical in both shapes.
export function buildResourceContextsSql({ where, batch = false }) {
  const memberCol = batch ? 'cm."memberId"::text AS "resourceId", ' : '';
  const memberOrder = batch ? 'cm."memberId", ' : '';
  return `SELECT ${memberCol}c.id, c."displayName", c."contextType", c."targetType", c.variant
       FROM "ContextMembers" cm
       JOIN "Contexts" c ON c.id = cm."contextId"
      WHERE ${where}
      ORDER BY ${memberOrder}c."contextType", c."displayName"`;
}

// Batch rows → [{ resourceId, contexts: [{ id, displayName, contextType,
// targetType, variant }] }], preserving the server-side ordering per resource.
export function groupResourceContexts(rows) {
  const byResource = new Map();
  for (const r of rows || []) {
    if (!byResource.has(r.resourceId)) byResource.set(r.resourceId, []);
    byResource.get(r.resourceId).push({
      id: r.id,
      displayName: r.displayName,
      contextType: r.contextType,
      targetType: r.targetType,
      variant: r.variant,
    });
  }
  return [...byResource.entries()].map(([resourceId, contexts]) => ({ resourceId, contexts }));
}

// The matrix flat-grid sidecar: Resource-targeted context memberships for the
// visible resources, in one indexed batch (ix_ContextMembers_member) scoped
// exactly like the managedByPackages mapping in the same handler. Swallows its
// own failures (returns []) so the grid never breaks over the sidecar — this
// also keeps the complexity-grandfathered handleFlatGrid branch-free.
export async function fetchMatrixResourceContexts(p, res, built) {
  try {
    const { params, bind } = createParams();
    const resourceSql = built.resource(bind).sql;
    const where = [`cm."memberType" = 'Resource'`];
    if (resourceSql) where.push(`cm."memberId" IN ${resourceSql}`);
    const result = await timedQuery(p, 'matrix-data-resource-contexts', res,
      buildResourceContextsSql({ where: where.join(' AND '), batch: true }), params);
    return groupResourceContexts(result.rows);
  } catch {
    return []; // Contexts tables may be absent on older deployments
  }
}
