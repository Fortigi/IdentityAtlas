// Context people — one row per person for a unit's (or an application's) page:
// the members its source lists, merged with what the sources added to the page
// say about people (role, roleHistory and membership claims). Pure; the reads are
// peopleLoad.js. Design: docs/architecture/context-interviews.md → "People overview".
//
//   parsePeopleQuery(query)                 → { filter, search, limit, offset }
//   groupClaimsByPerson(claimRows)          → Map(key → { key, holderId, claims, … })
//   personStatus({ listed, overridden, claims, canList })  → one of STATUSES
//   buildPerson(parts)                      → the row the API returns
//   pageAcross(groups, offset, limit)       → which slice of which group a page takes
//
// A person is keyed by their holder in the context's own kind of member — the
// account for a unit of accounts, the person for a unit of people — so a member
// row and the claims about them are one row; a claim that names nobody we hold is
// keyed by the name as said. One status vocabulary:
//
//   current       the source lists them (and no decision says otherwise)
//   cameBack      the source lists them and a source says they left once and came back
//   notConfirmed  a source says they are in it, but the member list does not list them
//   leftDecided   the source still lists them, but a decision marked them former
//   left          a source says they left, and the list does not list them (any more)
//
// Current, came back and not confirmed are the Current filter; left (decided) and
// left the Former filter. A context whose members are not people (an application:
// its members are resources) cannot list a person, so what a source says decides.

import { normalizeName } from '../../lib/nameMatch.js';
import { personRole, leftOf, rejoinOf, personKey } from './memberFacts.js';
import { decisionOf } from './overrideRows.js';

export const STATUSES = Object.freeze(['current', 'cameBack', 'notConfirmed', 'leftDecided', 'left']);
export const FORMER = new Set(['leftDecided', 'left']);
export const FILTERS = Object.freeze(['current', 'former', 'all', 'decide']);
export const PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

const intOr = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
};

