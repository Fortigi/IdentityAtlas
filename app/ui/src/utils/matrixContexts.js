// Pure helpers for the matrix "Contexts" metadata column (issue #870): the
// server sends a per-resource sidecar (`resourceContexts` on /api/matrix/data);
// these shape it for the row renderer and the Excel export. Kept out of the
// JSX shell so the display logic is unit-coverable.

// How many context chips a row shows before the "+N" expand.
export const CONTEXTS_SHOWN_LIMIT = 2;

// [{ resourceId, contexts: [...] }] → Map keyed by UPPERCASE resource id
// (matrix row ids come from several sources with mixed casing).
export function buildResourceContextsMap(resourceContexts) {
  const map = new Map();
  for (const r of resourceContexts || []) {
    if (!r?.resourceId) continue;
    map.set(String(r.resourceId).toUpperCase(), Array.isArray(r.contexts) ? r.contexts : []);
  }
  return map;
}

// Contexts for one matrix row. Rows can be synthetic (owner/nested rows carry
// the real resource id in realGroupId), so resolve that before the lookup.
export function contextsForGroup(resourceContextsMap, group) {
  if (!resourceContextsMap || !group) return [];
  const id = group.realGroupId || group.id;
  return (id && resourceContextsMap.get(String(id).toUpperCase())) || [];
}

// First `limit` chips are always visible; the rest sit behind the +N toggle.
export function splitContextsForDisplay(contexts, limit = CONTEXTS_SHOWN_LIMIT) {
  const list = Array.isArray(contexts) ? contexts : [];
  return { shown: list.slice(0, limit), hidden: list.slice(limit) };
}

// Full, untruncated comma-joined name list — used by the Excel export.
export function contextNamesJoined(contexts) {
  return (Array.isArray(contexts) ? contexts : []).map(c => c.displayName).join(', ');
}
