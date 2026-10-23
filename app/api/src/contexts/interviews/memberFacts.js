// Context interviews — what the interviews say about the people in a context's
// members lists: their role there, and whether they left.
//
//   withInterviewMemberFacts(db, contextId, targetType, rows, statuses)
//       → the page's member rows, each with `interview: { role, left }`
//   loadPreviousMembers(db, contextId, statuses)
//       → { data: [previous member], linkedResources }
//
// Read from the person claims (role, roleHistory, membership) in `statuses` —
// a writer's proposed ones too, a reader's confirmed ones only (the route
// decides). Set-based: one statement per page of members (store.memberClaims),
// one for the previous members plus two for their entitlements — never a query
// per row. A claim is knowledge: none of this changes ContextMembers, whose
// members come from their source.
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
//
// A previous member is a person whose latest such claim says they left and who
// is not a direct member now (a current member who left is flagged in the
// members list instead). Matched to an account or a person, they come with the
// live entitlements they still hold — "does this person still have access?" —
// and how many of those are on the resources this context is linked to (its
// own resource members, or those of a resources variant). Unmatched, with the
// name as said and no counts. A person who came back is listed too, for the
// EARLIER stint (stint 'earlier'): "Junior developer (earlier period)", beside
// their current row.

import { normalizeName } from '../../lib/nameMatch.js';
import * as store from './store.js';
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

function groupBy(rows, keyOf) {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/** Map(memberId → { role, left, rejoined }) over the claims about a page of members. Pure. */
export function factsByMember(claimRows) {
  const out = new Map();
  for (const [id, claims] of groupBy(claimRows, r => r.memberId)) {
    out.set(id, { role: personRole(claims), left: leftOf(claims), rejoined: rejoinOf(claims) });
  }
  return out;
}

export async function withInterviewMemberFacts(db, contextId, targetType, rows, statuses) {
  if (rows.length === 0 || !store.MEMBER_CLAIMS_SQL[targetType]) return rows;
  const facts = factsByMember(await store.memberClaims(db, contextId, targetType, [...new Set(rows.map(r => r.id))], statuses));
  return rows.map(r => ({ ...r, interview: facts.get(r.id) ?? { role: null, left: null, rejoined: null } }));
}

/** Who a person claim is about, as one key: the account, the person, else the name as said. */
export function personKey(c) {
  if (c.principalId) return `principalId:${c.principalId}`;
  if (c.identityId) return `identityId:${c.identityId}`;
  return `name:${normalizeName(c.subjectName)}`;
}

// One previous member's row: who, and the stint it is about.
function stintRow(key, claims, stint) {
  const first = claims[0];
  return {
    key,
    principalId: first.principalId ?? null,
    identityId: first.identityId ?? null,
    displayName: first.subjectDisplayName || first.subjectName || '',
    subjectName: first.subjectName ?? null,
    accountDeleted: !!first.accountDeleted,
    nowMember: claims.some(c => c.isMember),
    ...stint,
  };
}

// The earlier stint's role: its latest role, with the earlier roles as history.
const earlierRole = (back) => (back.earlier.length ? { ...back.earlier[back.earlier.length - 1], history: back.earlier } : null);

/**
 * The previous members among a context's person claims, by name. Pure. Two kinds
 * of row (`stint`):
 *   left     the latest word says they left, and they are not a direct member now
 *   earlier  they left once and came back (rejoinOf): the row is their EARLIER
 *            stint — role = the roles they had then — beside their current row in
 *            the members list (nowMember says whether they are a member now)
 * A person is one row at most; nobody is listed for a role change alone.
 */
export function previousMembersOf(claimRows) {
  const out = [];
  for (const [key, claims] of groupBy(claimRows, personKey)) {
    const left = leftOf(claims);
    if (left) {
      if (!claims.some(c => c.isMember)) out.push(stintRow(key, claims, { stint: 'left', left, role: personRole(claims), rejoined: null }));
      continue;
    }
    const back = rejoinOf(claims);
    if (back) out.push(stintRow(key, claims, { stint: 'earlier', left: null, role: earlierRole(back), rejoined: back }));
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function loadPreviousMembers(db, contextId, statuses) {
  const people = previousMembersOf(await store.peopleClaims(db, contextId, statuses));
  const principalIds = people.filter(p => p.principalId).map(p => p.principalId);
  const identityIds = people.filter(p => !p.principalId && p.identityId).map(p => p.identityId);
  const { counts, linkedResources } = await store.entitlementCounts(db, contextId, principalIds, identityIds);
  const data = people.map(p => {
    const matched = p.principalId || p.identityId;
    const c = matched ? counts.get(p.key) ?? { liveEntitlements: 0, linkedEntitlements: 0 } : null;
    return { ...p, liveEntitlements: c?.liveEntitlements ?? null, linkedEntitlements: linkedResources > 0 ? c?.linkedEntitlements ?? null : null };
  });
  return { data, linkedResources };
}
