// Helpers for the matrix "Contexts" column — the Contexts each resource row
// belongs to (group category, tags, clusters, business processes, …), served as
// the `resourceContexts` sidecar on /api/matrix/data.
//
// Kept out of the JSX so the grouping / "first N + rest" logic is unit-testable.

// How many context chips a row shows before collapsing the rest behind "+N".
export const CONTEXT_CHIP_LIMIT = 2;

// [{ resourceId, contexts:[…] }] → Map<UPPERCASE resourceId, contexts[]>.
// Resource ids arrive in mixed case from different queries, so keys are
// normalised the same way the tag/AP maps do it.
export function buildResourceContextMap(resourceContexts) {
  const map = new Map();
  for (const entry of resourceContexts || []) {
    const key = typeof entry?.resourceId === 'string' ? entry.resourceId.toUpperCase() : null;
    if (!key) continue;
    const contexts = Array.isArray(entry.contexts) ? entry.contexts : [];
    if (contexts.length > 0) map.set(key, contexts);
  }
  return map;
}

// Contexts for one resource row, keyed case-insensitively; always an array.
export function contextsFor(map, resourceId) {
  const key = typeof resourceId === 'string' ? resourceId.toUpperCase() : String(resourceId ?? '').toUpperCase();
  return map?.get(key) ?? [];
}

// Split into the chips shown by default and the ones behind the "+N" toggle.
export function splitContexts(contexts, limit = CONTEXT_CHIP_LIMIT) {
  const all = Array.isArray(contexts) ? contexts : [];
  return { shown: all.slice(0, limit), hiddenCount: Math.max(0, all.length - limit) };
}

// Full, untruncated list for the Excel export cell.
export function contextNames(contexts) {
  return (Array.isArray(contexts) ? contexts : [])
    .map(c => c?.displayName)
    .filter(Boolean)
    .join(', ');
}
