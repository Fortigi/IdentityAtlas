// Which Contexts is a resource a member of? Shared by the single-resource
// endpoint (GET /resources/:id/contexts) and the matrix flat grid's batched
// "Contexts column" sidecar, so the ContextMembers→Contexts join lives in
// exactly one place.

import { timedQuery } from '../perf/sqlTimer.js';
import { createParams } from '../db/sqlParams.js';

// The shared join. Callers supply their own member filter (single id vs. a
// scoped IN-subquery); the SELECT list and stable ordering (contextType then
// displayName, the same ORDER the Contexts tab uses) stay identical.
export function buildResourceContextsSql(whereSql) {
  return `
    SELECT cm."memberId"::text AS "resourceId",
           c.id, c."displayName", c."contextType", c."targetType", c.variant
      FROM "ContextMembers" cm
      JOIN "Contexts" c ON c.id = cm."contextId"
     WHERE ${whereSql}
     ORDER BY cm."memberId", c."contextType", c."displayName"`;
}

// Flat rows → the per-resource sidecar shape returned by /matrix/data:
// [{ resourceId, contexts: [{ id, displayName, contextType, variant }] }].
// Row order is preserved, so contexts stay server-sorted per resource.
export function groupResourceContexts(rows) {
  const byResource = new Map();
  for (const r of rows || []) {
    if (!r.resourceId) continue;
    if (!byResource.has(r.resourceId)) byResource.set(r.resourceId, []);
    byResource.get(r.resourceId).push({
      id: r.id, displayName: r.displayName, contextType: r.contextType, variant: r.variant,
    });
  }
  return [...byResource.entries()].map(([resourceId, contexts]) => ({ resourceId, contexts }));
}

// Batched lookup for the flat grid: one indexed query scoped to the visible
// resources (built.resource — the same bound subquery the AP mapping uses),
// restricted to Resource-targeted memberships (the only kind a resource row
// can meaningfully display).
export async function fetchResourceContexts(p, res, built) {
  const { params, bind } = createParams();
  const resourceSql = built.resource(bind).sql;
  const where = [`cm."memberType" = 'Resource'`];
  if (resourceSql) where.push(`cm."memberId" IN ${resourceSql}`);
  const result = await timedQuery(p, 'matrix-data-resource-contexts', res,
    buildResourceContextsSql(where.join(' AND ')), params);
  return groupResourceContexts(result.rows);
}
