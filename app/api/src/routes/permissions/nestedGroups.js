// Matrix nested-group expand endpoints — /api/groups-with-nested and
// /api/group/:groupId/nested-groups.
//
// Extracted verbatim from routes/permissions.js (audit finding C1). Mounted by
// routes/permissions.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { timedRequest } from '../../perf/sqlTimer.js';
import { expandCapabilityDown } from '../../effectiveAccess/engine.js';
import { useSql, db } from './shared.js';

const router = Router();

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
    const result = await timedRequest(p, 'groups-with-nested', res).query(`
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
    `);
    return res.json({ groupIds: result.recordset.map(r => r.groupId) });
  } catch (err) {
    console.error('groups-with-nested query failed:', err.message);
    return res.json({ groupIds: [] });
  }
});

// GET /api/group/:groupId/nested-groups - the resources this group is a member
// of (parent groups, app roles, etc.) plus user memberships for those resources.
// Used by the matrix expand fanout: opening a group row reveals every resource
// its members inherit access to, with the same per-cell membership badges as
// the root matrix.
router.get('/group/:groupId/nested-groups', async (req, res) => {
  try {
    if (!useSql) return res.json({ groups: [], memberships: [] });

    // Scope / containment resources (a capability @ a node) fan DOWN the Contains tree via the
    // effective-access engine. Returns null for a plain group, which falls through to the
    // group-membership expansion below.
    const containment = await expandCapabilityDown(req.params.groupId);
    if (containment) return res.json({ groups: containment.groups, memberships: containment.memberships });

    const p = await db.getPool();

    const request = timedRequest(p, 'nested-groups-data', res);
    request.input('childGroupId', req.params.groupId);

    // Any resource where this group is the principal. We deliberately do NOT
    // filter by assignmentType so future group-as-principal types
    // (AppRole, directory roles, etc.) flow through automatically.
    const groupsResult = await request.query(`
      SELECT DISTINCT
        ra."resourceId" AS "groupId",
        ra."resourceId" AS "resourceId",
        r."displayName",
        r."resourceType",
        r."resourceType" AS "groupTypeCalculated",
        r."description"
        FROM "ResourceAssignments" ra
        LEFT JOIN "Resources" r ON ra."resourceId" = r.id
       WHERE ra."principalId"::text = @childGroupId
         AND ra."principalType" ILIKE '%group%'
    `);

    const membersRequest = timedRequest(p, 'nested-groups-members', res);
    membersRequest.input('childGroupId', req.params.groupId);
    const membersResult = await membersRequest.query(`
      SELECT
        p."resourceId",
        p."resourceId" AS "groupId",
        p."principalId" AS "memberId",
        p."membershipType"
        FROM "vw_ResourceUserPermissionAssignments" p
       WHERE p."resourceId" IN (
         SELECT ra2."resourceId"
           FROM "ResourceAssignments" ra2
          WHERE ra2."principalId"::text = @childGroupId
            AND ra2."principalType" ILIKE '%group%'
       )
       AND (p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')
    `);

    return res.json({
      groups: groupsResult.recordset || [],
      memberships: membersResult.recordset || [],
    });
  } catch (err) {
    console.error('nested-groups query failed:', err.message);
    return res.json({ groups: [], memberships: [] });
  }
});

export default router;
