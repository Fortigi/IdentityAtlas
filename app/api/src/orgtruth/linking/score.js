// Organisation truth — score org entities against indexed system rows
// (owned by workstream T2). Pure: no DB, no clock.
//
//   scoreEntity(entity, ruleIndex)        → decision
//   scoreEntities(entities, ruleIndexes)  → decision[]   (one per entity × rule of its type × value)
//   decide(candidates, threshold)         → { decision, ambiguous, confidence, candidates }
//
// A rule links THROUGH one attribute (rule.via, 'displayName' for the entity
// itself). The value of that attribute is split (import/applyRecipe splitValues:
// a SharePoint "A;#27;#B;#16" lookup, a list of e-mail addresses) and every
// value is scored on its own, so a cell naming three people yields three
// decisions. An empty attribute yields one 'none' decision.
//
// A decision:
//   { entity, entityType, targetType, rule, via, value, decision: 'accepted' | 'proposed' | 'none',
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
import { splitValues } from '../import/applyRecipe.js';
import { NAME_ATTRIBUTE } from '../contracts.js';

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

/** The values a rule scores for an entity: the split value of its `via` attribute. */
export function valuesOf(entity, via) {
  const raw = orgValueOf(entity, via);
  return raw ? splitValues(raw) : [];
}

/** The entity as the rule sees it for ONE value of its `via` attribute. */
export function withValue(entity, via, value) {
  if (via === NAME_ATTRIBUTE) return { ...entity, displayName: value };
  return { ...entity, attributes: { ...(entity.attributes ?? {}), [via]: value } };
}

function scoreOne(entity, ruleIndex) {
  const via = ruleIndex.rule.via ?? NAME_ATTRIBUTE;
  const values = valuesOf(entity, via);
  const common = { entity, rule: ruleIndex.rule, via };
  if (values.length === 0) return [{ ...scoreEntity(entity, ruleIndex), ...common, value: '' }];
  return values.map(value => ({ ...scoreEntity(withValue(entity, via, value), ruleIndex), ...common, value }));
}

export function scoreEntities(entities, ruleIndexes) {
  const byType = new Map();
  for (const ri of ruleIndexes?.values?.() ?? []) {
    byType.set(ri.rule.entityType, [...(byType.get(ri.rule.entityType) ?? []), ri]);
  }
  const out = [];
  for (const entity of entities ?? []) {
    for (const ri of byType.get(entity.entityType) ?? []) out.push(...scoreOne(entity, ri));
  }
  return out;
}
