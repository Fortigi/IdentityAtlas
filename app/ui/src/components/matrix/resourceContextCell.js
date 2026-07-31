// Pure logic for the matrix "Contexts" metadata column (#870): which of a
// resource's contexts are visible in the cell, and how many are hidden behind
// the "+N" expand toggle. Kept out of the JSX so the branches are unit-tested
// and instrumented (the row components are pure-JSX shells, see #725).

// Max chips shown before collapsing the rest behind "+N" (spec decision D4).
export const MAX_VISIBLE_CONTEXTS = 2;

// Returns { shown, hiddenCount }. The server already sorts contexts by
// contextType then displayName, so "the first 2" is stable — no re-sorting.
export function visibleContexts(contexts, expanded = false) {
  const all = Array.isArray(contexts) ? contexts : [];
  if (expanded || all.length <= MAX_VISIBLE_CONTEXTS) {
    return { shown: all, hiddenCount: 0 };
  }
  return {
    shown: all.slice(0, MAX_VISIBLE_CONTEXTS),
    hiddenCount: all.length - MAX_VISIBLE_CONTEXTS,
  };
}

// Build the Map the row renderer reads: UPPERCASED resourceId → contexts[].
// (Resource ids elsewhere in the matrix are matched case-insensitively via
// toUpperCase — e.g. groupTagMap before it — so this map follows suit.)
export function buildResourceContextMap(resourceContexts) {
  const map = new Map();
  for (const rc of resourceContexts || []) {
    if (!rc?.resourceId) continue;
    map.set(String(rc.resourceId).toUpperCase(), rc.contexts || []);
  }
  return map;
}

// Map lookup for a row: tolerates a missing map and normalises the id casing.
// Kept here (not inline in MatrixGroupRow/exportToExcel) so those grandfathered
// units gain no branches — their complexity ceilings only ratchet down.
export function contextsFor(map, resourceId) {
  return map?.get(String(resourceId).toUpperCase());
}

// All context names comma-joined (full, untruncated) — the Excel export cell.
export function contextNames(contexts) {
  return (Array.isArray(contexts) ? contexts : []).map(c => c.displayName).join(', ');
}
