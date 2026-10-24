// Natural-language reports — a follow-up that says "he" keeps the person.
//
// "Heeft Bram de rol Global Administrator?" and then "En kan hij die rol
// aanvragen?": the second definition came back as everyone who is eligible
// for the role — the model kept the role and lost the person. The refinement
// rule (autofix.js refineFromPrevious) restores earlier conditions only when
// the entity stays the same; here it changed (the role's members → accounts
// eligible for it), and the person condition sat inside a relation. This rule
// covers exactly that: a follow-up with a third-person pronoun, no person in
// the new definition, and a person in the previous one — the person is put
// back where the new definition can hold them.

import { ENTITIES } from './catalog.js';

const PRONOUN_RE = /\b(hij|hem|haar|he|she|him|her|his|hers)\b/i;
const PERSON_FIELDS = new Set(['id', 'displayName', 'email', 'userPrincipalName']);
const isAccountKind = (entity) => ENTITIES[entity]?.detailKind === 'user';
const reachesAccounts = (entity, relation) => ENTITIES[entity]?.relations?.[relation]?.target === 'account';

/** The first "field is somebody" condition about an account, at the top level of an account report or inside a relation that reaches accounts. */
export function personIn(spec) {
  const person = (c) => c.type === 'field' && PERSON_FIELDS.has(c.field) && ['eq', 'contains'].includes(c.op) && typeof c.value === 'string';
  for (const c of spec?.conditions ?? []) {
    if (isAccountKind(spec.entity) && person(c)) return c;
    if (c.type === 'relation' && reachesAccounts(spec.entity, c.relation)) {
      const found = (c.conditions ?? []).find(person);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {object} spec      the new definition
 * @param {object} previous  the previous definition, if any
 * @param {string} question  the follow-up as typed
 * @returns {{ spec: object, notes: string[] }}
 */
export function keepThePerson(spec, previous, question) {
  const none = { spec, notes: [] };
  if (!spec || !previous || !PRONOUN_RE.test(String(question ?? ''))) return none;
  const who = personIn(previous);
  if (!who || personIn(spec)) return none;
  const note = `Read "${String(question).match(PRONOUN_RE)[0]}" as the person of the earlier question.`;
  if (isAccountKind(spec.entity)) {
    return { spec: { ...spec, match: spec.match === 'any' ? 'all' : spec.match ?? 'all', conditions: [...(spec.conditions ?? []), who] }, notes: [note] };
  }
  const conditions = [...(spec.conditions ?? [])];
  const at = conditions.findIndex(c => c.type === 'relation' && reachesAccounts(spec.entity, c.relation) && c.quantifier !== 'none');
  if (at >= 0) {
    conditions[at] = { ...conditions[at], conditions: [...(conditions[at].conditions ?? []), who] };
  } else if (ENTITIES[spec.entity]?.relations?.members) {
    conditions.push({ type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [who] });
  } else {
    return none;
  }
  return { spec: { ...spec, conditions }, notes: [note] };
}
