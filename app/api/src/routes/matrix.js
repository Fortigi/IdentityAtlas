// Wizard-driven Matrix endpoints.
//
// The legacy /api/permissions endpoint stays in place for backwards-compat
// shareable URLs; this router serves the redesigned matrix tab that requires
// an explicit subject/resource filter before any data is loaded.
//
// Endpoints
//   POST   /api/matrix/data                — main matrix payload
//   POST   /api/matrix/preview             — counts for the wizard
//   GET    /api/matrix/columns?entity=…    — column schema + distinct values
//   GET    /api/matrix/saved-filters       — list (org-wide)
//   POST   /api/matrix/saved-filters       — create
//   PUT    /api/matrix/saved-filters/:id   — rename / replace contents
//   DELETE /api/matrix/saved-filters/:id   — remove

import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as db from '../db/connection.js';
import { timedRequest } from '../perf/sqlTimer.js';
import {
  buildEntitySubquery,
  collectContextIds,
  UUID_RE,
} from '../matrix/filterSql.js';
import {
  generateSampleDates,
  buildScopeAsofSql,
  historyStartSql,
} from '../matrix/scopeHistory.js';
import {
  getPrincipalColumns,
  getResourceColumns,
  getPrincipalColumnValues,
  getResourceColumnValues,
} from '../db/columnCache.js';
import { resolveAttrExpr } from '../matrix/attrExpr.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

const ROW_TYPES = new Set(['principal', 'identity']);
const SAFE_IDENT_RE = /^[a-zA-Z0-9_]+$/;
const FILTERABLE_TYPES = new Set([
  'text', 'character varying', 'character', 'boolean',
  'integer', 'bigint', 'smallint',
]);

// ─── Identity column discovery (small enough to live here) ──────────

let identityColumnsCache = null;
let identityColumnsCacheTime = 0;
let identityValuesCache = null;
let identityValuesCacheTime = 0;
const IDENTITY_CACHE_TTL = 5 * 60 * 1000;

async function getIdentityColumns() {
  const now = Date.now();
  if (identityColumnsCache && (now - identityColumnsCacheTime) < IDENTITY_CACHE_TTL) {
    return identityColumnsCache;
  }
  const r = await db.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Identities'
        AND column_name NOT IN ('id', 'extendedAttributes')
      ORDER BY ordinal_position`
  );
  identityColumnsCache = r.rows.map(row => ({
    name: row.column_name,
    rawName: row.column_name,
    type: row.data_type,
  }));
  identityColumnsCacheTime = now;
  return identityColumnsCache;
}

async function getIdentityColumnValues() {
  const now = Date.now();
  if (identityValuesCache && (now - identityValuesCacheTime) < IDENTITY_CACHE_TTL) {
    return identityValuesCache;
  }
  const grouped = {};

  // Distinct values for real, filterable columns.
  const cols = await getIdentityColumns();
  const filterable = cols.filter(c => FILTERABLE_TYPES.has(c.type) && SAFE_IDENT_RE.test(c.rawName));
  if (filterable.length > 0) {
    const parts = filterable.map(c =>
      `SELECT '${c.name}' AS col, val FROM (
         SELECT DISTINCT "${c.rawName}"::text AS val FROM "Identities"
          WHERE "${c.rawName}" IS NOT NULL AND "${c.rawName}"::text <> ''
          LIMIT 500
       ) t`
    );
    const r = await db.query(parts.join('\nUNION ALL\n') + '\nORDER BY col, val');
    for (const row of r.rows) {
      if (!grouped[row.col]) grouped[row.col] = [];
      grouped[row.col].push(row.val);
    }
  }

  // Extension-attribute keys + distinct values, surfaced as ext.<key> so they
  // can be picked and filtered just like Principal/Resource ext attributes.
  try {
    const ext = await db.query(`
      SELECT col, val FROM (
        SELECT DISTINCT 'ext.' || e.key AS col, e.value AS val
          FROM "Identities" i, LATERAL jsonb_each_text(i."extendedAttributes") e
         WHERE i."extendedAttributes" IS NOT NULL
           AND e.value IS NOT NULL AND e.value <> ''
      ) t
      ORDER BY col, val
      LIMIT 5000
    `);
    for (const row of ext.rows) {
      if (!grouped[row.col]) grouped[row.col] = [];
      if (grouped[row.col].length < 500) grouped[row.col].push(row.val);
    }
  } catch { /* extendedAttributes column may be absent on older schemas */ }

  identityValuesCache = grouped;
  identityValuesCacheTime = now;
  return identityValuesCache;
}

// ─── Helpers ────────────────────────────────────────────────────────

function parseFilter(body) {
  const f = body && body.filter;
  if (!f || typeof f !== 'object') return null;
  const rowType = ROW_TYPES.has(f.rowType) ? f.rowType : 'principal';
  return {
    rowType,
    subject:  normaliseBlock(f.subject),
    resource: normaliseBlock(f.resource),
    // Roll-up: aggregate the subject axis by this attribute (real column or
    // ext.<key>). null = off. Validated against real columns in the handler.
    rollup: typeof f.rollup === 'string' && f.rollup ? f.rollup : null,
    // Subject-axis sort order — client-side only, but normalised here so the
    // shape is consistent across endpoints. Max 3 attributes.
    sortAttributes: normaliseSortAttributes(f.sortAttributes),
  };
}

export function normaliseSortAttributes(arr) {
  const DEFAULT = [{ attribute: 'department', dir: 'asc' }];
  if (!Array.isArray(arr)) return DEFAULT;
  const out = [];
  for (const a of arr) {
    if (!a || typeof a.attribute !== 'string' || !a.attribute) continue;
    out.push({ attribute: a.attribute, dir: a.dir === 'desc' ? 'desc' : 'asc' });
    if (out.length === 3) break;
  }
  return out.length ? out : DEFAULT;
}

function normaliseBlock(b) {
  if (!b || typeof b !== 'object') return { include: [], exclude: [] };
  return {
    include: Array.isArray(b.include) ? b.include : [],
    exclude: Array.isArray(b.exclude) ? b.exclude : [],
  };
}


async function resolveContextTypes(filter) {
  const ids = collectContextIds(filter);
  if (ids.length === 0) return new Map();
  const r = await db.query(
    `SELECT id, "targetType" FROM "Contexts" WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(r.rows.map(row => [row.id, row.targetType]));
}

