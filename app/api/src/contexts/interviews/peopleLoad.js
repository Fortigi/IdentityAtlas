// Context people — GET /api/contexts/:id/people, the reads (people.js has the rules).
//
//   loadPeople(deps, context, query, statuses) → { data, total, counts, filter, limit, offset, linkedResources }
//
// Set-based, a fixed number of statements whatever the size of the unit:
//   1  every person claim of the context, with its holder      (store.personClaims)
//   2  every claim, the Accountable, and the contradictions    (store.listClaims, currentAccountable,
//      among them — the same rules the claims endpoint uses     contradictions.loadContradictions)
//   1  the holders those claims name and the former-marked     (store.holderRows)
//   1  the context's roles                                     (deps.loadRoles)
//   2  one page of the current members the source lists, and   (deps.loadMembers — the members
//      how many there are                                        endpoint's own read)
//   2  what the people on the page still hold                  (store.entitlementCounts)
//
// The listed current members are the only group read a page at a time: a unit
// can hold 100k of them. Everyone else on the overview — not confirmed, came back
// where the context cannot list people, left, left (decided) — comes from claims
// and decisions, which are few, and is merged in memory.
// `statuses`: the claim statuses the reader may see (a reader without
// data.write.contexts: confirmed only — the route decides).

import * as store from './store.js';
import { loadContradictions } from './contradictions.js';
import { MEMBER_COLUMN } from './memberOverrides.js';
import { decisionOf } from './overrideRows.js';
import {
  parsePeopleQuery, groupClaimsByPerson, buildPerson, holderKey, memoryGroups, matchesSearch,
  pageAcross, FILTER_GROUPS, withEntitlements,
} from './people.js';

// Everyone the claims and decisions are about, each built once (the unit report reads it too).
export function knownPeople({ groups, holders, roles, open, col }) {
  const keys = new Set([...groups.keys(), ...holders.keys()]);
  const known = [];
  for (const key of keys) {
    const member = holders.get(key) ?? null;
    // A holder read only for their decision is not on the overview without claims or the mark.
    if (!groups.has(key) && !decisionOf(member)) continue;
    known.push(buildPerson({ key, member, group: groups.get(key) ?? null, roles, open, canList: !!col }));
  }
  return known;
}

// The current members the source lists: a page of them and their count, or the count alone.
async function listedPage(loadMembers, context, q, wanted) {
  if (!MEMBER_COLUMN[context.targetType]) return { rows: [], total: 0 };
  const limit = wanted ? q.limit : 0;
  return loadMembers(context.id, context.targetType, { limit, offset: q.offset, search: q.search, withTotal: true });
}

function counts(listedTotal, mem, decide) {
  const current = listedTotal + mem.said.length + mem.notConfirmed.length;
  const former = mem.leftDecided.length + mem.left.length;
  return { current, former, all: current + former, decide };
}

// The rows of one page, in order, across the groups the filter shows.
function pageRows({ q, listed, mem, decide, buildListed }) {
  if (q.filter === 'decide') return decide.slice(q.offset, q.offset + q.limit);
  const names = FILTER_GROUPS[q.filter];
  const sizes = names.map(name => ({ name, count: name === 'listed' ? listed.total : mem[name].length }));
  return pageAcross(sizes, q.offset, q.limit).flatMap(part => (part.group === 'listed'
    ? listed.rows.slice(0, part.limit).map(buildListed)
    : mem[part.group].slice(part.offset, part.offset + part.limit)));
}

async function withHoldings(db, contextId, rows, col) {
  const principalIds = [...new Set(rows.map(p => p.principalId).filter(Boolean))];
  const identityIds = [...new Set(rows.filter(p => col === 'identityId' || !p.principalId).map(p => p.identityId).filter(Boolean))];
  const { counts: held, linkedResources } = await store.entitlementCounts(db, contextId, principalIds, identityIds);
  return { data: rows.map(p => withEntitlements(p, col, held, linkedResources)), linkedResources };
}

/**
 * The overview while organisation knowledge is off (featureFlags.js orgKnowledge):
 * the members the source lists, with their roles here and what they hold —
 * nothing from claims or decisions, so nobody is former and nothing is to decide.
 * `deps.loadMembers` must list every member (the route passes the plain read).
 */
export async function loadListedPeople({ db, loadMembers, loadRoles }, context, query) {
  const q = parsePeopleQuery(query);
  const col = MEMBER_COLUMN[context.targetType] ?? null;
  const roles = await loadRoles(context.id);
  const listed = await listedPage(loadMembers, context, q, !!FILTER_GROUPS[q.filter]?.includes('listed'));
  const rows = listed.rows.map(row => buildPerson({
    key: holderKey(col, row.id), member: { ...row, [col]: row.id, listed: true }, group: null, roles, open: [],
  }));
  const { data, linkedResources } = await withHoldings(db, context.id, rows, col);
  const all = { current: listed.total, former: 0, all: listed.total, decide: 0 };
  return { data, total: all[q.filter], counts: all, filter: q.filter, limit: q.limit, offset: q.offset, linkedResources };
}

/**
 * @param {{ db, loadMembers: Function, loadRoles: Function }} deps
 * @param {{ id: string, targetType: string }} context
 * @param {object} query      ?filter, ?search, ?limit, ?offset
 * @param {string[]} statuses the claim statuses the reader may see
 */
export async function loadPeople({ db, loadMembers, loadRoles }, context, query, statuses) {
  const q = parsePeopleQuery(query);
  const col = MEMBER_COLUMN[context.targetType] ?? null;
  const [claimRows, allClaims, accountable, roles] = await Promise.all([
    store.personClaims(db, context.id, context.targetType, statuses),
    store.listClaims(db, context.id, statuses),
    store.currentAccountable(db, context.id),
    loadRoles(context.id),
  ]);
  const open = (await loadContradictions(db, context.id, allClaims, accountable)).filter(c => c.status === 'open');
  const groups = groupClaimsByPerson(claimRows, col);
  const holderIds = [...new Set([...groups.values()].map(g => g.holderId).filter(Boolean))];
  const holders = new Map((await store.holderRows(db, context.id, context.targetType, holderIds)).map(h => [holderKey(col, h.id), h]));

  const known = knownPeople({ groups, holders, roles, open, col }).filter(p => matchesSearch(p, q.search));
  // The listed current members come from the SQL page, not from memory.
  const mem = memoryGroups(known.filter(p => !(col && (p.status === 'current' || p.status === 'cameBack'))));
  const decide = known.filter(p => p.contradictions.length > 0).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const listed = await listedPage(loadMembers, context, q, FILTER_GROUPS[q.filter]?.includes('listed'));
  const buildListed = (row) => buildPerson({
    key: holderKey(col, row.id), member: { ...row, [col]: row.id, listed: true },
    group: groups.get(holderKey(col, row.id)) ?? null, roles, open,
  });
  const rows = pageRows({ q, listed, mem, decide, buildListed });
  const { data, linkedResources } = await withHoldings(db, context.id, rows, col);
  const all = counts(listed.total, mem, decide.length);
  return { data, total: all[q.filter], counts: all, filter: q.filter, limit: q.limit, offset: q.offset, linkedResources };
}
