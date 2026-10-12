// Organisation knowledge extraction — stage 5: which existing objects a mention may be.
//
//   mentionRules(mentionType)           → the link rules for that kind of mention (normalised)
//   rankCandidates(label, ruleIndexes)  → [{ targetType, targetId, label, confidence, signals, matchedValue }] best first
//   resolution(candidates)              → { status: 'candidates'|'ambiguous'|'unmatched', candidates }
//   resolveMentions(mentions)           → Map<mentionKey, resolution>    (one DB load per rule set)
//
// The Org Info linking engine (linking/score.js) does the scoring, with rules made
// for a spoken name instead of a list column:
//
//   person        Identity, Principal — full name exact, every word of the mention
//                 is a word of the name ("Rob" ⊂ "Rob Bakker"), fuzzy
//   team, role    Resource (groups), Context, another organisation list's entity
//   customer, organisation   another list's entity first (the imported customer
//                 list), then groups and contexts named after it
//   application   Resource, list entity
//   location      list entity;   concept → nothing (a description, not an object)
//
// Nothing is ever accepted here: every candidate becomes a PROPOSED link an analyst
// confirms. Two candidates of one type at the same top score are 'ambiguous' — the
// two Robs stay two Robs. A first name alone never scores like a full name.
import { normalizeLinkRules } from '../contracts.js';
import { loadRuleIndexes, ruleKey } from '../linking/candidates.js';
import { scoreEntity } from '../linking/score.js';
import { MENTION_TYPES } from './contracts.js';

export const SHOW_FROM = 40;
export const MAX_CANDIDATES = 5;
// The entityType the scored mention pretends to be: never the type of a real list.
export const PROBE_ENTITY_TYPE = '\u0000mention';

const sig = (targetField, type, weight) => ({ name: `${targetField} ${type}`, attribute: 'displayName', targetField, type, weight });

const PERSON = [sig('displayName', 'exact', 85), sig('displayName', 'token', 45), sig('displayName', 'fuzzy', 40)];
const NAMED = [sig('displayName', 'exact', 90), sig('displayName', 'fuzzy', 60)];
const LIST = [sig('displayName', 'fuzzy', 100)];

const TARGETS = {
  person: [['Identity', PERSON], ['Principal', PERSON]],
  team: [['Resource', NAMED], ['Context', NAMED], ['OrgEntity', LIST]],
  role: [['Context', NAMED], ['Resource', NAMED], ['OrgEntity', LIST]],
  customer: [['OrgEntity', LIST], ['Resource', NAMED], ['Context', NAMED]],
  organisation: [['OrgEntity', LIST], ['Resource', NAMED], ['Context', NAMED]],
  application: [['Resource', NAMED], ['OrgEntity', LIST]],
  location: [['OrgEntity', LIST]],
  concept: [],
};

export function mentionRules(mentionType) {
  if (!MENTION_TYPES.includes(mentionType)) return [];
  return normalizeLinkRules(TARGETS[mentionType].map(([targetType, signals]) => ({
    entityType: PROBE_ENTITY_TYPE, targetType, via: 'displayName', threshold: SHOW_FROM,
    name: `${mentionType} → ${targetType}`, signals,
  })));
}

const probe = (label) => ({ id: null, entityType: PROBE_ENTITY_TYPE, displayName: label, attributes: {} });

/** Every candidate of every rule, best first; on equal scores the rule listed first. */
export function rankCandidates(label, ruleIndexes) {
  const all = [];
  ruleIndexes.forEach((ri, order) => {
    if (!ri) return;
    for (const c of scoreEntity(probe(label), ri).allCandidates) {
      if (c.confidence >= SHOW_FROM) all.push({ ...c, order });
    }
  });
  const seen = new Set();
  return all
    .sort((a, b) => b.confidence - a.confidence || a.order - b.order || String(a.targetId).localeCompare(String(b.targetId)))
    .filter(c => (seen.has(`${c.targetType}:${c.targetId}`) ? false : seen.add(`${c.targetType}:${c.targetId}`)))
    .slice(0, MAX_CANDIDATES)
    .map(({ targetType, targetId, label: l, confidence, signals, matchedField, matchedValue }) => ({
      targetType, targetId, label: l, confidence, signals: [...(signals ?? [])], matchedField: matchedField ?? null, matchedValue: matchedValue ?? null,
    }));
}

/**
 * Ambiguous when two different objects OF ONE TYPE share the top score: "Mark" as
 * the identity Mark van Eijken is unique, but as an account it ties with
 * "Vries, Mark de" (measured on the Fortigi tenant) — that is two Marks. The same
 * person as identity and as account at one score is not a tie.
 */
export function resolution(candidates) {
  if (candidates.length === 0) return { status: 'unmatched', candidates };
  const top = candidates[0].confidence;
  const atTop = candidates.filter(c => c.confidence === top);
  const types = atTop.map(c => c.targetType);
  const tie = types.some((t, i) => types.indexOf(t) !== i);
  return { status: tie ? 'ambiguous' : 'candidates', candidates };
}

/** @param {{ key, type, label }[]} mentions */
export async function resolveMentions(mentions) {
  const out = new Map();
  const byType = new Map();
  for (const m of mentions) byType.set(m.type, [...(byType.get(m.type) ?? []), m]);
  for (const [type, list] of byType) {
    const rules = mentionRules(type);
    if (rules.length === 0) {
      for (const m of list) out.set(m.key, { status: 'unmatched', candidates: [], reason: 'not-resolvable' });
      continue;
    }
    const indexes = await loadRuleIndexes(rules);
    const ordered = rules.map(r => indexes.get(ruleKey(r)));
    for (const m of list) out.set(m.key, resolution(rankCandidates(m.label, ordered)));
  }
  return out;
}
