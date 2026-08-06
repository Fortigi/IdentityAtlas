// Shared helpers + constants for the matrix endpoints.
//
// Extracted verbatim from routes/matrix.js as part of splitting that god-module
// (audit finding Q1). Imported by routes/matrix.js and routes/matrix/scope.js so
// both share one definition. No behaviour change — pure code move.

import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { createParams } from '../../db/sqlParams.js';
import {
  getPrincipalColumns, getResourceColumns,
  discoverColumnValues, discoverExtendedAttrValues, mergeValueSets,
} from '../../db/columnCache.js';
import { buildEntitySubquery, collectContextIds } from '../../matrix/filterSql.js';
import { resourceMeta } from '../../db/matrixHelpers.js';
import { GROUP_PRINCIPAL_TYPE } from '../../lib/principalTypes.js';

export const ROW_TYPES = new Set(['principal', 'identity']);
export const SAFE_IDENT_RE = /^[a-zA-Z0-9_]+$/;
export const FILTERABLE_TYPES = new Set([
  'text', 'character varying', 'character', 'boolean',
  'integer', 'bigint', 'smallint',
]);

// ─── Identity column discovery ──────────────────────────────────────

let identityColumnsCache = null;
let identityColumnsCacheTime = 0;
let identityValuesCache = null;
let identityValuesCacheTime = 0;
const IDENTITY_CACHE_TTL = 5 * 60 * 1000;

export async function getIdentityColumns() {
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

// Identity distinct values, discovered with the same helpers the Principal and
// Resource sides use (db/columnCache.js) — one ordered page per column/ext key
// plus a per-column `truncated` flag. The hand-rolled duplicate this replaced
// also carried a global 5000-row cap across all ext keys, which silently
// dropped whole keys once a tenant had enough extension attributes (#928).
export async function getIdentityColumnValuesMeta() {
  const now = Date.now();
  if (identityValuesCache && (now - identityValuesCacheTime) < IDENTITY_CACHE_TTL) {
    return identityValuesCache;
  }
  const cols = await getIdentityColumns();
  const base = await discoverColumnValues('Identities', cols);

  // Extension-attribute keys + distinct values, surfaced as ext.<key> so they
  // can be picked and filtered just like Principal/Resource ext attributes.
  let ext = { values: {}, truncated: {} };
  try {
    ext = await discoverExtendedAttrValues('Identities');
  } catch { /* extendedAttributes column may be absent on older schemas */ }

  identityValuesCache = mergeValueSets(base, ext);
  identityValuesCacheTime = now;
  return identityValuesCache;
}

// ─── Filter parsing ─────────────────────────────────────────────────

export function parseFilter(body) {
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
    // What the roll-up returns: resources + role columns (default), resources
    // only, or business roles as rows.
    rollupContent: ['resources-and-roles', 'resources-only', 'roles-only'].includes(f.rollupContent)
      ? f.rollupContent : 'resources-and-roles',
    // How each roll-up cell is displayed: an absolute count (default) or the
    // percentage of in-scope subjects in that group who hold it. Presentational
    // only — the backend always returns groupTotals so the frontend can switch.
    rollupMetric: f.rollupMetric === 'percent' ? 'percent' : 'count',
    // Internal: a roles-only drill request returns the per-subject breakdown
    // for the group already scoped via a subject attribute condition.
    drill: f.drill === true,
    // EXPERIMENTAL — aggregate the subject axis by a Context tree (e.g. the
    // Manager Hierarchy) instead of an attribute. rollupKind 'context' switches
    // the roll-up branch; rollupContextId is the starting (root) node. The view
    // zooms one level at a time: rollupPath is the drill path from the root to
    // the current focus node, and the columns are the focus node's children.
    rollupKind: f.rollupKind === 'context' ? 'context' : 'attribute',
    rollupContextId: typeof f.rollupContextId === 'string' && f.rollupContextId ? f.rollupContextId : null,
    rollupPath: Array.isArray(f.rollupPath) ? f.rollupPath.filter(x => typeof x === 'string').slice(0, 50) : [],
    // Layered hierarchy view: the set of org nodes the user has expanded in
    // place. The visible columns are the resulting tree cut; expanding a node
    // adds the next level as a new header row (see buildContextCutSql). Reused by
    // the layered attribute fold, where the entries are attribute-tuple keys.
    rollupExpanded: Array.isArray(f.rollupExpanded) ? f.rollupExpanded.filter(x => typeof x === 'string').slice(0, 200) : [],
    // Serve the attribute fold as a server-aggregated layered view (counts +
    // expand-in-place) rather than a flat per-subject grid — set by the wizard
    // for matrices too large to ship every row. Uses sortAttributes as the tree.
    foldAttributes: f.foldAttributes === true,
    // Layered attribute fold: the set of attribute-tuple keys the user has
    // FOLDED (collapse model — default none = full depth, all attribute rows
    // shown). Inverse of rollupExpanded, which the hierarchy view uses.
    rollupCollapsed: Array.isArray(f.rollupCollapsed) ? f.rollupCollapsed.filter(x => typeof x === 'string').slice(0, 500) : [],
    // Subject-axis sort order — client-side only, but normalised here so the
    // shape is consistent across endpoints. Max 3 attributes.
    sortAttributes: normaliseSortAttributes(f.sortAttributes),
    // Sort the subject axis by a Context tree (Manager Hierarchy). Served as a
    // context roll-up (aggregated per org node) so we never ship every
    // per-subject row — see the translation in the /matrix/data handler.
    sortHierarchy: f.sortHierarchy && typeof f.sortHierarchy === 'object'
      && typeof f.sortHierarchy.contextId === 'string' && f.sortHierarchy.contextId
      ? { contextId: f.sortHierarchy.contextId } : null,
  };
}

