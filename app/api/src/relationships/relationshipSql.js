// Turn a validated list of relationship conditions into a parameterised SQL
// WHERE fragment, and compute per-edge availability. Companion to edgeCatalog.js.
//
// A relationship condition (wire shape, from the `relFilters` query param or the
// assign-by-filter body):
//   { edge: 'resource.owners', op: 'absent' }              // existence
//   { edge: 'resource.owners', op: 'lt', n: 2 }            // count
//
// Parsing + validation live in `relFilterGuard` (an Express middleware) so the
// (already complex) list handlers gain no branching — they just call
// `relFiltersToSql` on the pre-validated `req.relFilters`. A relationship filter
// fails loud (400) rather than warn-and-drop like the matrix filter, because it
// is an explicit typed param and a silently-dropped condition would quietly
// widen a governance query.

import { EDGES, OPS, COUNT_OPS, OP_SYMBOL, edgesForEntity } from './edgeCatalog.js';

const MAX_CONDITIONS = 20;

// Parse the raw `relFilters` value (a JSON string, or already-parsed array) into
// an array. Returns { relFilters, error }.
export function parseRelFilters(raw) {
  if (raw == null || raw === '') return { relFilters: [], error: null };
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return { relFilters: null, error: 'relFilters is not valid JSON' }; }
  }
  if (!Array.isArray(arr)) return { relFilters: null, error: 'relFilters must be an array' };
  if (arr.length > MAX_CONDITIONS) return { relFilters: null, error: `too many relationship conditions (max ${MAX_CONDITIONS})` };
  return { relFilters: arr, error: null };
}

// Validate one condition against the catalog + the entity being filtered.
// Returns an error string, or null if valid.
function validateCondition(cond, entity) {
  if (!cond || typeof cond !== 'object') return 'each relationship condition must be an object';
  const edge = EDGES[cond.edge];
  if (!edge) return `unknown relationship edge: ${cond.edge}`;
  if (edge.fromEntity !== entity) return `edge ${cond.edge} is not valid for ${entity} entities`;
  if (!OPS.includes(cond.op)) return `unknown operator: ${cond.op}`;
  if (COUNT_OPS.includes(cond.op) && (!Number.isInteger(cond.n) || cond.n < 0)) {
    return `operator ${cond.op} requires an integer n >= 0`;
  }
  return null;
}

// Validate every condition. Returns the first error string, or null.
export function validateRelFilters(relFilters, entity) {
  for (const cond of relFilters) {
    const err = validateCondition(cond, entity);
    if (err) return err;
  }
  return null;
}

// Express middleware: parse + validate the relFilters on a list/tag request and
// stash the validated array on req.relFilters, or respond 400. Keeps the heavy
// list handlers branch-free. `entityOf` is the relationship target ('Resource' /
// 'Principal') or a (req)=>target function (assign-by-filter derives it from the
// request body's entityType).
export function relFilterGuard(entityOf) {
  return (req, res, next) => {
    const raw = (req.query && req.query.relFilters) ?? (req.body && req.body.relFilters);
    const { relFilters, error: parseErr } = parseRelFilters(raw);
    if (parseErr) return res.status(400).json({ error: parseErr });
    const entity = typeof entityOf === 'function' ? entityOf(req) : entityOf;
    const validationErr = validateRelFilters(relFilters, entity);
    if (validationErr) return res.status(400).json({ error: validationErr });
    req.relFilters = relFilters;
    next();
  };
}

// Build the AND-ed WHERE fragment (leading ' AND …', like buildFilterWhere) from
// PRE-VALIDATED conditions (relFilterGuard has run). `alias` is the outer table
// alias (r / u / e); `bind` is the shared positional binder.
export function relFiltersToSql(relFilters, { alias, bind }) {
  let sql = '';
  for (const cond of relFilters) {
    const edge = EDGES[cond.edge];
    const body = edge.fromWhere(alias);
    if (cond.op === 'exists') {
      sql += ` AND EXISTS (SELECT 1 ${body})`;
    } else if (cond.op === 'absent') {
      sql += ` AND NOT EXISTS (SELECT 1 ${body})`;
    } else {
      sql += ` AND (SELECT ${edge.countCol} ${body}) ${OP_SYMBOL[cond.op]} ${bind(cond.n)}`;
    }
  }
  return sql;
}

// Compute `available` for every edge of an entity, in one round-trip: each edge's
// non-correlated existence probe becomes one boolean column. Returns the edge
// descriptors with `available` set. `runQuery(sql)` is `pool.query`-like.
export async function computeAvailability(entity, runQuery) {
  const edges = edgesForEntity(entity);
  if (edges.length === 0) return [];
  const cols = edges.map((e, i) => `EXISTS (${EDGES[e.id].availableProbe}) AS "a${i}"`);
  const { rows } = await runQuery(`SELECT ${cols.join(', ')}`);
  const row = rows[0] || {};
  return edges.map((e, i) => ({ ...e, available: !!row[`a${i}`] }));
}
