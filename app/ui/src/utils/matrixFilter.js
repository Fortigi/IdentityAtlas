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

// One condition block (subject / resource): both sides always present, always
// arrays, and deep-copied so wizard edits can't mutate the caller's filter.
function normalizeBlock(block) {
  const side = (v) => (Array.isArray(v) ? structuredClone(v) : []);
  return { include: side(block?.include), exclude: side(block?.exclude) };
}

// Any partial / legacy / hand-edited filter → the full shape above. Unknown or
// wrongly-typed values fall back to their default rather than being carried
// through, so a step never has to defend against them.
export function normalizeMatrixFilter(f) {
  const src = f && typeof f === 'object' ? f : EMPTY_FILTER;
  return {
    rowType:     src.rowType === 'identity' ? 'identity' : 'principal',
    orientation: src.orientation === 'rows-as-subjects' ? 'rows-as-subjects' : 'rows-as-resources',
    subject:  normalizeBlock(src.subject),
    resource: normalizeBlock(src.resource),
    rollup: typeof src.rollup === 'string' && src.rollup ? src.rollup : null,
    rollupContent: ['resources-and-roles', 'resources-only', 'roles-only'].includes(src.rollupContent)
      ? src.rollupContent : 'resources-and-roles',
    rollupMetric: src.rollupMetric === 'percent' ? 'percent' : 'count',
    rollupKind: src.rollupKind === 'context' ? 'context' : 'attribute',
    rollupContextId: typeof src.rollupContextId === 'string' && src.rollupContextId ? src.rollupContextId : null,
    rollupPath: Array.isArray(src.rollupPath) ? structuredClone(src.rollupPath) : [],
    // View state (drill-down / fold) of the matrix being adjusted — preserved so
    // reopening the wizard doesn't collapse what the analyst expanded.
    rollupExpanded: Array.isArray(src.rollupExpanded) ? structuredClone(src.rollupExpanded) : [],
    rollupCollapsed: Array.isArray(src.rollupCollapsed) ? structuredClone(src.rollupCollapsed) : [],
    foldAttributes: !!src.foldAttributes,
    sortAttributes: Array.isArray(src.sortAttributes) && src.sortAttributes.length
      ? structuredClone(src.sortAttributes.slice(0, 6)) : structuredClone(DEFAULT_SORT),
    sortHierarchy: (src.sortHierarchy && typeof src.sortHierarchy.contextId === 'string')
      ? { ...src.sortHierarchy } : null,
    foldOnLoad: [true, false, 'auto'].includes(src.foldOnLoad) ? src.foldOnLoad : 'auto',
  };
}
