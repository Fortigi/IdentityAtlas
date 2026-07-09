// Permission-grid endpoints — /api/permissions (the matrix data feed) and
// /api/user-columns (its filter columns).
//
// Extracted verbatim from routes/permissions.js as part of splitting that fat
// controller (audit finding C1). Mounted by routes/permissions.js via
// router.use(), so the public paths are unchanged. No behaviour change.

import { Router } from 'express';
import { permissionAssignments } from '../../mock/data.js';
import { ensureTagTables } from '../tags.js';
import { getGroupColumns, getResourceColumns, getPrincipalOrUserColumns, getPrincipalOrUserColumnValues } from '../../db/columnCache.js';
import { timedRequest } from '../../perf/sqlTimer.js';
import { buildContextFilterSql, parseAndResolveContextFilters } from '../../contexts/contextFilters.js';
import { effectiveAccessForNodes } from '../../effectiveAccess/engine.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { useSql, db } from './shared.js';

const router = Router();

// Columns always handled with explicit aliases (not included in dynamic list)
const ALIASED_COLS = new Set(['displayName', 'userPrincipalName']);

// Aliases: Resources/GraphGroups column names → permission query aliases
// New model uses resourceDisplayName/resourceDescription, but we keep group aliases for backward compat
const GROUP_COL_ALIASES = { displayName: 'resourceDisplayName', description: 'resourceDescription' };
const GROUP_ALIAS_TO_COL = {
  resourceDisplayName: 'displayName', resourceDescription: 'description',
  // backward compat
  groupDisplayName: 'displayName', groupDescription: 'description',
};

// ─── GET /api/user-columns ────────────────────────────────────────
// Returns column names + distinct values from GraphUsers for filter dropdowns.
// Values come from the FULL dataset (not limited by userLimit), so dropdowns
// show all possible options regardless of which page of users is loaded.
router.get('/user-columns', async (req, res) => {
  // ?schema=true — return column names only (no distinct values). Fast path (~100ms).
  // Used by the frontend to immediately recognise which filters are server-side,
  // without waiting for the expensive UNION ALL distinct-values query.
  const schemaOnly = req.query.schema === 'true';

  try {
    if (!useSql) {
      const mockCols = {};
      for (const row of permissionAssignments) {
        for (const [key, val] of Object.entries(row)) {
          if (['groupId', 'memberId', 'memberDisplayName', 'memberUPN', 'memberType',
               'groupDisplayName', 'groupTypeCalculated', 'groupDescription',
               'membershipType', 'managedByAccessPackage'].includes(key)) continue;
          if (val == null || val === '') continue;
          if (!mockCols[key]) mockCols[key] = new Set();
          if (!schemaOnly) mockCols[key].add(String(val));
        }
      }
      return res.json(
        Object.entries(mockCols)
          .filter(([, vals]) => schemaOnly || (vals.size >= 1 && vals.size <= 500))
          .map(([column, vals]) => ({ column, values: schemaOnly ? [] : [...vals].sort() }))
      );
    }

    const p = await db.getPool();

    let grouped;
    if (schemaOnly) {
      // Fast: just schema names, no distinct value scan
      const cols = await getPrincipalOrUserColumns(p);
      grouped = Object.fromEntries(cols.map(c => [c.name, []]));
    } else {
      // Slow: cached distinct values (5-min TTL — avoids 44s UNION ALL on every load)
      grouped = { ...await getPrincipalOrUserColumnValues(p) };
    }

    // Add virtual __userTag column
    try {
      await ensureTagTables(p);
      const tagResult = await timedRequest(p, 'user-columns-tags', res).query(`
        SELECT t.name
        FROM "GraphTags" t
        WHERE t."entityType" = 'user'
          AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
        ORDER BY t.name
      `);
      const userTags = tagResult.recordset.map(r => r.name);
      grouped['__userTag'] = userTags; // always include values — tag query is fast
    } catch (e) { if (!isMissingSchema(e)) throw e; /* tag tables may not exist yet — skip silently */ }

    return res.json(
      Object.entries(grouped).map(([column, values]) => ({ column, values }))
    );
  } catch (err) {
    console.error('user-columns query failed:', err.message);
    return res.json([]);
  }
});

