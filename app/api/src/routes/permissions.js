import { Router } from 'express';
import { permissionAssignments } from '../mock/data.js';
import { ensureTagTables } from './tags.js';
import { ensureCategoryTables } from './categories.js';
import { getUserColumns, getGroupColumns, getResourceColumns, getPrincipalOrUserColumns, getUserColumnValues, getPrincipalOrUserColumnValues, FILTERABLE_TYPES } from '../db/columnCache.js';
import { timedRequest } from '../perf/sqlTimer.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

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
    } catch { /* tag tables may not exist yet — skip silently */ }

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

      // v5: always use the unified view; no materialized tables exist.
      const matCheck = await timedRequest(p, 'perm-mat-check', res).query(`
        SELECT
          to_regclass('"vw_ResourceUserPermissionAssignments"') AS "resourceViewExists",
          to_regclass('"Principals"') AS "principalsExists",
          to_regclass('"vw_UserPermissionAssignmentViaBusinessRole"') AS "matApExists"
      `);
      // v5: always use the unified resource view + Principals table.
      // The legacy mat_/GraphUsers paths are gone.
      const permSource = '"vw_ResourceUserPermissionAssignments"';
      const COL_RES = 'resourceId';
      const COL_PRINC = 'principalId';
      const COL_PTYPE = 'principalType';
      const apSource = '"vw_UserPermissionAssignmentViaBusinessRole"';
      const hasPrecomputedCounts = false;
      const userTable = '"Principals"';
      const upnCol = 'u."email"';

      // Discover user and group columns dynamically
      const allCols = await getPrincipalOrUserColumns(p);
      const colNames = new Set(allCols.map(c => c.name));
      // Use Resources columns if available, fall back to GraphGroups
      let allGroupCols;
      try {
        allGroupCols = await getResourceColumns(p);
      } catch {
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
        } catch {
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
            apWhere = `WHERE ap."userId" IN (
              SELECT "principalId" FROM "vw_ResourceUserPermissionAssignments"
              WHERE ("principalType" IS NULL OR "principalType" != '#microsoft.graph.group')
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
        } catch { /* AP view may not exist */ }

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
      } catch { /* AP view may not exist */ }

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

// GET /api/access-package-groups - Access package to group/resource mapping
// Also aliased as /api/access-package-resources
router.get('/access-package-groups', accessPackageResourcesHandler);
router.get('/access-package-resources', accessPackageResourcesHandler);

async function accessPackageResourcesHandler(req, res) {
  try {
    if (useSql) {
      const p = await db.getPool();
      try { await ensureCategoryTables(p); } catch { /* category tables optional */ }
      // Performance notes:
      //  - Previous version returned one row per (AP, resource) pair and
      //    let Node de-normalize it. On the load-test dataset that was
      //    ~100k rows × 15 columns → 30 MB of JSON and ~15 s in Express
      //    serialization alone, even though the SQL itself was ~2 s.
      //  - We now aggregate server-side into one row per AP with a
      //    json_agg'd array of resources. Same data, ~100× fewer rows,
      //    ~100× less JSON work in Node.
      //  - The client side is responsible for flattening if it needs a
      //    (ap, resource) row shape — most callers want the grouped view.
      const result = await timedRequest(p, 'ap-groups', res).query(`
        WITH ac AS (
          SELECT "resourceId", COUNT(*)::int AS cnt
            FROM "ResourceAssignments"
           WHERE ("state" = 'delivered' OR "state" IS NULL)
             AND "assignmentType" = 'Governed'
           GROUP BY "resourceId"
        )
        SELECT
          ap.id                            AS "accessPackageId",
          ap.id                            AS "businessRoleId",
          ap."displayName"                 AS "accessPackageName",
          ap."systemId"                    AS "systemId",
          c."displayName"                  AS "catalogName",
          COALESCE(ac.cnt, 0)              AS "totalAssignments",
          cat.id                           AS "categoryId",
          cat."name"                       AS "categoryName",
          cat."color"                      AS "categoryColor",
          COALESCE(
            json_agg(
              json_build_object(
                'resourceId',   rrs."childResourceId",
                'groupId',      rrs."childResourceId",
                'resourceName', r."displayName",
                'groupName',    r."displayName",
                'resourceType', r."resourceType",
                'systemId',     r."systemId",
                'roleName',     rrs."roleName"
              )
              ORDER BY r."displayName"
            ) FILTER (WHERE rrs."childResourceId" IS NOT NULL),
            '[]'::json
          ) AS resources
        FROM "Resources" ap
        LEFT JOIN "ResourceRelationships" rrs
               ON rrs."parentResourceId" = ap.id
              AND rrs."relationshipType" = 'Contains'
        LEFT JOIN "Resources" r ON rrs."childResourceId" = r.id
        LEFT JOIN "GovernanceCatalogs" c ON ap."catalogId" = c.id
        LEFT JOIN ac ON ac."resourceId" = ap.id
        LEFT JOIN "GovernanceCategoryAssignments" ca ON ap.id::text = ca."resourceId"
        LEFT JOIN "GovernanceCategories" cat ON ca."categoryId" = cat.id
        WHERE ap."resourceType" = 'BusinessRole'
        GROUP BY ap.id, ap."displayName", ap."systemId", c."displayName",
                 ac.cnt, cat.id, cat."name", cat."color"
        ORDER BY ap."displayName"
      `);

      // Callers historically expected a flat (ap, resource) shape. Flatten
      // on the Node side — cheap because postgres already did the join.
      const flat = [];
      for (const row of result.recordset) {
        const base = {
          accessPackageId:   row.accessPackageId,
          businessRoleId:    row.businessRoleId,
          accessPackageName: row.accessPackageName,
          systemId:          row.systemId,
          catalogName:       row.catalogName,
          totalAssignments:  row.totalAssignments,
          categoryId:        row.categoryId,
          categoryName:      row.categoryName,
          categoryColor:     row.categoryColor,
        };
        const resources = Array.isArray(row.resources) ? row.resources : [];
        if (resources.length === 0) {
          flat.push({ ...base, resourceId: null, groupId: null, resourceName: null, groupName: null, resourceType: null, roleName: null });
          continue;
        }
        for (const r of resources) {
          flat.push({ ...base, ...r });
        }
      }
      return res.json(flat);
    }
    res.json([]);
  } catch (err) {
    // Table may not exist in this environment — return empty instead of 500
    console.error('access-package-groups query failed:', err.message);
    res.json([]);
  }
}

// GET /api/sync-log - Recent sync log entries from GraphSyncLog
router.get('/sync-log', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

    if (useSql) {
      const p = await db.getPool();
      // Check if GraphSyncLog table exists before querying
      const tableCheck = await timedRequest(p, 'sync-log-check', res).query(`
        SELECT to_regclass('"GraphSyncLog"') AS "tableExists"
      `);
      if (!tableCheck.recordset[0].tableExists) {
        return res.json([]);
      }

      const result = await timedRequest(p, 'sync-log-data', res).input('limit', limit).query(`
        SELECT "Id", "SyncType", "StartTime", "EndTime", "DurationSeconds",
               "RecordCount", "Status", "ErrorMessage", "TableName", "CreatedAt"
          FROM "GraphSyncLog"
         ORDER BY "StartTime" DESC
         LIMIT @limit
      `);
      return res.json(result.recordset);
    }

    // Mock data: generate realistic sync log entries
    const syncTypes = [
      { type: 'Users', table: 'GraphUsers', records: 1247 },
      { type: 'Groups', table: 'GraphGroups', records: 389 },
      { type: 'GroupMembers', table: 'GraphGroupMembers', records: 4521 },
      { type: 'GroupTransitiveMembers', table: 'GraphGroupTransitiveMembers', records: 8932 },
      { type: 'GroupEligibleMembers', table: 'GraphGroupEligibleMembers', records: 156 },
      { type: 'GroupOwners', table: 'GraphGroupOwners', records: 412 },
      { type: 'Catalogs', table: 'GovernanceCatalogs', records: 12 },
      { type: 'AccessPackages', table: 'Resources (BusinessRole)', records: 67 },
      { type: 'AccessPackageAssignments', table: 'ResourceAssignments (Governed)', records: 834 },
      { type: 'AccessPackageResourceRoleScopes', table: 'ResourceRelationships (Contains)', records: 203 },
      { type: 'AccessPackageAssignmentPolicies', table: 'AssignmentPolicies', records: 71 },
      { type: 'AccessPackageAssignmentRequests', table: 'AssignmentRequests', records: 2103 },
      { type: 'AccessPackageAccessReviews', table: 'CertificationDecisions', records: 45 },
      { type: 'MaterializedViews', table: 'mat_UserPermissionAssignments', records: 0 },
      { type: 'RiskScoring', table: 'GraphUsers,GraphGroups', records: 1636 },
    ];
    const mockLogs = [];
    let id = 1;
    // Generate 2 full sync runs
    for (let run = 0; run < 2; run++) {
      const baseTime = new Date(Date.now() - (run * 24 * 60 * 60 * 1000) - (2 * 60 * 60 * 1000));
      let offset = 0;
      for (const st of syncTypes) {
        const duration = Math.floor(Math.random() * 120) + 5;
        const start = new Date(baseTime.getTime() + offset * 1000);
        const end = new Date(start.getTime() + duration * 1000);
        const isFailed = run === 1 && st.type === 'AccessPackageAccessReviews';
        mockLogs.push({
          Id: id++,
          SyncType: st.type,
          StartTime: start.toISOString(),
          EndTime: end.toISOString(),
          DurationSeconds: duration,
          RecordCount: isFailed ? 0 : st.records + Math.floor(Math.random() * 20),
          Status: isFailed ? 'Failed' : 'Success',
          ErrorMessage: isFailed ? 'The remote server returned an error: (403) Forbidden.' : null,
          TableName: st.table,
          CreatedAt: end.toISOString(),
        });
        offset += duration + 2;
      }
    }
    mockLogs.sort((a, b) => new Date(b.StartTime) - new Date(a.StartTime));
    res.json(mockLogs.slice(0, limit));
  } catch (err) {
    console.error('sync-log query failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/groups-with-nested - resource/group IDs that are members of other groups
// (i.e., groups whose members gain indirect access to parent groups)
router.get('/groups-with-nested', async (req, res) => {
  try {
    if (!useSql) return res.json({ groupIds: [] });
    const p = await db.getPool();
    // v5: only the universal resource model exists, no GraphGroupMembers fallback.
    // UUIDs are returned as strings already (no UPPER cast needed).
    const result = await timedRequest(p, 'groups-with-nested', res).query(`
      SELECT DISTINCT "principalId"::text AS "groupId"
        FROM "ResourceAssignments"
       WHERE "principalType" LIKE '%group%'
         AND "assignmentType" = 'Direct'
    `);
    return res.json({ groupIds: result.recordset.map(r => r.groupId) });
  } catch (err) {
    console.error('groups-with-nested query failed:', err.message);
    return res.json({ groupIds: [] });
  }
});

// GET /api/group/:groupId/nested-groups - parent groups this group is a member of,
// plus user memberships for those parent groups (showing indirect access gained)
router.get('/group/:groupId/nested-groups', async (req, res) => {
  try {
    if (!useSql) return res.json({ groups: [], memberships: [] });
    const p = await db.getPool();

    // v5: query the unified resource view directly. No fallback to v4
    // GraphGroupMembers, no UPPER(uuid) (postgres uuid is already canonical).
    const request = timedRequest(p, 'nested-groups-data', res);
    request.input('childGroupId', req.params.groupId);

    const groupsResult = await request.query(`
      SELECT
        ra."resourceId" AS "groupId",
        ra."resourceId" AS "resourceId",
        r."displayName",
        r."resourceType",
        r."resourceType" AS "groupTypeCalculated",
        r."description"
        FROM "ResourceAssignments" ra
        LEFT JOIN "Resources" r ON ra."resourceId" = r.id
       WHERE ra."principalId"::text = @childGroupId
         AND ra."principalType" LIKE '%group%'
         AND ra."assignmentType" = 'Direct'
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
            AND ra2."principalType" LIKE '%group%'
            AND ra2."assignmentType" = 'Direct'
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