async function buildSubqueries(filter) {
  const [principalCols, resourceCols, identityCols, contextTypes] = await Promise.all([
    getPrincipalColumns(),
    getResourceColumns(),
    getIdentityColumns(),
    resolveContextTypes(filter),
  ]);
  const principalColSet = new Set(principalCols.map(c => c.name));
  const resourceColSet  = new Set(resourceCols.map(c => c.name));
  const identityColSet  = new Set(identityCols.map(c => c.name));

  const subjectEntity = filter.rowType === 'identity' ? 'Identity' : 'Principal';
  const subjectValidCols = filter.rowType === 'identity' ? identityColSet : principalColSet;

  const subject = buildEntitySubquery({
    entity: subjectEntity,
    include: filter.subject.include,
    exclude: filter.subject.exclude,
    validColumns: subjectValidCols,
    contextTypes,
    bindingPrefix: 'sf',
  });
  const resource = buildEntitySubquery({
    entity: 'Resource',
    include: filter.resource.include,
    exclude: filter.resource.exclude,
    validColumns: resourceColSet,
    contextTypes,
    bindingPrefix: 'rf',
  });

  return {
    subjectSql:    subject.sql,
    resourceSql:   resource.sql,
    bindings:      { ...subject.bindings, ...resource.bindings },
    warnings:      [...subject.warnings, ...resource.warnings],
    principalCols,
    resourceCols,
    identityCols,
  };
}

// Run a single-cell COUNT query with the given bindings; returns the integer.
async function runCount(p, label, res, sql, bindings) {
  const r = timedRequest(p, label, res);
  for (const [k, v] of Object.entries(bindings)) r.input(k, v);
  const result = await r.query(sql);
  return result.recordset[0]?.c ?? 0;
}

function subjectScopeClauses(rowType, subjectSql) {
  const subjectTable = rowType === 'identity' ? 'Identities' : 'Principals';
  // For principals, exclude group-shaped accounts so counts match what the
  // matrix actually renders.
  const baseWhere = rowType === 'principal'
    ? `("principalType" IS NULL OR "principalType" != '#microsoft.graph.group')`
    : null;
  const idClause = subjectSql ? `id IN ${subjectSql}` : null;
  const clauses = [baseWhere, idClause].filter(Boolean);
  return {
    subjectTable,
    where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
    baseWhere: baseWhere ? ` WHERE ${baseWhere}` : '',
  };
}

// Subject/resource scope counts shared by /matrix/data (flat + roll-up paths).
async function scopeCounts(p, res, rowType, built) {
  const subj = subjectScopeClauses(rowType, built.subjectSql);
  const [subjectCount, subjectTotal, resourceCount, resourceTotal] = await Promise.all([
    runCount(p, 'matrix-data-subject-count', res,
      `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.where}`, built.bindings),
    runCount(p, 'matrix-data-subject-total', res,
      `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.baseWhere}`, {}),
    runCount(p, 'matrix-data-resource-count', res,
      `SELECT COUNT(*)::int AS c FROM "Resources"${built.resourceSql ? ` WHERE id IN ${built.resourceSql}` : ''}`, built.bindings),
    runCount(p, 'matrix-data-resource-total', res,
      `SELECT COUNT(*)::int AS c FROM "Resources"`, {}),
  ]);
  return { subjectCount, subjectTotal, resourceCount, resourceTotal };
}

