// Which Contexts a resource belongs to (v6 ContextMembers join).
//
// Two callers share this: the single-resource lookup behind
// GET /api/resources/:id/contexts, and the matrix flat grid, which needs the
// same join batched across every visible resource so each row can show its
// contexts (group category, tags, clusters, …) without a per-row fetch.
// Keeping one SQL builder here means the join, the memberType guard and the
// ordering can't drift between the two.

import { createParams } from './sqlParams.js';
import { timedQuery } from '../perf/sqlTimer.js';

// Only Resource-targeted memberships can land on a resource row — an
// Identity/Principal context that happens to contain the resource's *members*
// is not a property of the resource itself.
const MEMBER_TYPE = 'Resource';

/**
 * SQL for the ContextMembers → Contexts join.
 *
 * @param {object} opts
 * @param {string} opts.memberFilter — extra predicate on `cm."memberId"`
 *        (e.g. `::text = $1`, or `IN (SELECT …)`); omit for no scoping.
 * @param {boolean} [opts.withResourceId] — also select the member id, so a
 *        batched result can be grouped per resource.
 */
export function buildResourceContextsSql({ memberFilter = '', withResourceId = false } = {}) {
  const where = [`cm."memberType" = '${MEMBER_TYPE}'`];
  if (memberFilter) where.push(`cm."memberId" ${memberFilter}`);
  return `
    SELECT ${withResourceId ? 'cm."memberId"::text AS "resourceId", ' : ''}c.id, c."displayName", c."contextType", c."targetType", c.variant
      FROM "ContextMembers" cm
      JOIN "Contexts" c ON c.id = cm."contextId"
     WHERE ${where.join(' AND ')}
     ORDER BY ${withResourceId ? 'cm."memberId", ' : ''}c."contextType", c."displayName"`;
}

/**
 * Group flat `{ resourceId, id, displayName, contextType, variant }` rows into
 * one entry per resource. Row order is preserved (the query sorts by
 * contextType then displayName), so the first entries are the ones the matrix
 * shows before the "+N" expander.
 */
export function groupResourceContexts(rows) {
  const byResource = new Map();
  for (const row of rows || []) {
    if (!row.resourceId) continue;
    let list = byResource.get(row.resourceId);
    if (!list) { list = []; byResource.set(row.resourceId, list); }
    list.push({
      id: row.id,
      displayName: row.displayName,
      contextType: row.contextType,
      variant: row.variant,
    });
  }
  return [...byResource].map(([resourceId, contexts]) => ({ resourceId, contexts }));
}

/**
 * Batched lookup for the matrix flat grid: one indexed query
 * (ix_ContextMembers_member) scoped to the same resource sub-select the grid
 * itself uses, computed once per resource — not per cell.
 *
 * Tolerant by design (mirrors the access-package sidecar): a deployment whose
 * Contexts tables are missing yields an empty sidecar, not a failed matrix.
 */
export async function fetchResourceContexts(pool, res, built) {
  try {
    const { params, bind } = createParams();
    const resourceSql = built.resource(bind).sql;
    const rows = (await timedQuery(pool, 'matrix-data-resource-contexts', res, buildResourceContextsSql({
      memberFilter: resourceSql ? `IN ${resourceSql}` : '',
      withResourceId: true,
    }), params)).rows;
    return groupResourceContexts(rows);
  } catch {
    return []; // Contexts tables may not exist on older deployments
  }
}
