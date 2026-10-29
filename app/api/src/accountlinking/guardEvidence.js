// Identity Atlas — the evidence the name-uniqueness guard weighs beside a name.
//
// A name alone decides nothing beyond "these people could be it". What settles
// an account is whether anything *singles one of them out*, and the guard has
// three such pieces of evidence (#1455):
//
//   nameUnique  the name points at exactly one person — the guard's own reading
//   department  the account's department is one claimant's and no other's
//   manager     the account's manager is one claimant's manager and no other's
//
// Each is **uniqueness-conditioned**: it fires only where it picks exactly one
// of the people the name left to choose between, so context narrows and never
// picks (R2). Two claimants in the same department say nothing about which of
// them the account is, so the match stays held for review rather than going to
// whichever of them happened to score first — which is the whole reason the
// answer to "Surname, Initials" is not a lower threshold.
//
// They carry weight rather than acting as a yes/no gate because the threshold
// is the tenant's bar for *how certain* a link has to be: an unambiguous
// `van Mourik, R.` is 45 (surname + initial) + 10 (nothing else answers to that
// name) = 55, which clears the shipped 50 and reads honestly as a low-confidence
// link an analyst can review — the recorded `linkSignals` name exactly what it
// rests on. They are dictionary entries like any other signal, so a tenant
// reweights or switches one off (weight 0) without a new config knob (R3).
//
// They are not independent evidence: each one says the *name* singled somebody
// out. That is why they count as name-class for `isNameOnly` and why
// re-weighting them alone never detaches a link whose name still points at its
// one person (P7) — see `staleNameOnlyLinks.js`.

/** The dictionary `type` of a guard-evidence signal. */
export const EVIDENCE_TYPE = 'evidence';

/** A context attribute as a comparison token: lower-cased and trimmed, no fuzz. */
const attr = (v) => (v == null ? '' : String(v).trim().toLowerCase());

/**
 * The one claimant a test singles out, or null when it picks none or several.
 * "Several" is the case the guard exists for, so it is deliberately not "the
 * first one".
 */
function singledOutBy(claimants, matches) {
  let found = null;
  for (const c of claimants) {
    if (!matches(c)) continue;
    if (found) return null;
    found = c;
  }
  return found;
}

/**
 * What each shipped piece of evidence singles out, keyed by signal name (the
 * name is the dictionary's stable key — `rulesMerge` merges by it).
 *
 * `department` is compared exactly after lower-casing and trimming. There is
 * deliberately no fuzzy matching: "Finance" and "Finance & Control" are two
 * departments as often as they are one, and a guess here attaches an account to
 * the wrong person rather than leaving it reviewable.
 *
 * `manager` compares the identity the account's own manager resolves to against
 * the claimant's `managerIdentityId`. The account's manager is a *principal*, so
 * it only resolves once that manager's own account is linked — on the first run
 * after an import it usually is not, and the evidence simply does not fire;
 * a later run picks it up. That bootstrap gap is accepted rather than looped
 * over inside one run (see the docs).
 */
const SINGLES_OUT = {
  nameUnique: (_orphan, _claimants, { sole }) => sole ?? null,
  department: (orphan, claimants) => {
    const dept = attr(orphan.department);
    return dept ? singledOutBy(claimants, c => attr(c.department) === dept) : null;
  },
  manager: (orphan, claimants) => {
    const mgr = orphan.managerIdentityId;
    return mgr ? singledOutBy(claimants, c => c.managerIdentityId === mgr) : null;
  },
};

/**
 * The evidence a dictionary has switched on, in its ladder order (which is the
 * order it is weighed in, so the strongest-stated piece picks first). A signal
 * at weight 0 is off, and a name this build does not know how to test is inert
 * rather than an error — a tenant may have invented it.
 *
 * @returns {Array<{name: string, weight: number, singlesOut: Function}>}
 */
export function guardEvidence(rules) {
  return (rules.signals || [])
    .filter(s => s.type === EVIDENCE_TYPE && (s.weight || 0) > 0 && SINGLES_OUT[s.name])
    .map(s => ({ name: s.name, weight: s.weight, singlesOut: SINGLES_OUT[s.name] }));
}

/** The names of every evidence signal the dictionary defines, switched on or not. */
export function evidenceSignalNames(rules) {
  return new Set((rules.signals || []).filter(s => s.type === EVIDENCE_TYPE).map(s => s.name));
}

/**
 * The most the evidence could ever add to one match's confidence.
 *
 * This is what decides whether a below-threshold name-only match is worth
 * putting to the guard at all: a match that cannot clear the tenant's bar even
 * fully corroborated is below it whatever the context says, and is neither
 * linked nor held — exactly as it was before a name-only match reached the guard
 * from below the threshold.
 */
export const corroborationCeiling = (evidence) => evidence.reduce((n, e) => n + e.weight, 0);

/**
 * Weigh the evidence over the people the account's name left to choose between.
 *
 * The first piece that singles somebody out picks them; the rest corroborate
 * only if they agree. Evidence pointing at a *different* claimant is not a
 * second vote — the two pieces disagree about who the account is, so the one
 * that is weaker-stated simply does not count towards the confidence, and a
 * match nothing settles stays held for review.
 *
 * @param {object} orphan the account being placed
 * @param {object[]} contested the claimants that are still in the running
 * @param {object|null} sole the identity the name itself points at, if any
 * @param {Array<{name: string, weight: number, singlesOut: Function}>} evidence
 * @returns {{ identity: object|null, signals: string[], bonus: number }}
 */
export function weighEvidence(orphan, contested, sole, evidence) {
  let picked = sole ?? null;
  const signals = [];
  let bonus = 0;
  for (const ev of evidence) {
    const one = ev.singlesOut(orphan, contested, { sole });
    if (!one) continue;
    if (!picked) picked = one;
    if (one.id !== picked.id) continue;
    signals.push(ev.name);
    bonus += ev.weight;
  }
  return { identity: picked, signals, bonus };
}