// Pure builder for the roll-up aggregation: count DISTINCT subjects with a
// Direct assignment, grouped by (resource, attribute value). Direct only —
// Indirect/Owner/Eligible are intentionally ignored. Exported for unit tests.
export function buildRollupSql({ attrExpr, subjectJoin, subjectIdExpr, subjectIdForFilter, subjectSql, resourceSql }) {
  const where = [
    `(p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')`,
    `p."membershipType" = 'Direct'`,
  ];
  if (subjectSql)  where.push(`${subjectIdForFilter} IN ${subjectSql}`);
  if (resourceSql) where.push(`p."resourceId" IN ${resourceSql}`);
  const grp = `COALESCE(NULLIF(${attrExpr}::text, ''), '(none)')`;
  return `
    SELECT p."resourceId"                        AS "resourceId",
           r."displayName"                       AS "resourceDisplayName",
           r."resourceType",
           r."description"                       AS "resourceDescription",
           r."systemId",
           sys."displayName"                     AS "systemName",
           ${grp}                                AS "groupValue",
           COUNT(DISTINCT ${subjectIdExpr})::int AS "directCount"
      FROM "vw_ResourceUserPermissionAssignments" p
      ${subjectJoin}
      LEFT JOIN "Resources" r ON p."resourceId" = r.id
      LEFT JOIN "Systems" sys ON r."systemId" = sys.id
     WHERE ${where.join(' AND ')}
     GROUP BY p."resourceId", r."displayName", r."resourceType", r."description",
              r."systemId", sys."displayName", ${grp}
  `;
}

// Pure builder for the roll-up business-role (SOLL) counts: distinct in-scope
// subjects holding each resource via each business role. Exported for tests.
export function buildRollupRolesSql({ brMemberId, brJoin, subjectSql, resourceSql }) {
  const where = [];
  if (subjectSql)  where.push(`${brMemberId} IN ${subjectSql}`);
  if (resourceSql) where.push(`br."resourceId" IN ${resourceSql}`);
  return `
    SELECT br."resourceId"     AS "resourceId",
           br."businessRoleId" AS "roleId",
           role."displayName"  AS "roleName",
           COUNT(DISTINCT ${brMemberId})::int AS "count"
      FROM "vw_UserPermissionAssignmentViaBusinessRole" br
      ${brJoin}
      LEFT JOIN "Resources" role ON role.id = br."businessRoleId"
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY br."resourceId", br."businessRoleId", role."displayName"
  `;
}

// ─── POST /api/matrix/preview ───────────────────────────────────────
router.post('/matrix/preview', async (req, res) => {
  if (!useSql) {
    return res.json({
      subjectCount: 0, subjectTotal: 0,
      resourceCount: 0, resourceTotal: 0,
      assignmentCount: 0,
    });
  }
  const filter = parseFilter(req.body);
  if (!filter) return res.status(400).json({ error: 'Invalid filter body' });

  try {
    const built = await buildSubqueries(filter);
    const p = await db.getPool();
    const subj = subjectScopeClauses(filter.rowType, built.subjectSql);

    const subjectIdExpr = filter.rowType === 'identity' ? 'im."identityId"' : 'p."principalId"';
    const assignmentJoin = filter.rowType === 'identity'
      ? `INNER JOIN "IdentityMembers" im ON im."principalId" = p."principalId"`
      : '';
    const assignmentWhere = [`(p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')`];
    if (built.subjectSql)  assignmentWhere.push(`${subjectIdExpr} IN ${built.subjectSql}`);
    if (built.resourceSql) assignmentWhere.push(`p."resourceId" IN ${built.resourceSql}`);

    const [subjectCount, subjectTotal, resourceCount, resourceTotal, assignmentCount] = await Promise.all([
      runCount(p, 'matrix-preview-subject', res,
        `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.where}`,
        built.bindings),
      runCount(p, 'matrix-preview-subject-total', res,
        `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.baseWhere}`,
        {}),
      runCount(p, 'matrix-preview-resource', res,
        `SELECT COUNT(*)::int AS c FROM "Resources"${built.resourceSql ? ` WHERE id IN ${built.resourceSql}` : ''}`,
        built.bindings),
      runCount(p, 'matrix-preview-resource-total', res,
        `SELECT COUNT(*)::int AS c FROM "Resources"`,
        {}),
      runCount(p, 'matrix-preview-assignments', res,
        `SELECT COUNT(*)::int AS c FROM (
           SELECT DISTINCT ${subjectIdExpr} AS sid, p."resourceId" AS rid
             FROM "vw_ResourceUserPermissionAssignments" p
             ${assignmentJoin}
            WHERE ${assignmentWhere.join(' AND ')}
         ) t`,
        built.bindings),
    ]);

    return res.json({
      subjectCount,
      subjectTotal,
      resourceCount,
      resourceTotal,
      assignmentCount,
      warnings: built.warnings,
    });
  } catch (err) {
    console.error('matrix/preview failed:', err.message);
    return res.status(500).json({ error: 'Preview failed' });
  }
});