export function normaliseSortAttributes(arr) {
  const DEFAULT = [{ attribute: 'department', dir: 'asc' }];
  if (!Array.isArray(arr)) return DEFAULT;
  const out = [];
  for (const a of arr) {
    if (!a || typeof a.attribute !== 'string' || !a.attribute) continue;
    out.push({ attribute: a.attribute, dir: a.dir === 'desc' ? 'desc' : 'asc' });
    if (out.length === 6) break;
  }
  return out.length ? out : DEFAULT;
}

export function normaliseBlock(b) {
  if (!b || typeof b !== 'object') return { include: [], exclude: [] };
  return {
    include: Array.isArray(b.include) ? b.include : [],
    exclude: Array.isArray(b.exclude) ? b.exclude : [],
  };
}

// ─── Subquery + scope helpers ───────────────────────────────────────

export async function resolveContextTypes(filter) {
  const ids = collectContextIds(filter);
  if (ids.length === 0) return new Map();
  const r = await db.query(
    `SELECT id, "targetType" FROM "Contexts" WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(r.rows.map(row => [row.id, row.targetType]));
}

export async function buildSubqueries(filter) {
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

  // Render closures: `subject(bind)` / `resource(bind)` return { sql, warnings }
  // given a positional binder (from createParams). The subquery fragment is
  // embedded in several INDEPENDENT queries (the flat grid, the four scope
  // COUNTs, roll-ups), and pg can't share params across queries — so each
  // consuming query calls the closure with its OWN bind, getting exactly the
  // $N + params that query references.
  const subject = (bind) => buildEntitySubquery({
    entity: subjectEntity,
    include: filter.subject.include,
    exclude: filter.subject.exclude,
    validColumns: subjectValidCols,
    contextTypes,
    bind,
  });
  const resource = (bind) => buildEntitySubquery({
    entity: 'Resource',
    include: filter.resource.include,
    exclude: filter.resource.exclude,
    validColumns: resourceColSet,
    contextTypes,
    bind,
  });

  // Warnings + fragment-presence flags are bind-independent — compute once with
  // a throwaway binder. hasSubject/hasResource let callers guard on "is there a
  // filter fragment?" without rendering (the fragment sql is null when empty).
  const t = createParams();
  const subjectBuilt = subject(t.bind);
  const resourceBuilt = resource(t.bind);
  const warnings = [...subjectBuilt.warnings, ...resourceBuilt.warnings];

  return {
    subject,
    resource,
    hasSubject: subjectBuilt.sql != null,
    hasResource: resourceBuilt.sql != null,
    warnings,
    principalCols,
    resourceCols,
    identityCols,
  };
}

// Run a single-cell COUNT query with the given positional params; returns the integer.
export async function runCount(p, label, res, sql, params) {
  const result = await timedQuery(p, label, res, sql, params);
  return result.rows[0]?.c ?? 0;
}

// Most matrix sub-queries share one shape: allocate a fresh positional-param
// array (pg can't reuse params across queries), render the subject filter
// subquery — and, unless { resource:false }, the resource one — into the SQL via
// `bind`, time the query, and return the pg result. runBound captures that
// boilerplate; `render({ subjectSql, resourceSql, bind })` returns the finished
// SQL string. Pass { resource:false } for subject-only queries so no resource
// params are bound (which would desync pg's positional-parameter count). Binding
// order is subject, then resource, then whatever the render binds — matching the
// hand-written call sites this replaces.
export async function runBound(p, label, res, built, render, { resource = true } = {}) {
  const { params, bind } = createParams();
  const subjectSql = built.subject(bind).sql;
  const resourceSql = resource ? built.resource(bind).sql : '';
  return timedQuery(p, label, res, render({ subjectSql, resourceSql, bind }), params);
}

// De-dupe resource rows/objects into `map` keyed by resourceId (first occurrence
// wins), mirroring the resource-map build repeated across the roll-up handlers.
// Raw query rows go through resourceMeta by default; pass an identity mapper
// (r => r) to merge already-shaped resource objects (the inherited-access lists).
export function collectResources(map, rows, toMeta = resourceMeta) {
  for (const row of rows || []) {
    if (!row?.resourceId || map.has(row.resourceId)) continue;
    map.set(row.resourceId, toMeta(row));
  }
  return map;
}

export function subjectScopeClauses(rowType, subjectSql) {
  const subjectTable = rowType === 'identity' ? 'Identities' : 'Principals';
  // For principals, exclude group-shaped accounts so counts match what the
  // matrix actually renders.
  const baseWhere = rowType === 'principal'
    ? `("principalType" IS NULL OR "principalType" != '${GROUP_PRINCIPAL_TYPE}')`
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
export async function scopeCounts(p, res, rowType, built) {
  // Each COUNT query renders its fragment fresh with its own params array.
  const sp = createParams();
  const subjectSql = built.subject(sp.bind).sql;
  const subj = subjectScopeClauses(rowType, subjectSql);

  const rp = createParams();
  const resourceSql = built.resource(rp.bind).sql;

  const [subjectCount, subjectTotal, resourceCount, resourceTotal] = await Promise.all([
    runCount(p, 'matrix-data-subject-count', res,
      `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.where}`, sp.params),
    runCount(p, 'matrix-data-subject-total', res,
      `SELECT COUNT(*)::int AS c FROM "${subj.subjectTable}"${subj.baseWhere}`, []),
    runCount(p, 'matrix-data-resource-count', res,
      `SELECT COUNT(*)::int AS c FROM "Resources"${resourceSql ? ` WHERE id IN ${resourceSql}` : ''}`, rp.params),
    runCount(p, 'matrix-data-resource-total', res,
      `SELECT COUNT(*)::int AS c FROM "Resources"`, []),
  ]);
  return { subjectCount, subjectTotal, resourceCount, resourceTotal };
}
