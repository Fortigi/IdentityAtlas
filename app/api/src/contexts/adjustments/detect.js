// Recognising a unit or a value the source has re-keyed.
//
// An adjustment points at a unit by id and, for a split, at an attribute value.
// When HR renames a department or a list row gets a new key, that target
// disappears and a new one appears with (mostly) the same members. We never
// follow it silently: these helpers only PROPOSE where it went, and the analyst
// decides (status needsDecision). Pure.

// At least half of the members it had when the adjustment was made.
export function overlapThreshold(snapshotSize) {
  return Math.max(1, Math.ceil(snapshotSize * 0.5));
}

// candidates: [{ contextId, count }] — how many of the snapshot's members each
// unit of the tree holds now. Returns the best one over the threshold, or null.
// A tie is no answer: two equally good successors need the analyst anyway.
export function pickSuccessor(snapshotSize, candidates) {
  if (!snapshotSize) return null;
  const ranked = [...candidates].sort((a, b) => b.count - a.count);
  const [best, second] = ranked;
  if (!best || best.count < overlapThreshold(snapshotSize)) return null;
  if (second && second.count === best.count) return null;
  return best;
}

// values: [{ value, count }] — the attribute values the people it split off
// have now. Returns the new value when most of them moved to one other value.
export function pickRenamedValue(snapshotSize, values, oldValue) {
  const others = values.filter(v => v.value != null && v.value !== '' && v.value !== oldValue);
  const best = pickSuccessor(snapshotSize, others.map(v => ({ contextId: v.value, count: v.count })));
  return best ? { value: best.contextId, count: best.count } : null;
}
