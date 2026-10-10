// Organisation truth — link statistics without writing anything (owned by
// workstream T2). The dry-run (T1) calls this with the entities a recipe would
// produce, so the wizard's data-quality step can say, per link rule:
// how many values match one system object, several, or none.
//
// Contract:
//   linkStats(entities, linkRules) → Promise<{
//     [ruleName]: { entityType, targetType, via, total, unique, ambiguous, none, lowConfidence, empty,
//                   samples: { ambiguous: [{ displayName, candidates: [{ targetType, targetId, label, confidence }] }],
//                              none: [{ displayName }] } }
//   }>                                                            ≤ SAMPLE_LIMIT samples each
//
// One block per RULE (entityType → targetType via attribute), keyed by the
// rule's name; `total` counts the VALUES scored: a team cell naming three
// people counts three. A sample's displayName is the value that was scored
// (the entity's name when the rule links via the entity itself).
//
// `entities` is the in-memory shape applyRecipe produces:
//   { entityType, displayName, canonicalKey, attributes: { [name]: value } }
// `linkRules` is normalised (normalizeLinkRules: threshold, via, name present).
//
// DECISION (T2): total = unique + ambiguous + none. `ambiguous` counts EVERY
// value that would wait in review (a tie at/above the threshold, or a best
// score under it); `lowConfidence` is the part of `ambiguous` that is under
// the threshold, so the wizard can explain "3 ties, 5 weak matches" without
// the three headline numbers ever failing to add up.
import { ruleName } from '../contracts.js';
import { loadRuleIndexes } from './candidates.js';
import { scoreEntities } from './score.js';

export const SAMPLE_LIMIT = 10;

function emptyBlock(rule) {
  return {
    entityType: rule.entityType, targetType: rule.targetType, via: rule.via,
    total: 0, unique: 0, ambiguous: 0, none: 0, lowConfidence: 0, empty: 0, samples: { ambiguous: [], none: [] },
  };
}

// An entity whose `via` attribute is empty has nothing to link: it is counted
// as `empty`, outside total (an empty team cell is not a failed match).
export const isEmptyDecision = (d) => !d.value && d.via && d.via !== 'displayName';

function sampleCandidates(candidates) {
  return candidates.map(c => ({ targetType: c.targetType, targetId: c.targetId, label: c.label, confidence: c.confidence }));
}

const sampleName = (d) => d.value || d.entity.displayName;

function count(block, d) {
  if (isEmptyDecision(d)) { block.empty += 1; return; }
  block.total += 1;
  if (d.decision === 'accepted') { block.unique += 1; return; }
  if (d.decision === 'none') {
    block.none += 1;
    if (block.samples.none.length < SAMPLE_LIMIT) block.samples.none.push({ displayName: sampleName(d) });
    return;
  }
  block.ambiguous += 1;
  if (!d.ambiguous) block.lowConfidence += 1;
  if (block.samples.ambiguous.length < SAMPLE_LIMIT) {
    block.samples.ambiguous.push({ displayName: sampleName(d), candidates: sampleCandidates(d.candidates) });
  }
}

const keyOf = (rule) => rule.name ?? ruleName(rule);

/** Pure aggregation of score decisions into the per-rule blocks. */
export function summarize(decisions, linkRules) {
  const out = {};
  for (const rule of linkRules ?? []) out[keyOf(rule)] = emptyBlock(rule);
  for (const d of decisions) {
    const block = out[keyOf(d.rule)] ?? (out[keyOf(d.rule)] = emptyBlock(d.rule));
    count(block, d);
  }
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
