// Context interviews — which role a role claim suggests. Fixed rules, no model.
//
//   suggestionFor(relation)        → 'Accountable' | 'Responsible' | null
//   deduceRoles(claims)            → the claims with roleSuggestion set
//   accountableDoubt(claims, holder) → the claim that puts the current Accountable in doubt, or null
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
