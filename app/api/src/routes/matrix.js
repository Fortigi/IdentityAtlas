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
import * as db from '../db/connection.js';
import { timedQuery } from '../perf/sqlTimer.js';
import { createParams } from '../db/sqlParams.js';
import { buildAssignmentExprs } from '../db/matrixHelpers.js';
import { UUID_RE } from '../matrix/filterSql.js';
import { getPrincipalColumns, getResourceColumns, getPrincipalColumnValues, getResourceColumnValues } from '../db/columnCache.js';
import { explainInheritance } from '../matrix/inheritedAccess.js';
import savedFiltersRouter from './matrix/savedFilters.js';
import scopeRouter from './matrix/scope.js';
import dataRouter from './matrix/data.js';
import { getIdentityColumns, getIdentityColumnValues, parseFilter, buildSubqueries, runCount, subjectScopeClauses } from './matrix/shared.js';
// normaliseSortAttributes lives in shared.js now; re-export so existing consumers
// (matrix.rollup.test.js) keep importing it from here.
export { normaliseSortAttributes } from './matrix/shared.js';

const router = Router();
// Saved-filter CRUD + the org-wide default filter live in their own module
// (routes/matrix/savedFilters.js) — part of the matrix.js split (Q1).
router.use(savedFiltersRouter);
router.use(scopeRouter);
router.use(dataRouter);
const useSql = process.env.USE_SQL === 'true';

// Shared helpers + constants moved to ./matrix/shared.js (Q1 split); imported below.

// Roll-up SQL builders moved to ../matrix/rollupBuilders.js (Q1 split); they are
// imported above and used by the handlers below. Their unit tests live in
// matrix/rollupBuilders.test.js.

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

    // Each COUNT renders the fragment(s) it uses through its own binder.
    const pp = createParams();
    const { subjectIdExpr, assignmentJoin, assignmentWhere } =
      buildAssignmentExprs(filter.rowType, built.subject(pp.bind).sql, built.resource(pp.bind).sql);
    const scp = createParams();
    const subj = subjectScopeClauses(filter.rowType, built.subject(scp.bind).sql);
    const rcp = createParams();
    const rcResourceSql = built.resource(rcp.bind).sql;

    const [subjectCount, subjectTotal, resourceCount, resourceTotal, assignmentCount] = await Promise.all([
      runCount(p, 'matrix-preview-subject', res,
        `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.where}`,
        scp.params),
      runCount(p, 'matrix-preview-subject-total', res,
        `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.baseWhere}`,
        []),
      runCount(p, 'matrix-preview-resource', res,
        `SELECT COUNT(*)::int AS c FROM "Resources"${rcResourceSql ? ` WHERE id IN ${rcResourceSql}` : ''}`,
        rcp.params),
      runCount(p, 'matrix-preview-resource-total', res,
        `SELECT COUNT(*)::int AS c FROM "Resources"`,
        []),
      runCount(p, 'matrix-preview-assignments', res,
        `SELECT COUNT(*)::int AS c FROM (
           SELECT DISTINCT ${subjectIdExpr} AS sid, p."resourceId" AS rid
             FROM "vw_ResourceUserPermissionAssignments" p
             ${assignmentJoin}
            WHERE ${assignmentWhere.join(' AND ')}
         ) t`,
        pp.params),
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

// ─── POST /api/matrix/hierarchy-paths ───────────────────────────────
// For sorting the matrix by a Manager-Hierarchy context tree: returns each
// subject's ancestor-node path (top org → … → their node) as display-name
// labels. The frontend shortens each label and uses the path as the column
// sort keys, so the existing fold machinery reveals one org level at a time.
router.post('/matrix/hierarchy-paths', async (req, res) => {
  if (!useSql) return res.json({ paths: {}, depth: 0 });
  const body = req.body || {};
  const rootContextId = body.rootContextId;
  const rowType = body.rowType === 'identity' ? 'identity' : 'principal';
  if (!isUuid(rootContextId)) return res.status(400).json({ error: 'rootContextId (uuid) is required' });

  try {
    const p = await db.getPool();
    // Path of displayNames from the first level below the root down to each node
    // (the synthetic root contributes nothing).
    const pathCte = `
      WITH RECURSIVE down AS (
        SELECT id, ARRAY[]::text[] AS path
          FROM "Contexts" WHERE id = '${rootContextId}'::uuid
        UNION ALL
        SELECT c.id, d.path || c."displayName"
          FROM "Contexts" c JOIN down d ON c."parentContextId" = d.id
      )
      -- CYCLE guard: corrupt parent chains must not recurse forever.
      CYCLE id SET "isCycle" USING "cyclePath"`;
    const sql = rowType === 'identity'
      ? `${pathCte}
         SELECT DISTINCT ON (im."identityId") im."identityId"::text AS "subjectId", d.path AS path
           FROM down d
           JOIN "ContextMembers" cm ON cm."contextId" = d.id AND cm."memberType" = 'Principal'
           JOIN "IdentityMembers" im ON im."principalId" = cm."memberId"
          ORDER BY im."identityId", im."isHrAuthoritative" DESC NULLS LAST, im."isPrimary" DESC NULLS LAST`
      : `${pathCte}
         SELECT cm."memberId"::text AS "subjectId", d.path AS path
           FROM down d
           JOIN "ContextMembers" cm ON cm."contextId" = d.id AND cm."memberType" = 'Principal'`;
    const rows = (await timedQuery(p, `matrix-hierarchy-paths[${rowType}]`, res, sql, [])).rows;
    const paths = {};
    let depth = 0;
    for (const r of rows) {
      const path = Array.isArray(r.path) ? r.path : [];
      paths[r.subjectId] = path;
      if (path.length > depth) depth = path.length;
    }
    res.json({ paths, depth });
  } catch (err) {
    console.error('POST /matrix/hierarchy-paths failed:', err.message);
    res.status(500).json({ error: 'Failed to load hierarchy paths' });
  }
});

// ─── POST /api/matrix/data ──────────────────────────────────────────
// Explain one inherited (Indirect) cell — "how did this principal get this access
// at this scope?". Lazy: called on hover / click of an I badge in the flat grid.
router.post('/matrix/inheritance-path', async (req, res) => {
  if (!useSql) return res.json({ sources: [], chain: [] });
  const { nodeId, capabilityId, principalId } = req.body || {};
  if (!UUID_RE.test(nodeId || '') || !UUID_RE.test(principalId || '')
      || typeof capabilityId !== 'string' || !capabilityId) {
    return res.status(400).json({ error: 'nodeId, capabilityId and principalId are required' });
  }
  try {
    return res.json(await explainInheritance(nodeId, capabilityId, principalId));
  } catch (err) {
    console.error('inheritance-path error:', err.message);
    return res.status(500).json({ error: 'Failed to compute inheritance path' });
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

export default router;
