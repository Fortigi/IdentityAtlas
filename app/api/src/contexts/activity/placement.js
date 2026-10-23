// Context activity — which context each row of an export lands on, and how they spread.
//
//   placeEntries(entries, mapping, context, units) → { placed, contexts, distribution }   pure
//
// The target set is the context the export is uploaded on and every context
// below it (store.js descendantsOf, all levels). Without a unit column every
// row lands on the context itself — a file about one unit, on a leaf or on a
// parent alike. With one, each distinct value is matched once (match.js
// matchContexts: the context's own key or name, then the subtree by key, name,
// near miss; ambiguous never guessed) and a row with an EMPTY unit cell goes
// where the mapping says: the context itself (emptyContext 'self', the
// default) or left out ('skip').
//
// The distribution is what the preview and the result report:
//   { onSelf, onSubUnits, subUnits, deepestLevel, unmatched, ambiguous, empty, emptyTo,
//     unmatchedSamples, ambiguousSamples }
// in rows (subUnits: the distinct units below reached; deepestLevel: 1 = a direct sub-unit,
// 0 = none reached), each sample { value, rows }.

import { matchContexts } from './match.js';

export const MAX_DISTRIBUTION_SAMPLES = 10;

// Row counts per non-empty unit value.
function valueCounts(entries) {
  const counts = new Map();
  for (const e of entries) if (e.contextValue) counts.set(e.contextValue, (counts.get(e.contextValue) ?? 0) + 1);
  return counts;
}

function samplesOf(outcome, counts, kind) {
  return [...outcome].filter(([, o]) => o === kind).slice(0, MAX_DISTRIBUTION_SAMPLES)
    .map(([value]) => ({ value, rows: counts.get(value) }));
}

function rowsWith(outcome, counts, kind) {
  let n = 0;
  for (const [value, o] of outcome) if (o === kind) n += counts.get(value);
  return n;
}

/** How the placed rows spread over the context and the units below it. */
export function distributionOf({ placed, selfId, depthOf, outcome = new Map(), counts = new Map(), empty = 0, emptyTo = 'self' }) {
  const reached = new Set();
  let onSelf = 0;
  let onSubUnits = 0;
  for (const e of placed) {
    if (!e.contextId) continue;
    if (e.contextId === selfId) { onSelf++; continue; }
    onSubUnits++;
    reached.add(e.contextId);
  }
  return {
    onSelf,
    onSubUnits,
    subUnits: reached.size,
    deepestLevel: [...reached].reduce((max, id) => Math.max(max, depthOf.get(id) ?? 0), 0),
    unmatched: rowsWith(outcome, counts, 'unmatched'),
    ambiguous: rowsWith(outcome, counts, 'ambiguous'),
    empty,
    emptyTo,
    unmatchedSamples: samplesOf(outcome, counts, 'unmatched'),
    ambiguousSamples: samplesOf(outcome, counts, 'ambiguous'),
  };
}

/**
 * @param {object[]} entries  rows.js readActivityRows() entries
 * @param {object} mapping    a checked mapping (contextColumn, emptyContext)
 * @param {object} context    the uploaded-on context { id, externalId, displayName }
 * @param {object[]} units    every context below it { id, externalId, displayName, depth }
 * @returns {{ placed: object[], contexts: object|null, distribution: object }} placed: each entry
 *   with its contextId (null: not imported); contexts: the match stats (null without a unit column).
 */
export function placeEntries(entries, mapping, context, units) {
  const depthOf = new Map(units.map(u => [u.id, u.depth ?? 1]));
  if (!mapping.contextColumn) {
    const placed = entries.map(e => ({ ...e, contextId: context.id }));
    return { placed, contexts: null, distribution: distributionOf({ placed, selfId: context.id, depthOf }) };
  }
  const counts = valueCounts(entries);
  const { ids, outcome, stats } = matchContexts(units, counts, { self: context });
  const emptyTo = mapping.emptyContext === 'skip' ? 'skip' : 'self';
  const emptyId = emptyTo === 'self' ? context.id : null;
  const placed = entries.map(e => ({ ...e, contextId: e.contextValue ? ids.get(e.contextValue) ?? null : emptyId }));
  const empty = entries.length - [...counts.values()].reduce((s, n) => s + n, 0);
  return {
    placed,
    contexts: { ...stats, emptyRows: empty },
    distribution: distributionOf({ placed, selfId: context.id, depthOf, outcome, counts, empty, emptyTo }),
  };
}
