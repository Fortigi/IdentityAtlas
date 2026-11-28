// How sure the role-mining step is about a suggestion to improve a business
// role, and which suggestions are sure enough to show. Pure: no database here
// (the data comes from lib/roleImprovements.js).
//
// The measure is the overlap between two sets of people: those who hold the
// role, and those a suggestion is about (who hold a permission, or whom a rule
// would pick). Overlap ÷ everyone in either set: 1 is an exact match, and every
// person too many or too few lowers it. Only 95% and higher is shown, so a
// suggestion is never a guess.

export const MIN_CONFIDENCE = 0.95;
// An exact match among a handful of people is a coincidence as often as not.
export const MIN_HOLDERS = 5;
// A permission that almost matches is suggested only when it is new: an old one
// that almost matches was most likely left out on purpose.
export const RECENT_DAYS = 90;
export const MAX_PERMISSIONS = 5;

// The account attributes a rule can be built from, as an automatic assignment
// policy can filter on them.
export const RULE_ATTRIBUTES = Object.freeze(['department', 'jobTitle', 'companyName']);

/** overlap ÷ (everyone in either set): 1 is exact. 0 when both sets are empty. */
export function matchScore({ both, onlyRole, onlyOther }) {
  const all = both + onlyRole + onlyOther;
  return all === 0 ? 0 : both / all;
}

/** A score as the whole percentage shown, never rounded up into the threshold. */
export const confidencePct = (score) => Math.floor(score * 100 + 1e-9);

const isRecent = (createdDateTime, since) => {
  const t = Date.parse(createdDateTime ?? '');
  return Number.isFinite(t) && t >= since.getTime();
};

/**
 * The permissions worth adding, best first. A candidate row: { id, displayName,
 * resourceType, createdDateTime, membersHolding, othersHolding }, where
 * membersHolding counts holders of the role who hold it themselves and
 * othersHolding everyone else who holds it in any way. Exact matches always
 * qualify; a near one only when the permission appeared since `since`.
 */
export function permissionSuggestions(candidates, { holderCount, since }) {
  if (holderCount < MIN_HOLDERS) return [];
  const out = [];
  for (const c of candidates) {
    const counts = { both: c.membersHolding, onlyRole: holderCount - c.membersHolding, onlyOther: c.othersHolding };
    const score = matchScore(counts);
    const exact = score === 1;
    const recent = isRecent(c.createdDateTime, since);
    if (score < MIN_CONFIDENCE || (!exact && !recent)) continue;
    out.push({
      key: `permission:${String(c.id).toLowerCase()}`,
      kind: 'addPermission',
      confidence: confidencePct(score),
      exact,
      resource: { id: c.id, displayName: c.displayName ?? null, resourceType: c.resourceType ?? null, createdDateTime: c.createdDateTime ?? null },
      recent,
      holders: holderCount,
      holdersWithIt: c.membersHolding,
      othersWithIt: c.othersHolding,
    });
  }
  return out
    .sort((a, b) => b.confidence - a.confidence || b.holdersWithIt - a.holdersWithIt || String(a.resource.displayName).localeCompare(String(b.resource.displayName)))
    .slice(0, MAX_PERMISSIONS);
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Per attribute the one value nearly every holder shares (at least
 * MIN_CONFIDENCE of them), as a condition { attribute, value }. A rule can only
 * match the holders well if each of its conditions does.
 */
export function sharedConditions(holders) {
  const out = [];
  for (const attribute of RULE_ATTRIBUTES) {
    const counts = new Map();
    for (const h of holders) {
      const v = clean(h[attribute]);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const [value, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    if (value && n / holders.length >= MIN_CONFIDENCE) out.push({ attribute, value });
  }
  return out;
}

/** Every combination of at least one of the conditions, fewest first. */
export function conditionSets(conditions) {
  const sets = [];
  for (let mask = 1; mask < 1 << conditions.length; mask++) {
    sets.push(conditions.filter((_, i) => mask & (1 << i)));
  }
  return sets.sort((a, b) => a.length - b.length);
}

const matches = (person, set) => set.every(c => clean(person[c.attribute]) === c.value);

/**
 * The one rule that would hand the role to the right people, or null. `holders`
 * are the role's user accounts, `population` every account a rule could pick
 * (each with an id and the RULE_ATTRIBUTES). The best score wins; on a tie the
 * rule with fewer conditions.
 */
export function ruleSuggestion(holders, population) {
  if (holders.length < MIN_HOLDERS) return null;
  const conditions = sharedConditions(holders);
  if (conditions.length === 0) return null;
  const isHolder = new Set(holders.map(h => String(h.id).toLowerCase()));
  let best = null;
  for (const set of conditionSets(conditions)) {
    const both = holders.filter(h => matches(h, set)).length;
    const onlyOther = population.filter(p => !isHolder.has(String(p.id).toLowerCase()) && matches(p, set)).length;
    const score = matchScore({ both, onlyRole: holders.length - both, onlyOther });
    if (score >= MIN_CONFIDENCE && (!best || score > best.score)) best = { set, both, onlyOther, score };
  }
  if (!best) return null;
  return {
    key: `rule:${best.set.map(c => `${c.attribute}=${c.value}`).join('&')}`,
    kind: 'automaticRule',
    confidence: confidencePct(best.score),
    exact: best.score === 1,
    conditions: best.set,
    holders: holders.length,
    holdersMatched: best.both,
    othersMatched: best.onlyOther,
  };
}

/**
 * Leaves out what the last review declined, so a recurring review does not ask
 * the same thing again. Returns { suggestions, declinedBefore }.
 */
export function withoutDeclined(suggestions, declinedKeys) {
  const declined = new Set(declinedKeys);
  const kept = suggestions.filter(s => !declined.has(s.key));
  return { suggestions: kept, declinedBefore: suggestions.length - kept.length };
}
