// Data-assembly helpers for GET /api/permissions (the matrix feed), extracted
// from routes/permissions/grid.js so each unit stays under the complexity
// threshold (the handler was cognitive 87 / cyclomatic 39 — the worst unit in
// the route layer). Pure builders (parse/split/shape/clause factories) are
// unit-tested directly in gridQuery.test.js; the DB-bound runners are covered
// through permissions.coverage.test.js and permissionsGrid.contract.test.js.
// All SQL is moved VERBATIM from the original handler — no behaviour change.

import { permissionAssignments } from '../../mock/data.js';
import { ensureTagTables } from '../tags.js';
import { getResourceColumns, getPrincipalOrUserColumns } from '../../db/columnCache.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { createParams } from '../../db/sqlParams.js';
import { buildContextFilterSql, parseAndResolveContextFilters } from '../../contexts/contextFilters.js';
import { effectiveAccessForNodes } from '../../effectiveAccess/engine.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { db } from './shared.js';
import { GROUP_PRINCIPAL_TYPE } from '../../lib/principalTypes.js';

// The shape returned when there's nothing to show (missing table, no tag matches).
export const EMPTY_GRID = { data: [], totalUsers: 0, managedByPackages: [] };

// Columns always handled with explicit aliases (not included in dynamic list)
const ALIASED_COLS = new Set(['displayName', 'userPrincipalName']);

// Aliases: Resources column names → permission query aliases
// New model uses resourceDisplayName/resourceDescription, but we keep group aliases for backward compat
const GROUP_COL_ALIASES = { displayName: 'resourceDisplayName', description: 'resourceDescription' };
const GROUP_ALIAS_TO_COL = {
  resourceDisplayName: 'displayName', resourceDescription: 'description',
  // backward compat
  groupDisplayName: 'displayName', groupDescription: 'description',
};