// ─── POST /api/matrix/scope-stats ───────────────────────────────────
// Richer counts for the current selection than /preview: subject + resource
// totals PLUS the governed-vs-non-governed assignment split. Powers the Scope
// Statistics panel. "Governed" mirrors the matrix's own managed/SOLL semantics: a
// (principal, resource) pair is governed when the membership is covered by a business
// role the user holds — it appears in vw_UserPermissionAssignmentViaBusinessRole
// (a BusinessRole that Contains the group AND a Governed assignment of that role to the
// user). This is exactly what the matrix colours as SOLL.
router.post('/matrix/scope-stats', async (req, res) => {
  if (!useSql) {
    return res.json({
      subjectCount: 0, resourceCount: 0,
      assignmentCount: 0, governedAssignmentCount: 0, ungovernedAssignmentCount: 0,
      governedPct: 0, rowType: 'principal',
    });
  }
  const filter = parseFilter(req.body);
  if (!filter) return res.status(400).json({ error: 'Invalid filter body' });

  try {
    const built = await buildSubqueries(filter);
    const p = await db.getPool();
    const subj = subjectScopeClauses(filter.rowType, built.subjectSql);

    const subjectIdExpr = filter.rowType === 'identity' ? 'im."identityId"' : 'p."principalId"';
    const assignmentJoin = filter.rowType === 'identity'
      ? `INNER JOIN "IdentityMembers" im ON im."principalId" = p."principalId"`
      : '';
    const assignmentWhere = [`(p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')`];
    if (built.subjectSql)  assignmentWhere.push(`${subjectIdExpr} IN ${built.subjectSql}`);
    if (built.resourceSql) assignmentWhere.push(`p."resourceId" IN ${built.resourceSql}`);

    // One pair-level aggregation: distinct (subject, resource) pairs, each
    // flagged governed if ANY of its assignment rows is access-package managed.
    const pairReq = timedRequest(p, 'matrix-scope-pairs', res);
    for (const [k, v] of Object.entries(built.bindings)) pairReq.input(k, v);
    const pairSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE managed)::int AS governed
      FROM (
        SELECT ${subjectIdExpr} AS sid, p."resourceId" AS rid,
               bool_or(br."userId" IS NOT NULL) AS managed
          FROM "vw_ResourceUserPermissionAssignments" p
          ${assignmentJoin}
          LEFT JOIN "vw_UserPermissionAssignmentViaBusinessRole" br
            ON br."userId" = p."principalId" AND br."resourceId" = p."resourceId"
         WHERE ${assignmentWhere.join(' AND ')}
         GROUP BY ${subjectIdExpr}, p."resourceId"
      ) pairs`;

    const [subjectCount, resourceCount, pairRow] = await Promise.all([
      runCount(p, 'matrix-scope-subject', res,
        `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.where}`,
        built.bindings),
      runCount(p, 'matrix-scope-resource', res,
        `SELECT COUNT(*)::int AS c FROM "Resources"${built.resourceSql ? ` WHERE id IN ${built.resourceSql}` : ''}`,
        built.bindings),
      pairReq.query(pairSql).then(r => r.recordset[0] || { total: 0, governed: 0 }),
    ]);

    const assignmentCount = pairRow.total || 0;
    const governedAssignmentCount = pairRow.governed || 0;
    const ungovernedAssignmentCount = assignmentCount - governedAssignmentCount;
    const governedPct = assignmentCount > 0
      ? Math.round((governedAssignmentCount / assignmentCount) * 1000) / 10
      : 0;

    return res.json({
      rowType: filter.rowType,
      subjectCount,
      resourceCount,
      assignmentCount,
      governedAssignmentCount,
      ungovernedAssignmentCount,
      governedPct,
      warnings: built.warnings,
    });
  } catch (err) {
    console.error('matrix/scope-stats failed:', err.message);
    return res.status(500).json({ error: 'Scope statistics failed' });
  }
});

// ─── POST /api/matrix/scope-timeseries ──────────────────────────────
// Historic timeline for the current selection, reconstructed from the audit
// log (_history) — no dedicated snapshot tables. Body: { filter }. Query:
// days (range, default 180), points (samples, default 13). Returns one point
// per sample date with principals / resources / assignments / governed counts
// and the governed %, plus `historyStart` (earliest reliable instant) and
// `scopeMode` ('attribute' = fully reconstructed; 'context-current' = scope
// membership taken from today because ContextMembers is not audited).
router.post('/matrix/scope-timeseries', async (req, res) => {
  if (!useSql) return res.json({ historyStart: null, scopeMode: 'attribute', points: [] });

  const filter = parseFilter(req.body);
  if (!filter) return res.status(400).json({ error: 'Invalid filter body' });

  try {
    const [principalCols, resourceCols, contextTypes] = await Promise.all([
      getPrincipalColumns(),
      getResourceColumns(),
      resolveContextTypes(filter),
    ]);
    const principalColSet = new Set(principalCols.map(c => c.name));
    const resourceColSet  = new Set(resourceCols.map(c => c.name));

    const { sql, bindings, warnings, scopeMode } = buildScopeAsofSql({
      filter, principalColSet, resourceColSet, contextTypes,
    });

    const p = await db.getPool();

    // The audit log is pruned beyond HISTORY_RETENTION_DAYS (default 180), so
    // the timeline can't reach further back than that. Clamp the requested
    // range and tell the client the bound so the UI can explain it.
    const retRow = await db.queryOne(
      `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = 'HISTORY_RETENTION_DAYS'`,
    );
    const retentionDays = retRow ? parseInt(retRow.configValue, 10) : 180;
    const reqDays = parseInt(req.query.days, 10) || 180;
    const days = (retentionDays > 0) ? Math.min(reqDays, retentionDays) : reqDays;

    // Earliest reliable instant — don't fabricate points before auditing began.
    const startRow = await db.queryOne(historyStartSql());
    const historyStart = startRow?.start ? new Date(startRow.start) : null;

    const dates = generateSampleDates({ days, points: req.query.points });

    const points = await Promise.all(dates.map(async (date) => {
      const asof = `${date}T23:59:59.999Z`;
      // Skip points before auditing began (reconstruction unreliable there).
      if (historyStart && new Date(asof) < historyStart) {
        return { date, principals: 0, resources: 0, assignments: 0, governed: 0, governedPct: 0, beforeHistory: true };
      }
      const r = timedRequest(p, 'matrix-scope-timeseries', res);
      for (const [k, v] of Object.entries(bindings)) r.input(k, v);
      r.input('asof', asof);
      const row = (await r.query(sql)).recordset[0] || {};
      const assignments = row.assignments || 0;
      const governed = row.governed || 0;
      return {
        date,
        principals: row.principals || 0,
        resources: row.resources || 0,
        assignments,
        governed,
        ungoverned: assignments - governed,
        governedPct: assignments > 0 ? Math.round((governed / assignments) * 1000) / 10 : 0,
      };
    }));

    return res.json({
      historyStart: historyStart ? historyStart.toISOString() : null,
      retentionDays,
      scopeMode,
      points,
      warnings,
    });
  } catch (err) {
    console.error('matrix/scope-timeseries failed:', err.message);
    return res.status(500).json({ error: 'Scope timeseries failed' });
  }
});

// ─── POST /api/matrix/scope-breakdown ───────────────────────────────
// Department-by-department (or any principal attribute) breakdown of the
// current selection: principals, assignments, and governed split per group.
// Body: { filter }. Query: attribute (default 'department', or an ext.* key).
// The UI drills into a group by re-querying scope-timeseries with that
// attribute added to the subject filter.
router.post('/matrix/scope-breakdown', async (req, res) => {
  if (!useSql) return res.json({ attribute: 'department', groups: [] });

  const filter = parseFilter(req.body);
  if (!filter) return res.status(400).json({ error: 'Invalid filter body' });

  // Resolve + validate the grouping attribute (real principal column or ext.*).
  const rawAttr = typeof req.query.attribute === 'string' && req.query.attribute
    ? req.query.attribute : 'department';
  const resolved = resolveAttrExpr(rawAttr, 'u', await getPrincipalColumns());
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const attrExpr = resolved.attrExpr;

  try {
    const built = await buildSubqueries(filter);
    const p = await db.getPool();
    const grp = `COALESCE(NULLIF(${attrExpr}::text, ''), '(none)')`;
    const notGroup = `(u."principalType" IS NULL OR u."principalType" <> '#microsoft.graph.group')`;
    const subjIn = built.subjectSql ? ` AND u.id IN ${built.subjectSql}` : '';
    const resIn  = built.resourceSql ? ` AND p."resourceId" IN ${built.resourceSql}` : '';

    // Principals per group (includes principals with no assignments).
    const principalsReq = timedRequest(p, 'matrix-breakdown-principals', res);
    for (const [k, v] of Object.entries(built.bindings)) principalsReq.input(k, v);
    const principalsRows = (await principalsReq.query(`
      SELECT ${grp} AS grp, COUNT(*)::int AS principals
        FROM "Principals" u
       WHERE ${notGroup}${subjIn}
       GROUP BY ${grp}
    `)).recordset;

    // Assignment pairs + governed split per group.
    const pairsReq = timedRequest(p, 'matrix-breakdown-pairs', res);
    for (const [k, v] of Object.entries(built.bindings)) pairsReq.input(k, v);
    const pairsRows = (await pairsReq.query(`
      SELECT grp,
             COUNT(*)::int AS assignments,
             COUNT(*) FILTER (WHERE managed)::int AS governed
        FROM (
          SELECT ${grp} AS grp, u.id AS pid, p."resourceId" AS rid,
                 bool_or(br."userId" IS NOT NULL) AS managed
            FROM "Principals" u
            JOIN "vw_ResourceUserPermissionAssignments" p ON p."principalId" = u.id
            LEFT JOIN "vw_UserPermissionAssignmentViaBusinessRole" br
              ON br."userId" = u.id AND br."resourceId" = p."resourceId"
           WHERE ${notGroup}${subjIn}${resIn}
           GROUP BY ${grp}, u.id, p."resourceId"
        ) t
       GROUP BY grp
    `)).recordset;

    // Merge the two result sets by group key.
    const byGroup = new Map();
    for (const r of principalsRows) {
      byGroup.set(r.grp, { group: r.grp, principals: r.principals, assignments: 0, governed: 0 });
    }
    for (const r of pairsRows) {
      const g = byGroup.get(r.grp) || { group: r.grp, principals: 0, assignments: 0, governed: 0 };
      g.assignments = r.assignments;
      g.governed = r.governed;
      byGroup.set(r.grp, g);
    }

    const groups = [...byGroup.values()].map(g => ({
      ...g,
      ungoverned: g.assignments - g.governed,
      governedPct: g.assignments > 0 ? Math.round((g.governed / g.assignments) * 1000) / 10 : 0,
    })).sort((a, b) => b.assignments - a.assignments);

    return res.json({ attribute: rawAttr, groups, warnings: built.warnings });
  } catch (err) {
    console.error('matrix/scope-breakdown failed:', err.message);
    return res.status(500).json({ error: 'Scope breakdown failed' });
  }
});

// ─── POST /api/matrix/data ──────────────────────────────────────────
router.post('/matrix/data', async (req, res) => {
  if (!useSql) {
    return res.json({
      data: [], rowType: 'principal', managedByPackages: [],
      subjectCount: 0, subjectTotal: 0, resourceCount: 0, resourceTotal: 0, assignmentCount: 0,
    });
  }
  const filter = parseFilter(req.body);
  if (!filter) return res.status(400).json({ error: 'Invalid filter body' });

  try {
    const built = await buildSubqueries(filter);
    const rowType = filter.rowType;
    const p = await db.getPool();

    // Dynamic subject-column SELECT — pulls every real column of the chosen
    // subject table so the frontend can render attribute columns and
    // tag-filter against them client-side.
    const subjectCols = rowType === 'identity' ? built.identityCols : built.principalCols;
    const subjectAlias = rowType === 'identity' ? 'i' : 'u';
    const dynamicSubjectCols = subjectCols
      .filter(c => !['displayName', 'email'].includes(c.name))
      .map(c => `${subjectAlias}."${c.name}"`)
      .join(',\n        ');

    const subjectJoin = rowType === 'identity'
      ? `INNER JOIN "Principals" u ON p."principalId" = u.id
         INNER JOIN "IdentityMembers" im ON im."principalId" = u.id
         INNER JOIN "Identities" i ON i.id = im."identityId"`
      : `INNER JOIN "Principals" u ON p."principalId" = u.id`;

    const memberIdExpr   = rowType === 'identity' ? 'i.id'             : 'p."principalId"';
    const memberNameExpr = rowType === 'identity' ? 'i."displayName"'  : 'u."displayName"';
    const memberUpnExpr  = rowType === 'identity' ? 'i."email"'        : 'u."email"';
    const memberTypeExpr = rowType === 'identity' ? `'Identity'`       : 'p."principalType"';

    const subjectIdForFilter = rowType === 'identity' ? 'i.id' : 'p."principalId"';

    // ─── Roll-up aggregation branch ───
    // Columns become distinct values of `filter.rollup`; each cell is the count
    // of distinct subjects with a Direct assignment. Compact payload, so the
    // wizard's 25k "too large" guard doesn't apply.
    if (filter.rollup) {
      const subjCols = rowType === 'identity' ? built.identityCols : built.principalCols;
      const resolved = resolveAttrExpr(filter.rollup, subjectAlias, subjCols);
      if (resolved.error) return res.status(400).json({ error: resolved.error });

      const rollupReq = timedRequest(p, `matrix-rollup[${rowType}]`, res);
      for (const [k, v] of Object.entries(built.bindings)) rollupReq.input(k, v);
      const rollupResult = await rollupReq.query(buildRollupSql({
        attrExpr: resolved.attrExpr,
        subjectJoin,
        subjectIdExpr: memberIdExpr,
        subjectIdForFilter,
        subjectSql: built.subjectSql,
        resourceSql: built.resourceSql,
      }));

      const counts = await scopeCounts(p, res, rowType, built);
      const resMap = new Map();
      const groupSet = new Set();
      for (const row of rollupResult.recordset) {
        if (!resMap.has(row.resourceId)) {
          resMap.set(row.resourceId, {
            resourceId: row.resourceId,
            resourceDisplayName: row.resourceDisplayName,
            resourceType: row.resourceType,
            resourceDescription: row.resourceDescription,
            systemId: row.systemId,
            systemName: row.systemName,
          });
        }
        groupSet.add(row.groupValue);
      }

      // Business-role (SOLL) counts: how many in-scope subjects hold each
      // resource via each business role. Mirrors the SOLL columns of the
      // per-subject matrix, but aggregated to a count.
      let businessRoles = [];
      const roleCounts = [];
      try {
        const brMemberId = rowType === 'identity' ? 'im2."identityId"' : 'br."userId"';
        const brJoin = rowType === 'identity'
          ? 'INNER JOIN "IdentityMembers" im2 ON im2."principalId" = br."userId"' : '';
        const brReq = timedRequest(p, 'matrix-rollup-roles', res);
        for (const [k, v] of Object.entries(built.bindings)) brReq.input(k, v);
        const brRows = (await brReq.query(buildRollupRolesSql({
          brMemberId, brJoin, subjectSql: built.subjectSql, resourceSql: built.resourceSql,
        }))).recordset;
        const roleMap = new Map();
        for (const r of brRows) {
          if (!r.roleId) continue;
          if (!roleMap.has(r.roleId)) roleMap.set(r.roleId, { id: r.roleId, displayName: r.roleName || r.roleId });
          roleCounts.push({ resourceId: r.resourceId, roleId: r.roleId, count: r.count });
        }
        businessRoles = [...roleMap.values()].sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
      } catch { /* business-role view may be absent */ }

      return res.json({
        rollup: filter.rollup,
        rowType,
        resources: [...resMap.values()],
        groupValues: [...groupSet].sort((a, b) => String(a).localeCompare(String(b))),
        counts: rollupResult.recordset.map(r => ({
          resourceId: r.resourceId, groupValue: r.groupValue, directCount: r.directCount,
        })),
        businessRoles,
        roleCounts,
        ...counts,
        totalUsers: counts.subjectTotal,
        warnings: built.warnings,
      });
    }

    const where = [`(p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')`];
    if (built.subjectSql)  where.push(`${subjectIdForFilter} IN ${built.subjectSql}`);
    if (built.resourceSql) where.push(`p."resourceId" IN ${built.resourceSql}`);

    // DISTINCT collapses the cross product when one identity has many
    // principals → many duplicate matrix rows. No-op for rowType=principal.
    const distinct = rowType === 'identity' ? 'DISTINCT' : '';

    const dataReq = timedRequest(p, `matrix-data[${rowType}]`, res);
    for (const [k, v] of Object.entries(built.bindings)) dataReq.input(k, v);

    const dataSql = `
      SELECT ${distinct}
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
        ${memberIdExpr}   AS "memberId",
        ${memberNameExpr} AS "memberDisplayName",
        ${memberUpnExpr}  AS "memberUPN",
        ${memberTypeExpr} AS "memberType",
        p."membershipType",
        ${dynamicSubjectCols ? dynamicSubjectCols + ',' : ''}
        ${subjectAlias}."extendedAttributes" AS "extendedAttributes",
        p."managedByAccessPackage"
      FROM "vw_ResourceUserPermissionAssignments" p
      ${subjectJoin}
      LEFT JOIN "Resources" r ON p."resourceId" = r.id
      LEFT JOIN "Systems" sys ON r."systemId" = sys.id
      WHERE ${where.join(' AND ')}
    `;
    const result = await dataReq.query(dataSql);

    const { subjectCount, subjectTotal, resourceCount, resourceTotal } = await scopeCounts(p, res, rowType, built);

    // AP mapping — keyed by memberId (principal or identity depending on
    // rowType) so the existing frontend renders SOLL columns correctly.
    let managedByPackages = [];
    try {
      const apReq = timedRequest(p, 'matrix-data-ap-mapping', res);
      for (const [k, v] of Object.entries(built.bindings)) apReq.input(k, v);

      const apMemberIdExpr = rowType === 'identity'
        ? 'im2."identityId"'
        : 'ap."userId"';
      const apJoin = rowType === 'identity'
        ? `INNER JOIN "IdentityMembers" im2 ON im2."principalId" = ap."userId"`
        : '';
      const apWhere = [];
      if (built.subjectSql)  apWhere.push(`${apMemberIdExpr} IN ${built.subjectSql}`);
      if (built.resourceSql) apWhere.push(`ap."resourceId" IN ${built.resourceSql}`);

      const apResult = await apReq.query(`
        SELECT ${apMemberIdExpr} AS "memberId",
               ap."resourceId" AS "resourceId",
               ap."resourceId" AS "groupId",
               string_agg(DISTINCT ap."businessRoleId"::text, ',') AS "accessPackageIds"
          FROM "vw_UserPermissionAssignmentViaBusinessRole" ap
          ${apJoin}
          ${apWhere.length ? 'WHERE ' + apWhere.join(' AND ') : ''}
          GROUP BY ${apMemberIdExpr}, ap."resourceId"
      `);
      managedByPackages = apResult.recordset
        .filter(r => r.memberId)
        .map(r => ({
          memberId: r.memberId,
          resourceId: r.resourceId || r.groupId,
          groupId: r.groupId || r.resourceId,
          accessPackageIds: r.accessPackageIds ? r.accessPackageIds.split(',') : [],
        }));
    } catch { /* AP view may not exist */ }

    return res.json({
      data: result.recordset,
      rowType,
      subjectCount,
      subjectTotal,
      resourceCount,
      resourceTotal,
      // Backward-compat alias used by the existing matrix toolbar footer.
      totalUsers: subjectTotal,
      managedByPackages,
      warnings: built.warnings,
    });
  } catch (err) {
    console.error('matrix/data failed:', err.message, '\nStack:', err.stack);
    return res.status(500).json({ error: 'Matrix query failed' });
  }
});

