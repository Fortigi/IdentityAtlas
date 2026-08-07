// The canonical matrix-filter shape, plus the normaliser every entry point runs
// an incoming filter through.
//
// A matrix filter reaches the wizard from four places, and only one of them is
// guaranteed to be complete:
//   1. the wizard's own Apply (complete)
//   2. a saved matrix (`SavedMatrixFilters`) — may predate a field, or be
//      seeded with just the fields the seeder cared about (the demo dataset
//      seeds rowType/orientation/subject/resource and nothing else)
//   3. the `#matrix?filter=…` URL — hand-edited or shared from an older build
//   4. the org-wide default matrix, applied without opening the wizard
//
// The wizard's steps read those fields directly (`sortAttributes.length`,
// `subject.include`, …), so a filter missing one crashed the whole page instead
// of rendering the step. Normalising here — once, where a filter enters wizard
// state — means every step can assume the full shape.

export const DEFAULT_SORT = [{ attribute: 'department', dir: 'asc' }];

export const EMPTY_FILTER = {
  rowType: 'principal',
  // 'rows-as-resources' — resources on the row axis, subjects on the column
  //                      axis (current default, good when many resources +
  //                      few subjects, since vertical scroll is easier).
  // 'rows-as-subjects'  — subjects on the row axis, resources on the column
  //                      axis (rotated, good when few resources + many
  //                      subjects).
  orientation: 'rows-as-resources',
  subject:  { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
  // Roll-up: aggregate the subject (column) axis by this attribute. null = off.
  rollup: null,
  // What the roll-up shows (only when rollup is set):
  //   'resources-and-roles' — resources as rows + business-role count columns (default)
  //   'resources-only'      — resources as rows, no business-role columns
  //   'roles-only'          — business roles as rows (resource filter is skipped)
  rollupContent: 'resources-and-roles',
  // How each roll-up cell is shown: 'count' (absolute, default) or 'percent'
  // (share of the in-scope subjects in that group who hold it).
  rollupMetric: 'count',
  // EXPERIMENTAL — aggregate by a Context tree (Manager Hierarchy) instead of an
  // attribute. 'attribute' uses `rollup`; 'context' uses rollupContextId (the
  // starting node) and rollupPath (the drill path from root to current focus).
  rollupKind: 'attribute',
  rollupContextId: null,
  rollupPath: [],
  // Expanded nodes in the Manager-Hierarchy layered view (dynamic drill-down).
  rollupExpanded: [],
  // Folded tuple keys in the layered attribute view (default none = all chosen
  // attributes shown as header rows; fold collapses a group).
  rollupCollapsed: [],
  // Set automatically for an oversized attribute fold: serve it as a layered,
  // server-aggregated view instead of a flat per-subject grid.
  foldAttributes: false,
  // Subject-axis sort order — 1..6 attributes, applied client-side. Default
  // groups columns by department.
  sortAttributes: DEFAULT_SORT,
  // Sort the columns by a Manager-Hierarchy context tree instead of attributes.
  // { contextId } or null (attribute sort).
  sortHierarchy: null,
  // Whether the matrix opens with its top-level groups folded into count
  // columns. 'auto' folds only when the matrix is large (keeps load fast);
  // true/false force it.
  foldOnLoad: 'auto',
};

// Per-field readers, so the normaliser below stays a flat list of fields
// instead of a wall of nested ternaries.

// One of `allowed`, else the first entry (the default).
const oneOf = (value, allowed) => (allowed.includes(value) ? value : allowed[0]);
// A non-empty string, else null.
const text = (value) => (typeof value === 'string' && value ? value : null);
// An array, deep-copied so wizard edits can't mutate the caller's filter.
const list = (value) => (Array.isArray(value) ? structuredClone(value) : []);

// One condition block (subject / resource): both sides always present, always
// arrays, always copied.
function normalizeBlock(block) {
  return { include: list(block?.include), exclude: list(block?.exclude) };
}

// 1–6 sort levels; an empty or missing list falls back to the default sort.
function normalizeSort(value) {
  const rows = Array.isArray(value) && value.length ? value.slice(0, 6) : DEFAULT_SORT;
  return structuredClone(rows);
}

// Manager-Hierarchy sort: { contextId } or null (= sort by attributes).
function normalizeHierarchy(value) {
  return typeof value?.contextId === 'string' ? { ...value } : null;
}

// Any partial / legacy / hand-edited filter → the full shape above. Unknown or
// wrongly-typed values fall back to their default rather than being carried
// through, so a step never has to defend against them.
export function normalizeMatrixFilter(f) {
  const src = f && typeof f === 'object' ? f : EMPTY_FILTER;
  return {
    rowType:     oneOf(src.rowType, ['principal', 'identity']),
    orientation: oneOf(src.orientation, ['rows-as-resources', 'rows-as-subjects']),
    subject:  normalizeBlock(src.subject),
    resource: normalizeBlock(src.resource),
    rollup: text(src.rollup),
    rollupContent: oneOf(src.rollupContent, ['resources-and-roles', 'resources-only', 'roles-only']),
    rollupMetric: oneOf(src.rollupMetric, ['count', 'percent']),
    rollupKind: oneOf(src.rollupKind, ['attribute', 'context']),
    rollupContextId: text(src.rollupContextId),
    rollupPath: list(src.rollupPath),
    // View state (drill-down / fold) of the matrix being adjusted — preserved so
    // reopening the wizard doesn't collapse what the analyst expanded.
    rollupExpanded: list(src.rollupExpanded),
    rollupCollapsed: list(src.rollupCollapsed),
    foldAttributes: !!src.foldAttributes,
    sortAttributes: normalizeSort(src.sortAttributes),
    sortHierarchy: normalizeHierarchy(src.sortHierarchy),
    foldOnLoad: oneOf(src.foldOnLoad, ['auto', true, false]),
  };
}

// ─── Matrix identity ────────────────────────────────────────────────────────
//
// "Is this the matrix I saved?" — asked by the summary bar to label the applied
// matrix with its saved name. Two things must NOT count as a different matrix:
//
//   * missing fields. The applied filter is always the full shape; a stored one
//     may predate a field or only carry what its writer cared about (the demo
//     seed writes four keys). Comparing raw JSON made a matrix stop matching
//     the saved row it came from the moment it was adjusted — so opening the
//     wizard and applying without changing anything relabelled the demo default
//     "Not saved".
//   * view state. Which groups are folded and how far the analyst has drilled
//     is where they are IN the matrix, not which matrix it is; the wizard
//     rewrites those keys on every apply.
const VIEW_STATE_KEYS = ['rollupExpanded', 'rollupCollapsed', 'rollupPath', 'foldAttributes'];

// Stable key order, so two semantically-equal filters built along different
// paths (the wizard vs. a JSONB round-trip out of the database) compare equal.
// Arrays keep their order — reordering conditions is a real change.
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

// Comparable identity of a matrix filter: equal fingerprints = the same matrix.
export function matrixFilterFingerprint(filter) {
  if (!filter || typeof filter !== 'object') return null;
  const normalized = normalizeMatrixFilter(filter);
  for (const key of VIEW_STATE_KEYS) delete normalized[key];
  return canonical(normalized);
}