/** ?filter=current|former|all|decide&search=&limit=&offset= → validated, with defaults. Pure. */
export function parsePeopleQuery(query = {}) {
  const filter = FILTERS.includes(query.filter) ? query.filter : 'current';
  const search = String(query.search ?? '').trim().slice(0, 200);
  const limit = Math.min(Math.max(intOr(query.limit, PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const offset = Math.max(intOr(query.offset, 0), 0);
  return { filter, search, limit, offset };
}

/** The key of a person: the holder in the context's kind of member, else who the claim names. Pure. */
export function holderKey(col, id) {
  return `${col}:${id}`;
}

/**
 * The person claims grouped per person: Map(key → { key, holderId, principalId,
 * identityId, displayName, accountDeleted, claims }). `col` is the holder column
 * of the context's kind of member ('principalId' / 'identityId'), or null when
 * its members are not people. Pure.
 */
export function groupClaimsByPerson(claimRows, col) {
  const out = new Map();
  for (const c of claimRows) {
    const holderId = col ? c.holderId ?? null : null;
    const key = holderId ? holderKey(col, holderId) : personKey(c);
    if (!out.has(key)) {
      out.set(key, {
        key, holderId,
        principalId: c.principalId ?? null,
        identityId: c.identityId ?? null,
        displayName: c.subjectDisplayName || c.subjectName || '',
        accountDeleted: !!c.accountDeleted,
        claims: [],
      });
    }
    out.get(key).claims.push(c);
  }
  return out;
}

/** Where a person stands, in the one vocabulary (STATUSES). Pure. */
export function personStatus({ listed = false, overridden = false, claims = [], canList = true }) {
  if (listed) {
    if (overridden) return 'leftDecided';
    return rejoinOf(claims) ? 'cameBack' : 'current';
  }
  // Decided former, and the source no longer lists them: the correction landed.
  if (overridden || leftOf(claims)) return 'left';
  if (!canList) return rejoinOf(claims) ? 'cameBack' : 'current';
  return 'notConfirmed';
}

// One claim as a person row carries it: what the popover shows and the review needs.
export function claimFact(c) {
  return {
    id: c.id, interviewId: c.interviewId, claimKind: c.claimKind, attribute: c.attribute ?? null,
    value: c.value, status: c.status, quote: c.quote ?? null,
    periodFrom: c.periodFrom ?? null, periodTo: c.periodTo ?? null, periodText: c.periodText ?? null,
    subjectName: c.subjectName ?? null, subjectDisplayName: c.subjectDisplayName ?? null,
    principalId: c.principalId ?? null, identityId: c.identityId ?? null, roleSuggestion: c.roleSuggestion ?? null,
    intervieweeName: c.intervieweeName, interviewedAt: c.interviewedAt, fileName: c.fileName ?? null,
    sourceKind: c.sourceKind ?? 'interview',
  };
}

// Which sources say something about the person: the member list when it lists
// them, then each kind of added source, in a fixed order.
const SOURCE_ORDER = ['list', 'interview', 'file', 'text'];
export function sourcesOf(listed, claims) {
  const kinds = new Set(claims.map(c => c.sourceKind ?? 'interview'));
  if (listed) kinds.add('list');
  return SOURCE_ORDER.filter(k => kinds.has(k));
}

// The roles the person holds here (ContextRoles), by either of their ids.
function rolesOf(roles, ids) {
  const held = roles.filter(r => (r.principalId && ids.has(r.principalId)) || (r.identityId && ids.has(r.identityId)));
  return [...new Set(held.map(r => r.role))];
}

// The open contradictions any of the person's claims is in.
function contradictionsOf(open, claims) {
  const ids = new Set(claims.map(c => c.id));
  return open.filter(con => con.claimIds.some(id => ids.has(id))).map(con => con.id);
}

// The row's own fields, from the member row (or the holder read) when there is one.
const MEMBER_FIELDS = ['email', 'jobTitle', 'department', 'principalType', 'accountEnabled'];
function identity(member, group) {
  const m = member ?? {};
  const g = group ?? {};
  return {
    principalId: m.principalId ?? g.principalId ?? null,
    identityId: m.identityId ?? g.identityId ?? null,
    displayName: m.displayName || g.displayName || '',
    ...Object.fromEntries(MEMBER_FIELDS.map(k => [k, m[k] ?? null])),
    accountDeleted: !!(m.accountDeleted || g.accountDeleted),
  };
}

/**
 * The row of one person. `member`: the holder's own row ({ principalId |
 * identityId, displayName, … , listed, override columns }) or null; `group`: their
 * claims (groupClaimsByPerson) or null; `roles`: the context's roles; `counts`:
 * Map(key → { liveEntitlements, linkedEntitlements }); `open`: the open
 * contradictions; `canList`: the context's members are people. Pure.
 */
export function buildPerson({ key, member = null, group = null, roles = [], open = [], canList = true }) {
  const claims = group?.claims ?? [];
  const listed = !!member?.listed;
  const decision = decisionOf(member);
  const status = personStatus({ listed, overridden: !!decision, claims, canList });
  const who = identity(member, group);
  return {
    key, status, former: FORMER.has(status), ...who,
    roles: rolesOf(roles, new Set([who.principalId, who.identityId].filter(Boolean))),
    role: personRole(claims),
    rejoined: status === 'cameBack' ? rejoinOf(claims) : null,
    left: leftOf(claims),
    decision, stillListed: listed && !!decision,
    sources: sourcesOf(listed, claims),
    claims: claims.map(claimFact),
    contradictions: contradictionsOf(open, claims),
    liveEntitlements: null,
    linkedEntitlements: null,
  };
}

/**
 * The key the entitlement counts are read under (store.entitlementCounts): the
 * holder in the context's kind of member, else whichever id the person has;
 * null for a name nobody matched. Pure.
 */
export function entitlementKey(person, col) {
  if (col && person[col]) return holderKey(col, person[col]);
  if (person.principalId) return holderKey('principalId', person.principalId);
  if (person.identityId) return holderKey('identityId', person.identityId);
  return null;
}

/** The person with what they still hold: live entitlements, and how many on this context's resources. Pure. */
export function withEntitlements(person, col, counts, linkedResources) {
  const key = entitlementKey(person, col);
  if (!key) return person;
  const c = counts.get(key);
  return {
    ...person,
    liveEntitlements: c?.liveEntitlements ?? 0,
    linkedEntitlements: linkedResources > 0 ? c?.linkedEntitlements ?? 0 : null,
  };
}

const byName = (a, b) => String(a.displayName).localeCompare(String(b.displayName)) || a.key.localeCompare(b.key);

/** Does the person's name match the search (as the members search does: a part of the name, any case)? Pure. */
export function matchesSearch(person, search) {
  if (!search) return true;
  return normalizeName(person.displayName).includes(normalizeName(search));
}

/** The people in memory sorted by name and split by status. Pure. */
export function splitByStatus(people) {
  const out = Object.fromEntries(STATUSES.map(s => [s, []]));
  for (const p of [...people].sort(byName)) out[p.status].push(p);
  return out;
}

/**
 * A page across groups shown one after the other: [{ group, offset, limit }] for
 * each group the page takes rows from. `groups`: [{ name, count }]. Pure.
 */
export function pageAcross(groups, offset, limit) {
  const out = [];
  let skip = offset;
  let left = limit;
  for (const g of groups) {
    if (left <= 0) break;
    if (skip >= g.count) { skip -= g.count; continue; }
    const take = Math.min(g.count - skip, left);
    out.push({ group: g.name, offset: skip, limit: take });
    left -= take;
    skip = 0;
  }
  return out;
}

/**
 * The groups each filter shows, in order: the current members the source lists
 * (read a page at a time in SQL), the people a source says are in it where the
 * context cannot list people (`said`), the not confirmed, then the former.
 */
export const FILTER_GROUPS = Object.freeze({
  current: ['listed', 'said', 'notConfirmed'],
  former: ['leftDecided', 'left'],
  all: ['listed', 'said', 'notConfirmed', 'leftDecided', 'left'],
});

/** The people held in memory (not the listed current members), as the groups FILTER_GROUPS names. Pure. */
export function memoryGroups(people) {
  const s = splitByStatus(people);
  return { said: [...s.current, ...s.cameBack].sort(byName), notConfirmed: s.notConfirmed, leftDecided: s.leftDecided, left: s.left };
}