// ─── GET /api/matrix/columns ────────────────────────────────────────
router.get('/matrix/columns', async (req, res) => {
  const entity = req.query.entity;
  if (!['Principal', 'Identity', 'Resource'].includes(entity)) {
    return res.status(400).json({ error: 'entity must be Principal, Identity, or Resource' });
  }
  const schemaOnly = req.query.schema === 'true';
  if (!useSql) return res.json([]);

  try {
    let cols, vals;
    if (entity === 'Principal') {
      cols = await getPrincipalColumns();
      vals = schemaOnly ? null : await getPrincipalColumnValues();
    } else if (entity === 'Identity') {
      cols = await getIdentityColumns();
      vals = schemaOnly ? null : await getIdentityColumnValues();
    } else {
      cols = await getResourceColumns();
      vals = schemaOnly ? null : await getResourceColumnValues();
    }

    if (schemaOnly) {
      return res.json(cols.map(c => ({
        column: c.name,
        type:   c.type,
        values: [],
      })));
    }
    // Preserve column order from the schema, fold in values when present.
    return res.json(
      cols.map(c => ({
        column: c.name,
        type:   c.type,
        values: vals[c.name] || [],
      })).concat(
        // ext.* keys appear in vals but not in cols.
        Object.entries(vals)
          .filter(([k]) => k.startsWith('ext.'))
          .map(([k, values]) => ({ column: k, type: 'text', values }))
      )
    );
  } catch (err) {
    console.error('matrix/columns failed:', err.message);
    return res.json([]);
  }
});

