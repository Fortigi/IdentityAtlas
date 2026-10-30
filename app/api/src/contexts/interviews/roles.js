// Context interviews — which role a role claim suggests. Fixed rules, no model.
//
//   suggestionFor(relation)        → 'Accountable' | 'Responsible' | null
//   deduceRoles(claims)            → the claims with roleSuggestion set
//   accountableDoubt(claims, holder) → the claim that puts the current Accountable in doubt, or null
//   splitJointSubjects(claims)     → one claim per person where the model joined two
//                                    ("Ruud en Kees", "Ruud and Kees")
//   withLeftMemberships(claims)    → the claims plus a membership claim (former) for
//                                    each person a role claim says left
//
// The model states WHAT was said (claims.js: the relation, in the speaker's
// words); these rules decide what it means for the context's roles:
//
//   owner              "I'm the owner" / "Y owns it"          → Accountable for the subject
//   dayToDay, delegate "Piet does the day-to-day", "my backup" → Responsible for the subject
//   notOwner           "I'm not the owner"                     → nothing to set; the current
//                       Accountable is in doubt when the claim is about them
//   member, other                                              → nothing
//
// Within one interview: a subject who says both that they own it and that they
// do not gets no Accountable suggestion (the interview contradicts itself — the
// claims stay for review); one subject gets at most one suggestion per role.
// Only a 'role' claim suggests; a roleHistory claim is about the past.
//
// Two rules about who is in it, so the members lists read proper membership claims:
//
//   joint subject   a person claim whose subject is two or more names joined by
//                   en / and / & (commas between earlier ones) is one claim per
//                   name, the rest the same — "Ruud en Kees hebben eraan gewerkt"
//                   is about Ruud and about Kees
//   left            a role / roleHistory claim that says the person left
//                   (leftSignal.js: "recently left", "inmiddels uitgestroomd") adds
//                   a membership claim with status former — same person, quote and
//                   period — unless the model already gave a membership claim for
//                   that person; one per person

import { leftSignal } from './leftSignal.js';

const SUGGESTS = { owner: 'Accountable', dayToDay: 'Responsible', delegate: 'Responsible' };

export function suggestionFor(relation) {
  return SUGGESTS[relation] ?? null;
}

/** Who a claim is about, as one key: the matched holder, else the name as spoken. */
export function subjectKey(c) {
  if (c.principalId) return `p:${c.principalId}`;
  if (c.identityId) return `i:${c.identityId}`;
  return `n:${String(c.subjectName ?? '').trim().toLowerCase()}`;
}

/** Set roleSuggestion on every claim (null where none). Returns new objects; pure. */
export function deduceRoles(claims) {
  const disowned = new Set(claims.filter(c => c.claimKind === 'role' && c.attribute === 'notOwner').map(subjectKey));
  const given = new Set();
  return claims.map(c => {
    if (c.claimKind !== 'role') return { ...c, roleSuggestion: null };
    let role = suggestionFor(c.attribute);
    const key = subjectKey(c);
    if (role === 'Accountable' && disowned.has(key)) role = null;
    if (role && given.has(`${role}|${key}`)) role = null;
    if (role) given.add(`${role}|${key}`);
    return { ...c, roleSuggestion: role };
  });
}

/**
 * The first claim, not rejected, in which the current Accountable (`holder`:
 * { principalId } or { identityId }) says they are not the owner — or null.
 */
export function accountableDoubt(claims, holder) {
  if (!holder || !(holder.principalId || holder.identityId)) return null;
  const key = subjectKey(holder);
  return claims.find(c => c.claimKind === 'role' && c.attribute === 'notOwner' && c.status !== 'rejected' && subjectKey(c) === key) || null;
}

const PERSON_KINDS = new Set(['role', 'roleHistory', 'membership']);
const JOINER = /\s+(?:en|and)\s+|\s*&\s*/iu;

/** The names in a joint subject ("A, B en C"), or null when it names one person. Pure. */
export function jointNames(subject) {
  // Whitespace folded first, so the joiner never scans a long run of spaces.
  const s = String(subject ?? '').replace(/\s+/g, ' ').trim();
  if (!JOINER.test(s)) return null;
  const names = s.split(JOINER).flatMap(part => part.split(',')).map(n => n.trim()).filter(Boolean);
  return names.length > 1 ? names : null;
}

/** One claim per person where a person claim names two or more. Returns new objects; pure. */
export function splitJointSubjects(claims) {
  return claims.flatMap(c => {
    const names = PERSON_KINDS.has(c.claimKind) ? jointNames(c.subjectName) : null;
    return names ? names.map(subjectName => ({ ...c, subjectName })) : [c];
  });
}

/** The claims, plus a membership claim (former) per person a role claim says left. Pure. */
export function withLeftMemberships(claims) {
  const covered = new Set(claims.filter(c => c.claimKind === 'membership').map(subjectKey));
  const added = [];
  for (const c of claims) {
    if (c.claimKind === 'membership' || !c.subjectName || !leftSignal(c)) continue;
    const key = subjectKey(c);
    if (covered.has(key)) continue;
    covered.add(key);
    added.push({
      ...c, claimKind: 'membership', attribute: 'former', roleSuggestion: null, relevance: null,
    });
  }
  return [...claims, ...added];
}
