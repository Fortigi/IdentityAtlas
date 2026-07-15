// Matrix scope-analysis endpoints: scope-stats, scope-timeseries, scope-breakdown.
//
// Extracted verbatim from routes/matrix.js as part of splitting that god-module
// (audit finding Q1). Mounted by routes/matrix.js via router.use(), so the public
// paths are unchanged. No behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { createParams } from '../../db/sqlParams.js';
import { buildAssignmentExprs } from '../../db/matrixHelpers.js';
import { getPrincipalColumns, getResourceColumns } from '../../db/columnCache.js';
import { generateSampleDates, buildScopeAsofSql, historyStartSql } from '../../matrix/scopeHistory.js';
import { resolveAttrExpr } from '../../matrix/attrExpr.js';
import { parseFilter, buildSubqueries, subjectScopeClauses, runCount, resolveContextTypes } from './shared.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// ─── POST /api/matrix/scope-stats ───────────────────────────────────
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

    // The pair query renders both fragments through one binder; each count query
    // renders just the fragment it uses, with its own params array.
    const pp = createParams();
    const { subjectIdExpr, assignmentJoin, assignmentWhere } =
      buildAssignmentExprs(filter.rowType, built.subject(pp.bind).sql, built.resource(pp.bind).sql);
    const scp = createParams();
    const subj = subjectScopeClauses(filter.rowType, built.subject(scp.bind).sql);
    const rcp = createParams();
    const rcResourceSql = built.resource(rcp.bind).sql;

    // One pair-level aggregation: distinct (subject, resource) pairs, each
    // flagged governed if ANY of its assignment rows is access-package managed.
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
        scp.params),
      runCount(p, 'matrix-scope-resource', res,
        `SELECT COUNT(*)::int AS c FROM "Resources"${rcResourceSql ? ` WHERE id IN ${rcResourceSql}` : ''}`,
        rcp.params),
      timedQuery(p, 'matrix-scope-pairs', res, pairSql, pp.params).then(r => r.rows[0] || { total: 0, governed: 0 }),
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

    const { params, bind } = createParams();
    const asof0 = buildScopeAsofSql({ filter, principalColSet, resourceColSet, contextTypes, bind });
    // The as-of instant is the next param after the (fixed) filter values; it
    // varies per sample date, so leave a marker and bind it per date below.
    const asofSql = asof0.sql.replaceAll(':ASOF:', `$${params.length + 1}`);
    const { warnings, scopeMode } = asof0;

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
      const row = (await timedQuery(p, 'matrix-scope-timeseries', res, asofSql, [...params, asof])).rows[0] || {};
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

    // Principals per group (includes principals with no assignments) — only the
    // subject fragment, rendered with its own params.
    const prp = createParams();
    const prSubjIn = (() => { const s = built.subject(prp.bind).sql; return s ? ` AND u.id IN ${s}` : ''; })();
    const principalsRows = (await timedQuery(p, 'matrix-breakdown-principals', res, `
      SELECT ${grp} AS grp, COUNT(*)::int AS principals
        FROM "Principals" u
       WHERE ${notGroup}${prSubjIn}
       GROUP BY ${grp}
    `, prp.params)).rows;

    // Assignment pairs + governed split per group — subject + resource fragments.
    const pap = createParams();
    const paSubjectSql = built.subject(pap.bind).sql;
    const paResourceSql = built.resource(pap.bind).sql;
    const paSubjIn = paSubjectSql ? ` AND u.id IN ${paSubjectSql}` : '';
    const paResIn  = paResourceSql ? ` AND p."resourceId" IN ${paResourceSql}` : '';
    const pairsRows = (await timedQuery(p, 'matrix-breakdown-pairs', res, `
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
           WHERE ${notGroup}${paSubjIn}${paResIn}
           GROUP BY ${grp}, u.id, p."resourceId"
        ) t
       GROUP BY grp
    `, pap.params)).rows;

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

export default router;