// ─── Saved filters CRUD (org-wide) ──────────────────────────────────

async function ensureSavedFiltersTable() {
  // Migrations create this, but be defensive so a stale dev volume doesn't
  // 500 every request.
  await db.query(`
    CREATE TABLE IF NOT EXISTS "SavedMatrixFilters" (
      "id"          UUID PRIMARY KEY,
      "name"        TEXT NOT NULL,
      "description" TEXT,
      "filter"      JSONB NOT NULL,
      "isDefault"   BOOLEAN NOT NULL DEFAULT false,
      "createdBy"   TEXT,
      "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
      "updatedBy"   TEXT,
      "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "ix_SavedMatrixFilters_name"
      ON "SavedMatrixFilters" (LOWER("name"))
  `);
  await db.query(`ALTER TABLE "SavedMatrixFilters" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "ix_SavedMatrixFilters_isDefault"
      ON "SavedMatrixFilters" ("isDefault") WHERE "isDefault" = true
  `);
}

function getActor(req) {
  return (req.user && (req.user.email || req.user.upn || req.user.name)) || 'unknown';
}

router.get('/matrix/saved-filters', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    await ensureSavedFiltersTable();
    const r = await db.query(`
      SELECT id, "name", "description", "filter", "isDefault", "createdBy", "createdAt", "updatedBy", "updatedAt"
        FROM "SavedMatrixFilters"
       ORDER BY LOWER("name")
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('GET matrix/saved-filters failed:', err.message);
    res.status(500).json({ error: 'Failed to list saved filters' });
  }
});

router.post('/matrix/saved-filters', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  const description = typeof body.description === 'string' ? body.description.slice(0, 1000) : null;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!body.filter || typeof body.filter !== 'object') return res.status(400).json({ error: 'filter is required' });

  try {
    await ensureSavedFiltersTable();
    const id = randomUUID();
    const actor = getActor(req);
    await db.query(
      `INSERT INTO "SavedMatrixFilters" (id, "name", "description", "filter", "createdBy", "updatedBy")
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, name, description, body.filter, actor],
    );
    const row = await db.queryOne(`SELECT * FROM "SavedMatrixFilters" WHERE id = $1`, [id]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `A filter named "${name}" already exists` });
    }
    console.error('POST matrix/saved-filters failed:', err.message);
    res.status(500).json({ error: 'Failed to save filter' });
  }
});

