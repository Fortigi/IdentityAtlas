// Pure helpers for the matrix "Contexts" metadata column (#870): turning the
// /matrix/data resourceContexts sidecar into a per-resource lookup, the
// "first 2 + N more" display split, and the comma-joined Excel export string.
// Kept out of the JSX so the branches are instrumentable by unit tests.

export const MAX_VISIBLE_CONTEXTS = 2;

// Sidecar array → Map<UPPERCASE resourceId, contexts[]> (case-insensitive id
// matching, same convention as groupTagMap / managedApMap).
export function buildResourceContextsMap(resourceContexts) {
  const map = new Map();
  for (const r of resourceContexts || []) {
    if (!r?.resourceId) continue;
    map.set(String(r.resourceId).toUpperCase(), r.contexts || []);
  }
  return map;
}

// Contexts for one matrix row. Synthetic rows (nested, ownership) carry the
// real resource id in realGroupId — always resolve through it.
export function contextsForGroup(map, group) {
  if (!map || !group) return [];
  return map.get(String(group.realGroupId || group.id).toUpperCase()) || [];
}

// The cell shows the first MAX_VISIBLE_CONTEXTS chips (server-ordered by
// contextType, then displayName); `expanded` reveals the rest inline.
export function splitContexts(contexts, expanded) {
  const all = contexts || [];
  const shown = expanded ? all : all.slice(0, MAX_VISIBLE_CONTEXTS);
  return { shown, hiddenCount: all.length - shown.length };
}

// Full, untruncated list for the Excel export column.
export function contextNames(contexts) {
  return (contexts || []).map(c => c.displayName).join(', ');
}
