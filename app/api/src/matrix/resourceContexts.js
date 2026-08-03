// Contexts a Resource belongs to (v6 `ContextMembers` → `Contexts`).
//
// Two consumers share this join: the single-resource detail endpoint
// (`GET /api/resources/:id/contexts`) and the matrix flat grid, which needs the
// same rows for every visible resource at once. Keeping one builder here means
// a schema change lands in a single place — and keeps the duplication gate green.

import { timedQuery } from '../perf/sqlTimer.js';
import { isUuid } from './contextRollup.js';

// `memberWhere` is trusted, caller-authored SQL (never user input); every
// value-bearing predicate binds through the caller's params array.
export function buildResourceContextsSql(memberWhere, { selectPrefix = '', orderPrefix = '' } = {}) {
  return `SELECT ${selectPrefix}c.id, c."displayName", c."contextType", c."targetType", c.variant
            FROM "ContextMembers" cm
            JOIN "Contexts" c ON c.id = cm."contextId"
           WHERE ${memberWhere}
           ORDER BY ${orderPrefix}c."contextType", c."displayName"`;
}

// Flat rows → one entry per resource, contexts in server-sorted order.
export function groupResourceContexts(rows) {
  const byResource = new Map();
  for (const row of rows || []) {
    const resourceId = row?.resourceId;
    if (!resourceId) continue;
    if (!byResource.has(resourceId)) byResource.set(resourceId, []);
    byResource.get(resourceId).push({
      id: row.id,
      displayName: row.displayName,
      contextType: row.contextType,
    });
  }
  return [...byResource.entries()].map(([resourceId, contexts]) => ({ resourceId, contexts }));
}

// Batch lookup for the matrix sidecar. Scoped to the resources actually on the
// grid (bounded by MAX_FLAT_ROWS) and to `memberType='Resource'` — the only
// membership kind a resource row can carry. One indexed query per request
// (ix_ContextMembers_member), not one per row or per cell.
//
// Tolerant by design: deployments predating the v6 context tables (or a scope
// with no resolvable resource ids) simply get no Contexts column rather than a
// failed matrix.
export async function fetchResourceContexts(p, res, resourceIds) {
  const ids = [...new Set((resourceIds || []).filter(isUuid))];
  if (ids.length === 0) return [];
  const sql = buildResourceContextsSql(
    `cm."memberType" = 'Resource' AND cm."memberId" = ANY($1::uuid[])`,
    { selectPrefix: 'cm."memberId"::text AS "resourceId", ', orderPrefix: 'cm."memberId", ' },
  );
  try {
    const result = await timedQuery(p, 'matrix-data-resource-contexts', res, sql, [ids]);
    return groupResourceContexts(result.rows);
  } catch {
    return []; // Contexts/ContextMembers may not exist on older deployments
  }
}