// ─── GET /api/permissions ─────────────────────────────────────────
// Query params:
//   userLimit (int)  - limit to top N users by assignment count
//   filters  (JSON)  - server-side filters: {"department":"HR","groupTypeCalculated":"Security Group"}
//                       User columns (GraphUsers) and group columns (GraphGroups) both supported.
router.get('/permissions', async (req, res) => {
  try {
    const userLimit = Math.min(Math.max(parseInt(req.query.userLimit) || 0, 0), 10000);

    // Parse filters (JSON object of field:value pairs)
    let requestedFilters = {};
    if (req.query.filters) {
      try { requestedFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
    }

    if (useSql) {
      const p = await db.getPool();

      // Return empty data when sync hasn't run yet. v5 always has Principals
      // (created by migrations) so this is mostly a safety net.
      const tableCheck = await p.request().query(
        `SELECT to_regclass('"Principals"') AS "principalsExists"`
      );
      if (!tableCheck.recordset[0].principalsExists) {
        return res.json({ data: [], totalUsers: 0, managedByPackages: [] });
      }

      // v5: always use the unified resource view + Principals table.
      // The legacy mat_/GraphUsers paths are gone.
      const permSource = '"vw_ResourceUserPermissionAssignments"';

      // Discover user and group columns dynamically
      const allCols = await getPrincipalOrUserColumns(p);
      const colNames = new Set(allCols.map(c => c.name));
      // Use Resources columns if available, fall back to GraphGroups
      let allGroupCols;
      try {
        allGroupCols = await getResourceColumns(p);
      } catch (e) {
        if (!isMissingSchema(e)) throw e;
        allGroupCols = await getGroupColumns(p);
      }
      const groupColNames = new Set(allGroupCols.map(c => GROUP_COL_ALIASES[c.name] || c.name));

      // Build dynamic user column SELECT (exclude aliased cols handled explicitly).
      // Postgres needs camelCase columns wrapped in double quotes. We include
      // a trailing comma so the calling SELECT can add a final column without
      // a syntax error when this list is empty.
      const dynamicUserColsList = allCols
        .filter(c => !ALIASED_COLS.has(c.name))
        .map(c => `u."${c.name}"`);
      const dynamicUserCols = dynamicUserColsList.length > 0
        ? dynamicUserColsList.join(',\n            ') + ','
        : '';

      // Resolve context filters (Phase 6). Each filter references a Contexts
      // row; we look up its targetType so the SQL helper knows which side of
      // the matrix (principals vs resources) to constrain.
      const resolvedContextFilters = await parseAndResolveContextFilters(
        req.query.contextFilters,
        async (ids) => {
          if (!ids || ids.length === 0) return [];
          const r = await db.query(
            `SELECT id, "targetType" FROM "Contexts" WHERE id = ANY($1::uuid[])`,
            [ids],
          );
          return r.rows || [];
        },
      );
      const {
        principalClauses: ctxPrincipalClauses,
        resourceClauses: ctxResourceClauses,
        innerPrincipalClauses: ctxInnerPrincipalClauses,
        innerResourceClauses: ctxInnerResourceClauses,
        bindings: ctxBindings,
      } = buildContextFilterSql(resolvedContextFilters);
      const ctxPrincipalWhere = ctxPrincipalClauses.length ? ' AND ' + ctxPrincipalClauses.join(' AND ') : '';
      const ctxResourceWhere  = ctxResourceClauses.length  ? ' AND ' + ctxResourceClauses.join(' AND ') : '';
      // Apply context filters inside the top-N subquery too, so the top-25
      // users are picked from within the filter (not just intersected after).
      const ctxInnerWhere =
        (ctxInnerPrincipalClauses.length ? ' AND ' + ctxInnerPrincipalClauses.join(' AND ') : '') +
        (ctxInnerResourceClauses.length  ? ' AND ' + ctxInnerResourceClauses.join(' AND ')  : '');

      // ── Effective access at scopes (engine path) ──────────────────────────
      // When the matrix is filtered by a Resource context whose members are SCOPE NODES (e.g. an
      // "all key vaults" or "all VMs" context), the declared-only matview shows nothing — the access
      // is inherited. Ask the engine for the EFFECTIVE access AT those scopes (declared + inherited)
      // and return those rows. Generic — any source with Contains + capability-resources. Falls
      // through to the normal declared-grant path when the members aren't scope nodes (no engine rows).
      const resourceCtxFilters = resolvedContextFilters.filter((f) => f.targetType === 'Resource');
      if (resourceCtxFilters.length > 0) {
        const memberIds = new Set();
        for (const f of resourceCtxFilters) {
          const memQ = f.includeChildren
            ? `WITH RECURSIVE st AS (
                 SELECT id FROM "Contexts" WHERE id = $1
                 UNION SELECT c.id FROM "Contexts" c JOIN st ON c."parentContextId" = st.id)
               SELECT DISTINCT "memberId" FROM "ContextMembers" WHERE "contextId" IN (SELECT id FROM st)`
            : `SELECT DISTINCT "memberId" FROM "ContextMembers" WHERE "contextId" = $1`;
          for (const row of (await db.query(memQ, [f.id])).rows) memberIds.add(row.memberId);
        }
        if (memberIds.size > 0) {
          const { rows: effRows } = await effectiveAccessForNodes([...memberIds]);
          if (effRows.length > 0) {
            const fmt = await db.query(`
              WITH eff AS (
                SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[])
                  AS t("resourceId", "memberId", "membershipType", "displayName", "resourceType")
              )
              SELECT e."resourceId", e."resourceId" AS "groupId",
                     e."displayName" AS "resourceDisplayName", e."displayName" AS "groupDisplayName",
                     e."resourceType", e."resourceType" AS "groupTypeCalculated",
                     NULL AS "resourceDescription", NULL AS "groupDescription",
                     NULL::int AS "systemId", NULL AS "systemName",
                     e."memberId", u."displayName" AS "memberDisplayName", u."email" AS "memberUPN",
                     u."principalType" AS "memberType", e."membershipType",
                     ${dynamicUserCols} false AS "managedByAccessPackage"
                FROM eff e LEFT JOIN "Principals" u ON e."memberId" = u.id
               WHERE (u."principalType" IS NULL OR u."principalType" != '#microsoft.graph.group')
            `, [
              effRows.map((r) => r.resourceId),
              effRows.map((r) => r.principalId),
              effRows.map((r) => r.membershipType),
              effRows.map((r) => r.displayName),
              effRows.map((r) => r.resourceType),
            ]);
            const totalResult = await db.query(
              `SELECT COUNT(*)::int AS "totalUsers" FROM "Principals" WHERE "principalType" IS NULL OR "principalType" != '#microsoft.graph.group'`,
            );
            return res.json({ data: fmt.rows, totalUsers: totalResult.rows[0].totalUsers, managedByPackages: [] });
          }
        }
      }

      // Extract special tag filters before regular validation
      let userTagFilter = null;
      let groupTagFilter = null;
      if (requestedFilters['__userTag']) {
        userTagFilter = String(requestedFilters['__userTag']);
        delete requestedFilters['__userTag'];
      }
      if (requestedFilters['__groupTag']) {
        groupTagFilter = String(requestedFilters['__groupTag']);
        delete requestedFilters['__groupTag'];
      }

      // Ensure tag tables exist for tag filter queries
      if (userTagFilter || groupTagFilter) {
        try {
          await ensureTagTables(p);
        } catch (e) {
          if (!isMissingSchema(e)) throw e;
          userTagFilter = null;
          groupTagFilter = null;
        }
      }

      // Validate and split filters into user vs group columns (parameterized)
      const validUserFilters = [];
      const validGroupFilters = [];
      for (const [field, value] of Object.entries(requestedFilters)) {
        if (value == null || String(value) === '') continue;
        if (colNames.has(field)) {
          validUserFilters.push({ field, value: String(value) });
        } else if (groupColNames.has(field)) {
          validGroupFilters.push({ field, value: String(value) });
        }
      }

      let filterWhere = '';
      let groupFilterWhere = '';
      let userTagJoin = '';
      let groupTagJoin = '';
      const addParams = (request) => {
        for (let i = 0; i < validUserFilters.length; i++) {
          const f = validUserFilters[i];
          filterWhere += ` AND u."${f.field}"::text = @f${i}`;
          request.input(`f${i}`, f.value);
        }
        for (let i = 0; i < validGroupFilters.length; i++) {
          const f = validGroupFilters[i];
          const realCol = GROUP_ALIAS_TO_COL[f.field] || f.field;
          groupFilterWhere += ` AND r."${realCol}"::text = @gf${i}`;
          request.input(`gf${i}`, f.value);
        }
        // Context-filter bindings (Phase 6).
        for (const [name, val] of Object.entries(ctxBindings)) {
          request.input(name, val);
        }
        if (userTagFilter) {
          userTagJoin = `
            INNER JOIN "GraphTagAssignments" _uta ON _uta."entityId" = UPPER(u.id::text)
            INNER JOIN "GraphTags" _ut ON _uta."tagId" = _ut.id AND _ut."name" = @__userTag AND _ut."entityType" = 'user'`;
          request.input('__userTag', userTagFilter);
        }
        if (groupTagFilter) {
          groupTagJoin = `
            INNER JOIN "GraphTagAssignments" _gta ON _gta."entityId" = UPPER(p."resourceId"::text)
            INNER JOIN "GraphTags" _gt ON _gta."tagId" = _gt.id AND _gt."name" = @__groupTag AND _gt."entityType" IN ('resource', 'group')`;
          request.input('__groupTag', groupTagFilter);
        }
      };

      // Combined query — single batch eliminates redundant table scans
      // Source indicator (mat/view/pre) visible in Performance page timings
      const sourceTag = permSource.startsWith('mat_') ? 'mat' : 'view';

      if (userLimit > 0) {
        filterWhere = '';
        groupFilterWhere = '';

        // ── Filter pushdown ──────────────────────────────────────────
        // If the request carries a __userTag filter, resolve it up front
        // and pass the principalId list as a `= ANY(@principalIds)` clause
        // so the planner can index-scan the matrix matview instead of
        // materializing 1.5M rows and throwing most of them away.
        //
        // The old code put the tag join at the top of the main query,
        // which forced a full-view scan before the filter could apply.
        let preFilteredUserIds = null;
        if (userTagFilter) {
          const tagUsersRes = await timedRequest(p, 'perm-tag-resolve', res)
            .input('__userTag', userTagFilter)
            .input('userLimit', userLimit)
            .query(`
              SELECT DISTINCT u.id
                FROM "Principals" u
                INNER JOIN "GraphTagAssignments" ta ON ta."entityId" = UPPER(u.id::text)
                INNER JOIN "GraphTags" t ON ta."tagId" = t.id
                 AND t."name" = @__userTag
                 AND t."entityType" = 'user'
               LIMIT @userLimit
            `);
          preFilteredUserIds = tagUsersRes.recordset.map(r => r.id);
          if (preFilteredUserIds.length === 0) {
            // No users match the tag — return empty rather than running
            // the expensive main query.
            return res.json({ data: [], totalUsers: 0, managedByPackages: [] });
          }
        }

        const request = timedRequest(p, 'perm-combined-limited', res);
        request.input('userLimit', userLimit);
        addParams(request);

        // Build the "which user ids to include" clause.
        // With a tag filter: direct `= ANY(@principalIds)` index-lookup.
        // Without one: inline `ORDER BY COUNT(*) DESC LIMIT @userLimit` against
        // the (now-materialized) matrix view.
        let userIdClause;
        if (preFilteredUserIds) {
          request.input('principalIds', preFilteredUserIds);
          userIdClause = `p."principalId" = ANY(@principalIds)`;
        } else {
          userIdClause = `p."principalId" IN (
            SELECT "principalId" FROM "vw_ResourceUserPermissionAssignments"
            WHERE ("principalType" IS NULL OR "principalType" != '#microsoft.graph.group')
              ${ctxInnerWhere}
            GROUP BY "principalId"
            ORDER BY COUNT(*) DESC
            LIMIT @userLimit
          )`;
        }

        const result = await request.query(`
          SELECT
            p."resourceId" AS "resourceId",
            p."resourceId" AS "groupId",
            r."displayName" AS "resourceDisplayName",
            r."displayName" AS "groupDisplayName",
            r."resourceType",
            r."resourceType" AS "groupTypeCalculated",
            r."description" AS "resourceDescription",
            r."description" AS "groupDescription",
            r."systemId",
            sys."displayName" AS "systemName",
            p."principalId" AS "memberId",
            u."displayName" AS "memberDisplayName",
            u."email" AS "memberUPN",
            p."principalType" AS "memberType",
            p."membershipType",
            ${dynamicUserCols}
            p."managedByAccessPackage"
          FROM "vw_ResourceUserPermissionAssignments" p
          INNER JOIN "Principals" u ON p."principalId" = u.id
          LEFT JOIN "Resources" r ON p."resourceId" = r.id
          LEFT JOIN "Systems" sys ON r."systemId" = sys.id
          ${groupTagJoin}
          WHERE (p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')
            AND ${userIdClause}
            ${groupFilterWhere}
            ${ctxPrincipalWhere}
            ${ctxResourceWhere}
        `);

        // Total user count — cheap from Principals, no need to scan the view.
        const totalResult = await timedRequest(p, 'perm-total-users', res).query(`
          SELECT COUNT(*)::int AS "totalUsers"
          FROM "Principals"
          WHERE "principalType" IS NULL OR "principalType" != '#microsoft.graph.group'
        `);

        // AP mapping — constrain to just the users we're about to return.
        // In the tag-filtered branch we already have the principal ID list.
        // In the top-N branch we pull the same top-N subquery so the
        // materialized view is hit on its (userId) index instead of a
        // full 410k-row scan. The data we return only needs AP entries for
        // the users in the result set; filtering here is both faster and
        // smaller.
        let apMapping = [];
        try {
          const apReq = timedRequest(p, 'perm-ap-mapping', res);
          let apWhere;
          if (preFilteredUserIds) {
            apReq.input('apPrincipalIds', preFilteredUserIds);
            apWhere = `WHERE ap."userId" = ANY(@apPrincipalIds)`;
          } else {
            apReq.input('apUserLimit', userLimit);
            // Context-filter bindings also needed here so the inner subquery
            // resolves the same top-N set as the main query.
            for (const [name, val] of Object.entries(ctxBindings)) {
              apReq.input(name, val);
            }
            apWhere = `WHERE ap."userId" IN (
              SELECT "principalId" FROM "vw_ResourceUserPermissionAssignments"
              WHERE ("principalType" IS NULL OR "principalType" != '#microsoft.graph.group')
                ${ctxInnerWhere}
              GROUP BY "principalId"
              ORDER BY COUNT(*) DESC
              LIMIT @apUserLimit
            )`;
          }
          const apRes = await apReq.query(`
            SELECT
              ap."userId" AS "memberId",
              ap."resourceId",
              ap."resourceId" AS "groupId",
              string_agg(ap."businessRoleId"::text, ',') AS "accessPackageIds"
            FROM "vw_UserPermissionAssignmentViaBusinessRole" ap
            ${apWhere}
            GROUP BY ap."userId", ap."resourceId"
          `);
          apMapping = apRes.recordset;
        } catch (e) { if (!isMissingSchema(e)) throw e; /* AP view may not exist */ }

        const managedByPackages = apMapping
          .filter(r => r.memberId)
          .map(r => ({
            memberId: r.memberId,
            resourceId: r.resourceId || r.groupId,
            groupId: r.groupId || r.resourceId,
            accessPackageIds: r.accessPackageIds ? r.accessPackageIds.split(',') : [],
          }));

        return res.json({
          data: result.recordset,
          totalUsers: totalResult.recordset[0].totalUsers,
          managedByPackages,
        });
      }

      // No user limit — single batch for main data + AP mapping
      const request = timedRequest(p, `perm-combined[${sourceTag}]`, res);
      filterWhere = '';
      groupFilterWhere = '';
      addParams(request);

      // v5: forced to the resource view (we always have it). Postgres has no
      // BEGIN TRY/END TRY, so the AP-mapping query is split out separately
      // and only runs when the AP view exists.
      const result = await request.query(`
        SELECT
          p."resourceId" AS "resourceId",
          p."resourceId" AS "groupId",
          r."displayName" AS "resourceDisplayName",
          r."displayName" AS "groupDisplayName",
          r."resourceType",
          r."resourceType" AS "groupTypeCalculated",
          r."description" AS "resourceDescription",
          r."description" AS "groupDescription",
          r."systemId",
          sys."displayName" AS "systemName",
          p."principalId" AS "memberId",
          u."displayName" AS "memberDisplayName",
          u."email" AS "memberUPN",
          p."principalType" AS "memberType",
          p."membershipType",
          ${dynamicUserCols}
          p."managedByAccessPackage"
        FROM "vw_ResourceUserPermissionAssignments" p
        INNER JOIN "Principals" u ON p."principalId" = u.id
        LEFT JOIN "Resources" r ON p."resourceId" = r.id
        LEFT JOIN "Systems" sys ON r."systemId" = sys.id
        ${userTagJoin}
        ${groupTagJoin}
        WHERE (p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')
          ${filterWhere}
          ${groupFilterWhere}
          ${ctxPrincipalWhere}
          ${ctxResourceWhere}
      `);
      // Total user count — same query as the limited branch for consistency.
      // Using Principals count (not distinct memberIds in the result) so the
      // slider max stays stable whether or not a limit is applied.
      const totalResult = await timedRequest(p, 'perm-total-users', res).query(`
        SELECT COUNT(*)::int AS "totalUsers"
        FROM "Principals"
        WHERE "principalType" IS NULL OR "principalType" != '#microsoft.graph.group'
      `);

      // AP mapping is optional — fetch separately, swallow errors.
      let apMapping = [];
      try {
        const apResult = await timedRequest(p, 'perm-ap-mapping', res).query(`
          SELECT
            ap."userId" AS "memberId",
            ap."resourceId" AS "resourceId",
            ap."resourceId" AS "groupId",
            string_agg(ap."businessRoleId"::text, ',') AS "accessPackageIds"
          FROM "vw_UserPermissionAssignmentViaBusinessRole" ap
          GROUP BY ap."userId", ap."resourceId"
        `);
        apMapping = apResult.recordset;
      } catch (e) { if (!isMissingSchema(e)) throw e; /* AP view may not exist */ }

      const managedByPackages = apMapping
        .filter(r => r.memberId)
        .map(r => ({
          memberId: r.memberId,
          resourceId: r.resourceId || r.groupId,
          groupId: r.groupId || r.resourceId,
          accessPackageIds: r.accessPackageIds ? r.accessPackageIds.split(',') : [],
        }));

      return res.json({
        data: result.recordset,
        totalUsers: totalResult.recordset[0].totalUsers,
        managedByPackages,
      });
    }

    // Mock data path (supports filters for local dev)
    let mockData = permissionAssignments;
    // Apply mock filters
    for (const [field, value] of Object.entries(requestedFilters)) {
      if (value != null && value !== '') {
        mockData = mockData.filter(r => String(r[field] ?? '') === String(value));
      }
    }
    const allUserIds = [...new Set(mockData.map(r => r.memberId))];
    if (userLimit > 0) {
      const userCounts = {};
      mockData.forEach(r => { userCounts[r.memberId] = (userCounts[r.memberId] || 0) + 1; });
      const topUserIds = new Set(
        Object.entries(userCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, userLimit)
          .map(e => e[0])
      );
      mockData = mockData.filter(r => topUserIds.has(r.memberId));
    }
    res.json({ data: mockData, totalUsers: allUserIds.length, managedByPackages: [] });
  } catch (err) {
    console.error('permissions query failed:', err.message, '\nStack:', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
