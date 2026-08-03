// Helpers for the matrix Contexts column.
//
// The server ships a per-resource sidecar (`resourceContexts` on the flat-grid
// response) already ordered by contextType then displayName. These pure
// functions turn it into what the grid and the Excel export need — kept out of
// the JSX so the lookup/expand logic stays unit-testable.

// How many context chips a matrix row shows before the "+N" expander.
export const CONTEXT_CHIP_LIMIT = 2;

/**
 * Index the sidecar by resource id (upper-cased, matching how the matrix keys
 * every other resource lookup — ids arrive in mixed case across sources).
 *
 * @param {Array<{resourceId: string, contexts: Array}>} resourceContexts
 * @returns {Map<string, Array>}
 */
export function buildResourceContextMap(resourceContexts) {
  const map = new Map();
  for (const entry of resourceContexts || []) {
    if (!entry?.resourceId) continue;
    map.set(String(entry.resourceId).toUpperCase(), entry.contexts || []);
  }
  return map;
}

/**
 * The contexts of one resource, or an empty array. Falls back to the row's real
 * resource id (nested/synthetic rows carry `realGroupId`).
 */
export function contextsForResource(map, resourceId) {
  if (!map || !resourceId) return [];
  return map.get(String(resourceId).toUpperCase()) || [];
}

/**
 * Split a resource's contexts into the chips shown by default and the count
 * hidden behind the expander. `expanded` shows all of them.
 */
export function splitContextChips(contexts, expanded = false, limit = CONTEXT_CHIP_LIMIT) {
  const all = contexts || [];
  if (expanded || all.length <= limit) return { shown: all, hiddenCount: 0 };
  return { shown: all.slice(0, limit), hiddenCount: all.length - limit };
}

/**
 * Full, untruncated context list for one row as a single cell value — used by
 * the Excel export, where there's no expander to hide behind.
 */
export function formatContextsForExport(contexts) {
  return (contexts || []).map(c => c?.displayName).filter(Boolean).join(', ');
}
