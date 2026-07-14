// Matrix nested-group expand endpoints — /api/groups-with-nested and
// /api/group/:groupId/nested-groups.
//
// Extracted verbatim from routes/permissions.js (audit finding C1). Mounted by
// routes/permissions.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { timedQuery } from '../../perf/sqlTimer.js';
import { createParams } from '../../db/sqlParams.js';
import { expandCapabilityDown } from '../../effectiveAccess/engine.js';
import { useSql, db } from './shared.js';
import { parseFilter, buildSubqueries } from '../matrix/shared.js';

const router = Router();

// Turn an optional matrix filter (in the request body) into the resource-scope
// SQL fragment + bindings the nesting queries constrain nested resources by.
// This is the SAME `filter.resource` block /matrix/data applies to the
// top-level grid (via buildSubqueries → buildEntitySubquery), so an expanded
// group only reveals nested resources of the types the matrix is filtered to —
// e.g. filtering to Groups no longer leaks AppRoles into the nesting.
// Returns { resourceSql: null, bindings: {} } when no filter is supplied (a
// plain GET), preserving the original "return every nested resource" behaviour.
async function resourceScopeFromBody(body) {
  const filter = parseFilter(body);
  if (!filter) return null;
  // Returns the built object; callers render `built.resource(bind).sql` per query.
  return await buildSubqueries(filter);
}

// GET /api/groups-with-nested - group IDs that are assigned to other resources
// (parent groups, app roles, etc.) so their members gain indirect access.
// The matrix UI uses this to decide which group rows should show an expand
// affordance.
router.get('/groups-with-nested', async (req, res) => {
  try {
    if (!useSql) return res.json({ groupIds: [] });
    const p = await db.getPool();
    // Two kinds of expandable rows:
    //  1. A group that appears as a principal in ResourceAssignments (membership /
    //     app-role / any future group-as-principal type) — expands UP via membership.
    //  2. A capability-resource (a capability @ a node, e.g. an Azure role at a
    //     subscription) whose node has propagating Contains children — expands DOWN
    //     the containment tree via the effective-access engine. This is generic:
    //     Azure RM, DevOps, FileShares, SharePoint all qualify with no per-source code.
    const result = await timedQuery(p, 'groups-with-nested', res, `
      SELECT DISTINCT "principalId"::text AS "groupId"
        FROM "ResourceAssignments"
       WHERE "principalType" ILIKE '%group%'
      UNION
      SELECT DISTINCT r.id::text AS "groupId"
        FROM "Resources" r
       WHERE r."capabilityId" IS NOT NULL
         AND r."targetNodeId" IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM "ResourceRelationships" rr
            WHERE rr."relationshipType" = 'Contains'
              AND rr."parentResourceId"::text = r."targetNodeId"
              AND COALESCE((rr."extendedAttributes"->>'propagates')::boolean, true) = true
         )
    `, []);
    return res.json({ groupIds: result.rows.map(r => r.groupId) });
  } catch (err) {
    console.error('groups-with-nested query failed:', err.message);
    return res.json({ groupIds: [] });
  }
});

// GET/POST /api/group/:groupId/nested-groups - the resources this group is a
// member of (parent groups, app roles, etc.) plus user memberships for those
// resources. Used by the matrix expand fanout: opening a group row reveals
// every resource its members inherit access to, with the same per-cell
// membership badges as the root matrix.
//
// POST carries the active matrix filter in the body (`{ filter }`) so the
// nesting honours the same resource-type scope as the grid; the legacy GET
// (no body) returns every nested resource, unchanged.
async function nestedGroupsHandler(req, res) {
  try {
    if (!useSql) return res.json({ groups: [], memberships: [] });

    // Scope / containment resources (a capability @ a node) fan DOWN the Contains tree via the
    // effective-access engine. Returns null for a plain group, which falls through to the
    // group-membership expansion below.
    const containment = await expandCapabilityDown(req.params.groupId);
    if (containment) return res.json({ groups: containment.groups, memberships: containment.memberships });

    const p = await db.getPool();

    // Constrain nested resources to the matrix's resource-type filter (if any),
    // reusing the exact subquery /matrix/data builds for the top-level grid.
    const built = await resourceScopeFromBody(req.body);

    // Any resource where this group is the principal. We deliberately do NOT
    // filter by assignmentType so future group-as-principal types
    // (AppRole, directory roles, etc.) flow through automatically — but we DO
    // honour the matrix's resource-type filter so the nesting matches the grid.
    // Each query renders the resource fragment through its own binder.
    const gp = createParams();
    const gChildPh = gp.bind(req.params.groupId);
    const gResourceSql = built ? built.resource(gp.bind).sql : null;
    const groupsResClause = gResourceSql ? `AND ra."resourceId" IN ${gResourceSql}` : '';
    const groupsResult = await timedQuery(p, 'nested-groups-data', res, `
      SELECT DISTINCT
        ra."resourceId" AS "groupId",
        ra."resourceId" AS "resourceId",
        r."displayName",
        r."resourceType",
        r."resourceType" AS "groupTypeCalculated",
        r."description"
        FROM "ResourceAssignments" ra
        LEFT JOIN "Resources" r ON ra."resourceId" = r.id
       WHERE ra."principalId"::text = ${gChildPh}
         AND ra."principalType" ILIKE '%group%'
         ${groupsResClause}
    `, gp.params);

    const mp = createParams();
    const mChildPh = mp.bind(req.params.groupId);
    const mResourceSql = built ? built.resource(mp.bind).sql : null;
    const membersResClause = mResourceSql ? `AND ra2."resourceId" IN ${mResourceSql}` : '';
    const membersResult = await timedQuery(p, 'nested-groups-members', res, `
      SELECT
        p."resourceId",
        p."resourceId" AS "groupId",
        p."principalId" AS "memberId",
        p."membershipType"
        FROM "vw_ResourceUserPermissionAssignments" p
       WHERE p."resourceId" IN (
         SELECT ra2."resourceId"
           FROM "ResourceAssignments" ra2
          WHERE ra2."principalId"::text = ${mChildPh}
            AND ra2."principalType" ILIKE '%group%'
            ${membersResClause}
       )
       AND (p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')
    `, mp.params);

    return res.json({
      groups: groupsResult.rows || [],
      memberships: membersResult.rows || [],
    });
  } catch (err) {
    console.error('nested-groups query failed:', err.message);
    return res.json({ groups: [], memberships: [] });
  }
}

router.get('/group/:groupId/nested-groups', nestedGroupsHandler);
router.post('/group/:groupId/nested-groups', nestedGroupsHandler);

export default router;
