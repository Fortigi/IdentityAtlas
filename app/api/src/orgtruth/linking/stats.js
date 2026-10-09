// Organisation truth — link statistics without writing anything (owned by
// workstream T2). The dry-run (T1) calls this with the entities a recipe would
// produce, so the wizard's data-quality step can say, per entity type:
// how many match one system object, several, or none.
//
// Contract:
//   linkStats(entities, linkRules) → Promise<{
//     [entityType]: { total, unique, ambiguous, none, lowConfidence,
//                     samples: { ambiguous: [{ displayName, candidates: [{ targetType, targetId, label, confidence }] }],
//                                none: [{ displayName }] } }
//   }>                                                            ≤ SAMPLE_LIMIT samples each
//
// `entities` is the in-memory shape applyRecipe produces:
//   { entityType, displayName, canonicalKey, attributes: { [name]: value } }
// `linkRules` is normalised (normalizeLinkRules: threshold present, signals named).
//
// DECISION (T2): total = unique + ambiguous + none. `ambiguous` counts EVERY
// entity that would wait in review (a tie at/above the threshold, or a best
// score under it); `lowConfidence` is the part of `ambiguous` that is under
// the threshold, so the wizard can explain "3 ties, 5 weak matches" without
// the three headline numbers ever failing to add up.
import { loadRuleIndexes } from './candidates.js';
import { scoreEntities } from './score.js';

export const SAMPLE_LIMIT = 10;

function emptyBlock() {
  return { total: 0, unique: 0, ambiguous: 0, none: 0, lowConfidence: 0, samples: { ambiguous: [], none: [] } };
}

function sampleCandidates(candidates) {
  return candidates.map(c => ({ targetType: c.targetType, targetId: c.targetId, label: c.label, confidence: c.confidence }));
}

function count(block, d) {
  block.total += 1;
  if (d.decision === 'accepted') { block.unique += 1; return; }
  if (d.decision === 'none') {
    block.none += 1;
    if (block.samples.none.length < SAMPLE_LIMIT) block.samples.none.push({ displayName: d.entity.displayName });
    return;
  }
  block.ambiguous += 1;
  if (!d.ambiguous) block.lowConfidence += 1;
  if (block.samples.ambiguous.length < SAMPLE_LIMIT) {
    block.samples.ambiguous.push({ displayName: d.entity.displayName, candidates: sampleCandidates(d.candidates) });
  }
}

/** Pure aggregation of score decisions into the per-type blocks. */
export function summarize(decisions, linkRules) {
  const out = {};
  for (const rule of linkRules ?? []) out[rule.entityType] = emptyBlock();
  for (const d of decisions) count(out[d.entityType], d);
  return out;
}

export async function linkStats(entities, linkRules) {
  const rules = linkRules ?? [];
  if (rules.length === 0) return {};
  const wanted = new Set(rules.map(r => r.entityType));
  const ruled = (entities ?? []).filter(e => wanted.has(e.entityType));
  const indexes = ruled.length > 0 ? await loadRuleIndexes(rules) : new Map();
  return summarize(scoreEntities(ruled, indexes), rules);
}
