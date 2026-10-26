// Context interviews — what the sources say about one person at a context: their
// role there, whether they left, and whether they came back. Pure; the People
// overview (people.js, peopleLoad.js) reads the claims and calls these per person.
//
// Read from the person claims (role, roleHistory, membership) in the statuses the
// reader may see — a writer's proposed ones too, a reader's confirmed ones only
// (the route decides). A claim is knowledge: none of this changes ContextMembers,
// whose members come from their source.
//
//   role   the person's latest role at the context: a `role` claim (said in the
//          present) or a roleHistory claim whose period is open or "now" first,
//          then by the end and start of the period, then the newest interview;
//          `history` is every role claim about them, oldest first
//   left   the person's latest claim on whether they are in it — a membership
//          claim, or a role / roleHistory claim that says they left (leftSignal.js:
//          "recently left", "inmiddels uitgestroomd") — newest interview first,
//          when it says they are not in it any more (former, left; a role claim
//          reads former)
//   rejoined  the person left once and is in it again (rejoinOf): a membership
//          'rejoined', words for coming back in a role claim's value, period or
//          its quote's clause about them (leftSignal.js saysReturned), or a present
//          membership said in a later interview than a left one — with the roles
//          of the earlier stint (`earlier`, every role before the latest)
import { normalizeName } from '../../lib/nameMatch.js';
import { leftSignal, returnSignal, saysReturned } from './leftSignal.js';
import { clauseFor } from './sentences.js';

const NOW = /\b(now|nu|current(ly)?|today|still|nog steeds|tegenwoordig)\b/i;
const OPEN_END = '9999-12-31';

const isRoleClaim = (c) => (c.claimKind === 'role' && c.attribute !== 'notOwner') || c.claimKind === 'roleHistory';

// [end, start] of a role claim's period, for ordering: said in the present or
// "now" is open; a start without an end runs on; no dates at all is the past.
function roleSpan(c) {
  if (c.claimKind === 'role' || NOW.test(c.periodText ?? '')) return [OPEN_END, c.periodFrom ?? ''];
  if (c.periodTo) return [c.periodTo, c.periodFrom ?? ''];
  if (c.periodFrom) return ['9999-12-30', c.periodFrom];
  return ['', ''];
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const created = (c) => String(c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt ?? '');

/** Oldest first: by the period's end, its start, the interview date, then when the claim was made. */
export function compareRoles(a, b) {
  const [ae, as] = roleSpan(a);
  const [be, bs] = roleSpan(b);
  return cmp(ae, be) || cmp(as, bs) || cmp(a.interviewedAt ?? '', b.interviewedAt ?? '') || cmp(created(a), created(b));
}

const fact = (c) => ({
  claimId: c.id, interviewId: c.interviewId, value: c.value, status: c.status,
  periodFrom: c.periodFrom ?? null, periodTo: c.periodTo ?? null, periodText: c.periodText ?? null,
  quote: c.quote ?? null, intervieweeName: c.intervieweeName, interviewedAt: c.interviewedAt,
});

/** The latest role and the role history of one person's claims, or null. Pure. */
export function personRole(claims) {
  const roles = claims.filter(isRoleClaim).sort(compareRoles);
  if (roles.length === 0) return null;
  return { ...fact(roles[roles.length - 1]), history: roles.map(fact) };
}

// The newest claim of a list: the newest interview, then the newest claim.
const newest = (list) => list.reduce((best, c) => (cmp(c.interviewedAt ?? '', best.interviewedAt ?? '') || cmp(created(c), created(best))) > 0 ? c : best);

/** The person's latest membership claim (newest interview, then newest claim), or null. Pure. */
export function latestMembership(claims) {
  const list = claims.filter(c => c.claimKind === 'membership');
  if (list.length === 0) return null;
  const latest = newest(list);
  return { ...fact(latest), membershipStatus: latest.attribute };
}

/**
 * The person's latest word on being in it — a membership claim or a role claim
 * that says they left — when it says they are not any more, else null. Pure.
 */
export function leftOf(claims) {
  const list = claims.filter(c => c.claimKind === 'membership' || leftSignal(c));
  if (list.length === 0) return null;
  const latest = newest(list);
  if (!leftSignal(latest)) return null;
  return { ...fact(latest), membershipStatus: latest.claimKind === 'membership' ? latest.attribute : 'former' };
}

// A membership status that says the person is in it.
const PRESENT = new Set(['current', 'joined', 'rejoined']);

// Says the person came back: a membership 'rejoined', a role claim whose value or
// period says so, or a role / present membership claim whose quote says so in the
// clause about them ("begon als junior en is sinds een half jaar terug, nu als
// architect" — the model put the return in neither value nor period).
function saysBack(c) {
  if (returnSignal(c)) return true;
  const about = isRoleClaim(c) || (c.claimKind === 'membership' && PRESENT.has(c.attribute));
  return about && !!c.quote && saysReturned(clauseFor(c.quote, c.subjectName));
}

// A present membership claim from a LATER interview than a claim that said the
// person left, BOTH confirmed: they left and are back. While either is only
// proposed the two interviews disagree — a contradiction (contradictions.js)
// for an analyst to decide ("both true at different times" confirms both).
const isDecidedTrue = (c) => c.status === 'confirmed' || c.status === 'edited';
function backAfterGone(claims) {
  const present = claims.filter(c => c.claimKind === 'membership' && PRESENT.has(c.attribute) && isDecidedTrue(c));
  const gone = claims.filter(c => leftSignal(c) && isDecidedTrue(c));
  if (present.length === 0 || gone.length === 0) return null;
  const latest = newest(present);
  return gone.some(g => cmp(g.interviewedAt ?? '', latest.interviewedAt ?? '') < 0) ? latest : null;
}

/**
 * The earlier stint of a person who is in it again, or null: { ...the claim that
 * says they came back, membershipStatus: 'rejoined', earlier: [the roles before
 * the latest one, oldest first] }. Null for a person whose latest word says they
 * left (that is a Previous members row of its own) and for a role change without
 * a word for coming back (a promotion is not a second stint). Pure.
 */
export function rejoinOf(claims) {
  if (leftOf(claims)) return null;
  const said = claims.filter(saysBack);
  const signal = said.length ? newest(said) : backAfterGone(claims);
  if (!signal) return null;
  const earlier = claims.filter(isRoleClaim).sort(compareRoles).slice(0, -1).filter(r => !leftSignal(r));
  return { ...fact(signal), membershipStatus: 'rejoined', earlier: earlier.map(fact) };
}

/** Who a person claim is about, as one key: the account, the person, else the name as said. */
export function personKey(c) {
  if (c.principalId) return `principalId:${c.principalId}`;
  if (c.identityId) return `identityId:${c.identityId}`;
  return `name:${normalizeName(c.subjectName)}`;
}
