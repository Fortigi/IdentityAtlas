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
//   left   the person's latest membership claim (newest interview first) when it
//          says they are not in it any more (former, left)
//
// A previous member is a person whose latest membership claim says so and who
// is not a direct member now (a current member who left is flagged in the
// members list instead). Matched to an account or a person, they come with the
// live entitlements they still hold — "does this person still have access?" —
// and how many of those are on the resources this context is linked to (its
// own resource members, or those of a resources variant). Unmatched, with the
// name as said and no counts.

import { normalizeName } from '../../lib/nameMatch.js';
import * as store from './store.js';

const GONE = new Set(['former', 'left']);
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

/** The person's latest membership claim (newest interview, then newest claim), or null. Pure. */
export function latestMembership(claims) {
  const list = claims.filter(c => c.claimKind === 'membership');
  if (list.length === 0) return null;
  const latest = list.reduce((best, c) => (cmp(c.interviewedAt ?? '', best.interviewedAt ?? '') || cmp(created(c), created(best))) > 0 ? c : best);
  return { ...fact(latest), membershipStatus: latest.attribute };
}

/** The latest membership claim when it says the person is not in it any more, else null. Pure. */
export function leftOf(claims) {
  const m = latestMembership(claims);
  return m && GONE.has(m.membershipStatus) ? m : null;
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

/** Map(memberId → { role, left }) over the claims about a page of members. Pure. */
export function factsByMember(claimRows) {
  const out = new Map();
  for (const [id, claims] of groupBy(claimRows, r => r.memberId)) out.set(id, { role: personRole(claims), left: leftOf(claims) });
  return out;
}

export async function withInterviewMemberFacts(db, contextId, targetType, rows, statuses) {
  if (rows.length === 0 || !store.MEMBER_CLAIMS_SQL[targetType]) return rows;
  const facts = factsByMember(await store.memberClaims(db, contextId, targetType, [...new Set(rows.map(r => r.id))], statuses));
  return rows.map(r => ({ ...r, interview: facts.get(r.id) ?? { role: null, left: null } }));
}

/** Who a person claim is about, as one key: the account, the person, else the name as said. */
export function personKey(c) {
  if (c.principalId) return `principalId:${c.principalId}`;
  if (c.identityId) return `identityId:${c.identityId}`;
  return `name:${normalizeName(c.subjectName)}`;
}

/** The previous members among a context's person claims, by name. Pure. */
export function previousMembersOf(claimRows) {
  const out = [];
  for (const [key, claims] of groupBy(claimRows, personKey)) {
    const left = leftOf(claims);
    if (!left || claims.some(c => c.isMember)) continue;
    const first = claims[0];
    out.push({
      key,
      principalId: first.principalId ?? null,
      identityId: first.identityId ?? null,
      displayName: first.subjectDisplayName || first.subjectName || '',
      subjectName: first.subjectName ?? null,
      accountDeleted: !!first.accountDeleted,
      left,
      role: personRole(claims),
    });
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