// ── Request parsing ────────────────────────────────────────────────
// userLimit (int, clamped 0..10000) + filters (a JSON object of field:value).
export function parsePermissionsRequest(req) {
  const userLimit = Math.min(Math.max(parseInt(req.query.userLimit) || 0, 0), 10000);
  let requestedFilters = {};
  if (req.query.filters) {
    try { requestedFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
  }
  return { userLimit, requestedFilters };
}

// Return empty data when sync hasn't run yet. v5 always has Principals (created
// by migrations) so this is mostly a safety net.
export async function principalsTableExists(p) {
  const tableCheck = await p.query(
    `SELECT to_regclass('"Principals"') AS "principalsExists"`
  );
  return Boolean(tableCheck.rows[0].principalsExists);
}

// Discover the user + group columns dynamically and build the dynamic user
// column SELECT fragment (excludes the aliased cols, trailing comma so the
// calling SELECT can append a final column even when this list is empty).
export async function discoverGridColumns(p) {
  const allCols = await getPrincipalOrUserColumns(p);
  const colNames = new Set(allCols.map(c => c.name));
  const allGroupCols = await getResourceColumns(p);
  const groupColNames = new Set(allGroupCols.map(c => GROUP_COL_ALIASES[c.name] || c.name));

  const dynamicUserColsList = allCols
    .filter(c => !ALIASED_COLS.has(c.name))
    .map(c => `u."${c.name}"`);
  const dynamicUserCols = dynamicUserColsList.length > 0
    ? dynamicUserColsList.join(',\n            ') + ','
    : '';

  return { colNames, groupColNames, dynamicUserCols };
}

// Resolve context filters (Phase 6). Each filter references a Contexts row; we
// look up its targetType so the SQL helper knows which side of the matrix
// (principals vs resources) to constrain.
export function resolveGridContextFilters(req) {
  return parseAndResolveContextFilters(
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
}

// Context-filter WHERE fragments, rendered per-query with that query's binder so
// each independent query (main, top-N subquery, AP) gets $N that line up with
// its own params. Returns the render closure.
export function makeContextClauses(resolvedContextFilters) {
  return (bind) => {
    const ctx = buildContextFilterSql(resolvedContextFilters, bind);
    return {
      ctxPrincipalWhere: ctx.principalClauses.length ? ' AND ' + ctx.principalClauses.join(' AND ') : '',
      ctxResourceWhere:  ctx.resourceClauses.length  ? ' AND ' + ctx.resourceClauses.join(' AND ')  : '',
      ctxInnerWhere:
        (ctx.innerPrincipalClauses.length ? ' AND ' + ctx.innerPrincipalClauses.join(' AND ') : '') +
        (ctx.innerResourceClauses.length  ? ' AND ' + ctx.innerResourceClauses.join(' AND ')  : ''),
    };
  };
}

// ── Effective access at scopes (engine path) ──────────────────────────────
// When the matrix is filtered by a Resource context whose members are SCOPE
// NODES (e.g. an "all key vaults" context), the declared-only matview shows
// nothing — the access is inherited. Ask the engine for the EFFECTIVE access AT
// those scopes and return those rows. Returns null (fall through to the normal
// declared-grant path) when the members aren't scope nodes (no engine rows).
export async function tryEffectiveAccessAtScopes({ resolvedContextFilters, dynamicUserCols }) {
  const resourceCtxFilters = resolvedContextFilters.filter((f) => f.targetType === 'Resource');
  if (resourceCtxFilters.length === 0) return null;

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
  if (memberIds.size === 0) return null;

  const { rows: effRows } = await effectiveAccessForNodes([...memberIds]);
  if (effRows.length === 0) return null;

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
     WHERE (u."principalType" IS NULL OR u."principalType" != '${GROUP_PRINCIPAL_TYPE}')
  `, [
    effRows.map((r) => r.resourceId),
    effRows.map((r) => r.principalId),
    effRows.map((r) => r.membershipType),
    effRows.map((r) => r.displayName),
    effRows.map((r) => r.resourceType),
  ]);
  const totalResult = await db.query(
    `SELECT COUNT(*)::int AS "totalUsers" FROM "Principals" WHERE "principalType" IS NULL OR "principalType" != '${GROUP_PRINCIPAL_TYPE}'`,
  );
  return { data: fmt.rows, totalUsers: totalResult.rows[0].totalUsers, managedByPackages: [] };
}

// Pull the special `__userTag` / `__groupTag` entries out of the filter object
// (mutating it) before regular validation.
export function extractTagFilters(requestedFilters) {
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
  return { userTagFilter, groupTagFilter };
}

// Ensure the tag tables exist for tag-filter queries. If they can't be created
// (missing schema), drop the tag filters rather than failing the request.
export async function ensureTagTablesForFilters(p, { userTagFilter, groupTagFilter }) {
  if (userTagFilter || groupTagFilter) {
    try {
      await ensureTagTables(p);
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
      return { userTagFilter: null, groupTagFilter: null };
    }
  }
  return { userTagFilter, groupTagFilter };
}

// Validate and split the requested filters into user vs group columns.
export function splitValidFilters(requestedFilters, colNames, groupColNames) {
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
  return { validUserFilters, validGroupFilters };
}

// Attribute-filter WHERE fragments + tag joins for one query, bound through that
// query's binder. `includeUserTag` is false on the top-N path (the user tag is
// applied up front as a principalId pre-filter instead). Returns the closure.
export function makeFilterClauses({ validUserFilters, validGroupFilters, userTagFilter, groupTagFilter }) {
  return (bind, { includeUserTag } = { includeUserTag: true }) => {
    let filterWhere = '', groupFilterWhere = '', userTagJoin = '', groupTagJoin = '';
    for (const f of validUserFilters) {
      filterWhere += ` AND u."${f.field}"::text = ${bind(f.value)}`;
    }
    for (const f of validGroupFilters) {
      const realCol = GROUP_ALIAS_TO_COL[f.field] || f.field;
      groupFilterWhere += ` AND r."${realCol}"::text = ${bind(f.value)}`;
    }
    if (includeUserTag && userTagFilter) {
      userTagJoin = `
        INNER JOIN "GraphTagAssignments" _uta ON _uta."entityId" = UPPER(u.id::text)
        INNER JOIN "GraphTags" _ut ON _uta."tagId" = _ut.id AND _ut."name" = ${bind(userTagFilter)} AND _ut."entityType" = 'user'`;
    }
    if (groupTagFilter) {
      groupTagJoin = `
        INNER JOIN "GraphTagAssignments" _gta ON _gta."entityId" = UPPER(p."resourceId"::text)
        INNER JOIN "GraphTags" _gt ON _gta."tagId" = _gt.id AND _gt."name" = ${bind(groupTagFilter)} AND _gt."entityType" IN ('resource', 'group')`;
    }
    return { filterWhere, groupFilterWhere, userTagJoin, groupTagJoin };
  };
}

// Shape the raw AP-mapping rows into the managedByPackages payload.
export function shapeManagedByPackages(apMapping) {
  return apMapping
    .filter(r => r.memberId)
    .map(r => ({
      memberId: r.memberId,
      resourceId: r.resourceId || r.groupId,
      groupId: r.groupId || r.resourceId,
      accessPackageIds: r.accessPackageIds ? r.accessPackageIds.split(',') : [],
    }));
}

// ── Top-N (userLimit > 0) branch ───────────────────────────────────────────
// Returns the response payload (never touches res except for timing labels).
export async function runLimitedGridQuery({ p, res, userLimit, dynamicUserCols, filterClauses, contextClauses, userTagFilter }) {
  // ── Filter pushdown ──────────────────────────────────────────
  // If the request carries a __userTag filter, resolve it up front and pass the
  // principalId list as a `= ANY($n)` clause so the planner can index-scan the
  // matrix matview instead of materializing 1.5M rows and throwing most away.
  let preFilteredUserIds = null;
  if (userTagFilter) {
    const { params: tp, bind: tbind } = createParams();
    const nameP = tbind(userTagFilter);
    const limP = tbind(userLimit);
    const tagUsersRes = await timedQuery(p, 'perm-tag-resolve', res, `
        SELECT DISTINCT u.id
          FROM "Principals" u
          INNER JOIN "GraphTagAssignments" ta ON ta."entityId" = UPPER(u.id::text)
          INNER JOIN "GraphTags" t ON ta."tagId" = t.id
           AND t."name" = ${nameP}
           AND t."entityType" = 'user'
         LIMIT ${limP}
      `, tp);
    preFilteredUserIds = tagUsersRes.rows.map(r => r.id);
    if (preFilteredUserIds.length === 0) {
      // No users match the tag — return empty rather than running the expensive
      // main query.
      return EMPTY_GRID;
    }
  }

  // Main query: attribute filters + context clauses + the user-id clause, all
  // bound through one binder (the user tag is applied above, not here).
  const { params, bind } = createParams();
  const fc = filterClauses(bind, { includeUserTag: false });
  const cc = contextClauses(bind);

  // Build the "which user ids to include" clause. With a tag filter: direct
  // `= ANY($n)` index-lookup. Without one: inline `ORDER BY COUNT(*) DESC LIMIT
  // $n` against the matrix view.
  let userIdClause;
  if (preFilteredUserIds) {
    userIdClause = `p."principalId" = ANY(${bind(preFilteredUserIds)})`;
  } else {
    userIdClause = `p."principalId" IN (
      SELECT "principalId" FROM "vw_ResourceUserPermissionAssignments"
      WHERE ("principalType" IS NULL OR "principalType" != '${GROUP_PRINCIPAL_TYPE}')
        ${cc.ctxInnerWhere}
      GROUP BY "principalId"
      ORDER BY COUNT(*) DESC
      LIMIT ${bind(userLimit)}
    )`;
  }

  const result = await timedQuery(p, 'perm-combined-limited', res, `
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
    ${fc.groupTagJoin}
    WHERE (p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')
      AND ${userIdClause}
      ${fc.filterWhere}
      ${fc.groupFilterWhere}
      ${cc.ctxPrincipalWhere}
      ${cc.ctxResourceWhere}
  `, params);

  // Total user count — cheap from Principals, no need to scan the view.
  const totalResult = await timedQuery(p, 'perm-total-users', res, `
    SELECT COUNT(*)::int AS "totalUsers"
    FROM "Principals"
    WHERE "principalType" IS NULL OR "principalType" != '${GROUP_PRINCIPAL_TYPE}'
  `, []);

  // AP mapping — constrain to just the users we're about to return. In the
  // tag-filtered branch we already have the principal ID list. In the top-N
  // branch we pull the same top-N subquery so the materialized view is hit on
  // its (userId) index instead of a full 410k-row scan.
  let apMapping = [];
  try {
    const { params: ap, bind: apbind } = createParams();
    let apWhere;
    if (preFilteredUserIds) {
      apWhere = `WHERE ap."userId" = ANY(${apbind(preFilteredUserIds)})`;
    } else {
      // Context filters also constrain the inner top-N subquery so it resolves
      // the same set as the main query.
      const apcc = contextClauses(apbind);
      apWhere = `WHERE ap."userId" IN (
        SELECT "principalId" FROM "vw_ResourceUserPermissionAssignments"
        WHERE ("principalType" IS NULL OR "principalType" != '${GROUP_PRINCIPAL_TYPE}')
          ${apcc.ctxInnerWhere}
        GROUP BY "principalId"
        ORDER BY COUNT(*) DESC
        LIMIT ${apbind(userLimit)}
      )`;
    }
    const apRes = await timedQuery(p, 'perm-ap-mapping', res, `
      SELECT
        ap."userId" AS "memberId",
        ap."resourceId",
        ap."resourceId" AS "groupId",
        string_agg(ap."businessRoleId"::text, ',') AS "accessPackageIds"
      FROM "vw_UserPermissionAssignmentViaBusinessRole" ap
      ${apWhere}
      GROUP BY ap."userId", ap."resourceId"
    `, ap);
    apMapping = apRes.rows;
  } catch (e) { if (!isMissingSchema(e)) throw e; /* AP view may not exist */ }

  return {
    data: result.rows,
    totalUsers: totalResult.rows[0].totalUsers,
    managedByPackages: shapeManagedByPackages(apMapping),
  };
}

// ── No user limit — single batch for main data + AP mapping ─────────────────
export async function runUnlimitedGridQuery({ p, res, dynamicUserCols, filterClauses, contextClauses }) {
  const { params, bind } = createParams();
  const fc = filterClauses(bind);
  const cc = contextClauses(bind);

  // v5: forced to the resource view (we always have it). Postgres has no BEGIN
  // TRY/END TRY, so the AP-mapping query is split out separately and only runs
  // when the AP view exists.
  const result = await timedQuery(p, `perm-combined[view]`, res, `
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
    ${fc.userTagJoin}
    ${fc.groupTagJoin}
    WHERE (p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')
      ${fc.filterWhere}
      ${fc.groupFilterWhere}
      ${cc.ctxPrincipalWhere}
      ${cc.ctxResourceWhere}
  `, params);
  // Total user count — same query as the limited branch for consistency. Using
  // Principals count (not distinct memberIds in the result) so the slider max
  // stays stable whether or not a limit is applied.
  const totalResult = await timedQuery(p, 'perm-total-users', res, `
    SELECT COUNT(*)::int AS "totalUsers"
    FROM "Principals"
    WHERE "principalType" IS NULL OR "principalType" != '${GROUP_PRINCIPAL_TYPE}'
  `, []);

  // AP mapping is optional — fetch separately, swallow errors.
  let apMapping = [];
  try {
    const apResult = await timedQuery(p, 'perm-ap-mapping', res, `
      SELECT
        ap."userId" AS "memberId",
        ap."resourceId" AS "resourceId",
        ap."resourceId" AS "groupId",
        string_agg(ap."businessRoleId"::text, ',') AS "accessPackageIds"
      FROM "vw_UserPermissionAssignmentViaBusinessRole" ap
      GROUP BY ap."userId", ap."resourceId"
    `, []);
    apMapping = apResult.rows;
  } catch (e) { if (!isMissingSchema(e)) throw e; /* AP view may not exist */ }

  return {
    data: result.rows,
    totalUsers: totalResult.rows[0].totalUsers,
    managedByPackages: shapeManagedByPackages(apMapping),
  };
}

// ── Mock-data path (supports filters for local dev) ─────────────────────────
export function runMockPermissions(requestedFilters, userLimit) {
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
  return { data: mockData, totalUsers: allUserIds.length, managedByPackages: [] };
}
