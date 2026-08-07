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
import {
  getPrincipalColumns, getResourceColumns,
  getPrincipalColumnValuesMeta, getResourceColumnValuesMeta,
  searchColumnValues, VALUE_SEARCH_LIMIT,
} from '../db/columnCache.js';
import { explainInheritance } from '../matrix/inheritedAccess.js';
import savedFiltersRouter from './matrix/savedFilters.js';
import scopeRouter from './matrix/scope.js';
import dataRouter from './matrix/data.js';
import { getIdentityColumns, getIdentityColumnValuesMeta, parseFilter, buildSubqueries, runCount, subjectScopeClauses } from './matrix/shared.js';
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

// ─── Column discovery ───────────────────────────────────────────────
// The three filterable entities and the table each one's values live in.
const ENTITY_TABLES = { Principal: 'Principals', Identity: 'Identities', Resource: 'Resources' };

function entityColumns(entity) {
  if (entity === 'Principal') return getPrincipalColumns();
  if (entity === 'Identity')  return getIdentityColumns();
  return getResourceColumns();
}

// { values: { col: [...] }, truncated: { col: true } }
function entityColumnValues(entity) {
  if (entity === 'Principal') return getPrincipalColumnValuesMeta();
  if (entity === 'Identity')  return getIdentityColumnValuesMeta();
  return getResourceColumnValuesMeta();
}

// ─── GET /api/matrix/columns ────────────────────────────────────────
router.get('/matrix/columns', async (req, res) => {
  const entity = req.query.entity;
  if (!['Principal', 'Identity', 'Resource'].includes(entity)) {
    return res.status(400).json({ error: 'entity must be Principal, Identity, or Resource' });
  }
  const schemaOnly = req.query.schema === 'true';
  if (!useSql) return res.json([]);

  try {
    const cols = await entityColumns(entity);
    if (schemaOnly) {
      return res.json(cols.map(c => ({
        column: c.name,
        type:   c.type,
        values: [],
      })));
    }
    // `truncated` marks a column whose distinct values did not fit in one page.
    // The list served is the alphabetically first page — never an arbitrary
    // subset — and the rest is reachable via /matrix/column-values (#928).
    const { values, truncated } = await entityColumnValues(entity);
    // Preserve column order from the schema, fold in values when present.
    return res.json(
      cols.map(c => ({
        column:    c.name,
        type:      c.type,
        values:    values[c.name] || [],
        truncated: !!truncated[c.name],
      })).concat(
        // ext.* keys appear in values but not in cols.
        Object.entries(values)
          .filter(([k]) => k.startsWith('ext.'))
          .map(([k, vals]) => ({ column: k, type: 'text', values: vals, truncated: !!truncated[k] }))
      )
    );
  } catch (err) {
    console.error('matrix/columns failed:', err.message);
    return res.json([]);
  }
});

// ─── GET /api/matrix/column-values ──────────────────────────────────
// Substring search across ALL distinct values of one column — the escape hatch
// for columns whose preloaded value list is truncated, so every stored value
// stays reachable from the wizard's "+ Attribute" picker (#928). An empty `q`
// returns the same preloaded page /matrix/columns serves.
router.get('/matrix/column-values', async (req, res) => {
  const entity = req.query.entity;
  if (!['Principal', 'Identity', 'Resource'].includes(entity)) {
    return res.status(400).json({ error: 'entity must be Principal, Identity, or Resource' });
  }
  const column = typeof req.query.column === 'string' ? req.query.column : '';
  if (!column) return res.status(400).json({ error: 'column is required' });
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  if (!useSql) return res.json({ column, values: [], truncated: false });

  try {
    const { values, truncated } = await entityColumnValues(entity);
    // Allowlist: only columns/ext keys we actually discovered are accepted —
    // the name is interpolated into the SQL, the search term never is.
    const allowed = new Set(Object.keys(values));
    if (!allowed.has(column)) {
      const cols = await entityColumns(entity);
      if (cols.some(c => c.name === column)) {
        // Real column with no values at all — nothing to search.
        return res.json({ column, values: [], truncated: false });
      }
      return res.status(400).json({ error: 'Unknown column' });
    }
    if (!q) {
      return res.json({ column, values: values[column] || [], truncated: !!truncated[column] });
    }
    const found = await searchColumnValues(ENTITY_TABLES[entity], column, q, allowed);
    return res.json({ column, values: found, truncated: found.length >= VALUE_SEARCH_LIMIT });
  } catch (err) {
    console.error('matrix/column-values failed:', err.message);
    return res.status(500).json({ error: 'Failed to search column values' });
  }
});

// ─── Saved filters CRUD (org-wide) ──────────────────────────────────

export default router;