router.put('/matrix/saved-filters/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const body = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`"${col}" = $${params.length}`); };

  if (typeof body.name === 'string') push('name', body.name.trim().slice(0, 200));
  if (typeof body.description === 'string' || body.description === null) {
    push('description', body.description ? body.description.slice(0, 1000) : null);
  }
  if (body.filter && typeof body.filter === 'object') push('filter', body.filter);
  if (typeof body.isDefault === 'boolean') push('isDefault', body.isDefault);
  if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields' });

  push('updatedBy', getActor(req));
  push('updatedAt', new Date());
  params.push(req.params.id);
  try {
    await ensureSavedFiltersTable();
    const r = await db.query(
      `UPDATE "SavedMatrixFilters" SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Filter not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A filter with that name already exists' });
    }
    console.error('PUT matrix/saved-filters/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to update filter' });
  }
});

router.delete('/matrix/saved-filters/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await ensureSavedFiltersTable();
    const r = await db.query(`DELETE FROM "SavedMatrixFilters" WHERE id = $1`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Filter not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE matrix/saved-filters/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete filter' });
  }
});

// ─── Default filter (auto-apply on first Matrix visit) ──────────────

router.get('/matrix/default-filter', async (req, res) => {
  if (!useSql) return res.json(null);
  try {
    await ensureSavedFiltersTable();
    const row = await db.queryOne(
      `SELECT id, "name", "description", "filter", "isDefault", "createdBy", "createdAt", "updatedBy", "updatedAt"
         FROM "SavedMatrixFilters" WHERE "isDefault" = true LIMIT 1`
    );
    res.json(row || null);
  } catch (err) {
    console.error('GET matrix/default-filter failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch default filter' });
  }
});

export default router;
