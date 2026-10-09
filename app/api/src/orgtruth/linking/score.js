// Organisation truth — score org entities against indexed system rows
// (owned by workstream T2). Pure: no DB, no clock.
//
//   scoreEntity(entity, ruleIndex)        → decision
//   scoreEntities(entities, ruleIndexes)  → decision[]   (entities without a rule are skipped)
//   decide(candidates, threshold)         → { decision, ambiguous, confidence, candidates }
//
// A decision:
//   { entity, entityType, targetType, decision: 'accepted' | 'proposed' | 'none',
//     ambiguous, confidence, signals: ['email', 'name'],
//     candidates: [{ targetType, targetId, label, confidence, signals, matchedField, matchedValue }],
//     allCandidates: [...every candidate that scored above 0, unsorted] }
//
// Per candidate the weights of the signals that match are summed (cap 100).
//   best ≥ threshold, no runner-up at the same score  → accepted (candidates = [best])
//   best ≥ threshold, tie                             → proposed, ambiguous (top 5)
//   PROPOSE_FLOOR ≤ best < threshold                  → proposed, low confidence (top 5 ≥ floor)
//   otherwise                                         → none
// A tie is never guessed (docs/architecture/org-truth.md, Contracts).
import { orgValueOf, signalKeys, evaluateSignal } from './signals.js';

export const MAX_CONFIDENCE = 100;
export const PROPOSE_FLOOR = 20;
export const MAX_CANDIDATES = 5;

function gatherRows(entity, ruleIndex) {
  const rows = new Map();
  for (const s of ruleIndex.rule.signals) {
    const value = orgValueOf(entity, s.attribute);
    if (!value) continue;
    const idx = ruleIndex.bySignal.get(s.name) ?? new Map();
    const postings = signalKeys(s.type, value).map(key => idx.get(key) ?? []);
    for (const row of candidateRows(s.type, postings)) rows.set(row.id, row);
  }
  return rows;
}

// A token signal needs EVERY token, so the rarest token's posting list already
// holds every possible match: read only that one (a common token such as
// "users" may index half the groups).
function candidateRows(type, postings) {
  if (type !== 'token') return postings.flat();
  if (postings.length === 0) return [];
  return postings.reduce((a, b) => (b.length < a.length ? b : a));
}

/** Score one system row against every signal of the rule. */
export function scoreCandidate(entity, rule, row) {
  let total = 0;
  let best = null;
  const matched = [];
  for (const s of rule.signals) {
    const value = orgValueOf(entity, s.attribute);
    const earned = value ? evaluateSignal(s, value, row[s.targetField]) : 0;
    if (earned === 0) continue;
    total += earned;
    matched.push(s.name);
    if (!best || earned > best.earned) best = { earned, field: s.targetField, value: row[s.targetField] };
  }
  return {
    targetType: rule.targetType,
    targetId: row.id,
    label: row.displayName ?? null,
    confidence: Math.min(total, MAX_CONFIDENCE),
    signals: matched,
    matchedField: best?.field ?? null,
    matchedValue: best?.value == null ? null : String(best.value),
  };
}

const byConfidence = (a, b) => b.confidence - a.confidence || String(a.targetId).localeCompare(String(b.targetId));

/** The decision for a sorted (desc) candidate list. */
export function decide(candidates, threshold) {
  const sorted = [...candidates].sort(byConfidence);
  const best = sorted[0];
  if (!best || best.confidence === 0) return { decision: 'none', ambiguous: false, confidence: 0, candidates: [] };
  const tie = sorted.length > 1 && sorted[1].confidence === best.confidence;
  if (best.confidence >= threshold && !tie) {
    return { decision: 'accepted', ambiguous: false, confidence: best.confidence, candidates: [best] };
  }
  if (best.confidence >= threshold) {
    return { decision: 'proposed', ambiguous: true, confidence: best.confidence, candidates: sorted.slice(0, MAX_CANDIDATES) };
  }
  if (best.confidence >= PROPOSE_FLOOR) {
    const top = sorted.filter(c => c.confidence >= PROPOSE_FLOOR).slice(0, MAX_CANDIDATES);
    return { decision: 'proposed', ambiguous: false, confidence: best.confidence, candidates: top };
  }
  return { decision: 'none', ambiguous: false, confidence: best.confidence, candidates: [] };
}

export function scoreEntity(entity, ruleIndex) {
  const { rule } = ruleIndex;
  const scored = [...gatherRows(entity, ruleIndex).values()]
    .map(row => scoreCandidate(entity, rule, row))
    .filter(c => c.confidence > 0);
  const d = decide(scored, rule.threshold);
  const signals = [...new Set(d.candidates.flatMap(c => c.signals))];
  // allCandidates: every row that scored, so the run writer can decide again
  // after removing targets an analyst rejected (plan.js).
  return { entity, entityType: rule.entityType, targetType: rule.targetType, ...d, signals, allCandidates: scored };
}

export function scoreEntities(entities, ruleIndexes) {
  const out = [];
  for (const entity of entities ?? []) {
    const ruleIndex = ruleIndexes.get(entity.entityType);
    if (ruleIndex) out.push(scoreEntity(entity, ruleIndex));
  }
  return out;
}
