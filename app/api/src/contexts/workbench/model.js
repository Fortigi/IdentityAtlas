// Authorization workbench — the pure assembly of what load.js reads.
// Design: docs/architecture/m1-discovery-and-design.md.
//
//   buildPeople(members, links, identities, accounts, principals) → people[]
//   buildCells(people, accessRows, viaRoleRows)                     → { cells, holders }
//   buildColumns(resources, holders, roleParts, max)                → { columns, truncated }
//   buildKnowledge(people, claimRows)                               → per person, one link per (kind, object)
//   linkState(claims)                                               → confirmed | proposed | disputed | rejected
//
// A row is a PERSON: an Identity and every account linked to it, or an account
// nobody linked yet (its own row — one person ≠ one account is never assumed).
// A cell is (person, resource), the best grant type over all their accounts —
// Direct over Indirect over Eligible — so nested and multi-account access is
// counted once. Which business roles explain a cell is kept (viaRoles), never
// merged into the grant type.

import { objectKey } from '../../lib/orgKnowledge.js';

const TYPE_RANK = { Direct: 3, Indirect: 2, Eligible: 1 };
const rank = (t) => TYPE_RANK[t] ?? 0;

/** The better of two grant types (Direct > Indirect > Eligible > anything else). Pure. */
export const betterType = (a, b) => (rank(b) > rank(a) ? b : a);

export const personKey = (identityId, principalId) => (identityId ? `i:${identityId}` : `p:${principalId}`);

/**
 * The people of the unit, one per Identity (or per unlinked account).
 * members:     [{ memberType: 'Identity'|'Principal', memberId, direct, unitName }]
 * links:       [{ principalId, identityId }]  — IdentityMembers for the member accounts
 * identities:  [{ id, displayName, email, jobTitle, department }]
 * accounts:    [{ identityId, id, displayName, email, principalType, systemName, jobTitle }]  — every account of those identities
 * principals:  [{ id, displayName, email, principalType, systemName, jobTitle }]  — member accounts without an identity
 */
export function buildPeople({ members, links, identities, accounts, principals }) {
  const identityOf = new Map(links.map(l => [l.principalId, l.identityId]));
  const byKey = new Map();
  const touch = (key, base) => {
    if (!byKey.has(key)) byKey.set(key, { ...base, direct: false, units: new Set() });
    return byKey.get(key);
  };
  const identityRow = new Map(identities.map(i => [i.id, i]));
  const principalRow = new Map(principals.map(p => [p.id, p]));
  for (const m of members) {
    const identityId = m.memberType === 'Identity' ? m.memberId : identityOf.get(m.memberId) ?? null;
    const principalId = identityId ? null : m.memberId;
    const key = personKey(identityId, principalId);
    const row = touch(key, { key, identityId, principalId });
    row.direct = row.direct || !!m.direct;
    if (m.unitName) row.units.add(m.unitName);
  }
  const accountsOf = new Map();
  for (const a of accounts) {
    if (!accountsOf.has(a.identityId)) accountsOf.set(a.identityId, []);
    accountsOf.get(a.identityId).push(account(a));
  }
  const people = [];
  for (const p of byKey.values()) {
    const src = p.identityId ? identityRow.get(p.identityId) : principalRow.get(p.principalId);
    if (!src) continue;
    const accs = p.identityId ? (accountsOf.get(p.identityId) ?? []) : [account(src)];
    people.push({
      key: p.key, identityId: p.identityId, principalId: p.principalId,
      displayName: src.displayName || accs[0]?.displayName || '(no name)',
      email: src.email ?? accs.find(a => a.email)?.email ?? null,
      jobTitle: src.jobTitle ?? accs.find(a => a.jobTitle)?.jobTitle ?? null,
      direct: p.direct, units: [...p.units].sort(), accounts: accs,
    });
  }
  return people.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

const account = (a) => ({
  id: a.id, displayName: a.displayName ?? null, email: a.email ?? null, principalType: a.principalType ?? null,
  systemName: a.systemName ?? null, jobTitle: a.jobTitle ?? null,
});

/** The principal ids of every account of these people. Pure. */
export const accountIds = (people) => [...new Set(people.flatMap(p => p.accounts.map(a => a.id)))];

/**
 * One cell per (person, resource): the best grant type over the person's
 * accounts, the accounts that hold it, and the business roles that explain it.
 * holders: resourceId → number of people. Pure.
 */
export function buildCells(people, accessRows, viaRoleRows = []) {
  const personOf = new Map();
  for (const p of people) for (const a of p.accounts) personOf.set(a.id, p.key);
  const cells = new Map();
  const cellOf = (pk, rid) => {
    const k = `${pk}|${rid}`;
    if (!cells.has(k)) cells.set(k, { person: pk, resourceId: rid, type: null, accounts: new Set(), viaRoles: new Set(), managed: false });
    return cells.get(k);
  };
  for (const r of accessRows) {
    const pk = personOf.get(r.principalId);
    if (!pk) continue;
    const c = cellOf(pk, r.resourceId);
    c.type = c.type ? betterType(c.type, r.membershipType) : r.membershipType;
    c.accounts.add(r.principalId);
    c.managed = c.managed || !!r.managedByAccessPackage;
  }
  for (const v of viaRoleRows) {
    const pk = personOf.get(v.userId);
    const c = pk && cells.get(`${pk}|${v.resourceId}`);
    if (c && v.businessRoleId !== v.resourceId) c.viaRoles.add(v.businessRoleId);
  }
  const holders = new Map();
  const out = [];
  for (const c of cells.values()) {
    holders.set(c.resourceId, (holders.get(c.resourceId) ?? 0) + 1);
    out.push({ ...c, accounts: [...c.accounts], viaRoles: [...c.viaRoles] });
  }
  return { cells: out, holders };
}

/**
 * The columns: every resource someone in the unit holds, most-held first
 * (business roles before the rest at equal count), at most `max`. A business
 * role carries its composition (`contains`: the resource ids it Contains). Pure.
 */
export function buildColumns(resources, holders, roleParts = [], max = 300) {
  const contains = new Map();
  for (const r of roleParts) {
    if (!contains.has(r.roleId)) contains.set(r.roleId, []);
    contains.get(r.roleId).push(r.resourceId);
  }
  const all = resources
    .filter(r => holders.has(r.id))
    .map(r => ({
      id: r.id, displayName: r.displayName || r.id, resourceType: r.resourceType ?? null,
      systemName: r.systemName ?? null, isRole: !!r.governanceResource || r.resourceType === 'BusinessRole',
      holders: holders.get(r.id), contains: contains.get(r.id) ?? [],
    }))
    .sort((a, b) => b.holders - a.holders || Number(b.isRole) - Number(a.isRole) || a.displayName.localeCompare(b.displayName));
  return { columns: all.slice(0, max), truncated: Math.max(0, all.length - max) };
}

const DECIDED = new Set(['confirmed', 'edited']);

/**
 * What the claims about one (person, kind, object) say together:
 *   confirmed  someone confirmed it, nobody rejected it
 *   disputed   one claim confirmed or proposed, another rejected — sources disagree
 *   proposed   only proposed: said, not yet checked
 *   rejected   only rejected
 * Pure.
 */
export function linkState(claims) {
  const rejected = claims.some(c => c.status === 'rejected');
  const decided = claims.some(c => DECIDED.has(c.status));
  const proposed = claims.some(c => c.status === 'proposed');
  if (rejected && (decided || proposed)) return 'disputed';
  if (decided) return 'confirmed';
  if (proposed) return 'proposed';
  return 'rejected';
}

// One link per name: a proposed claim and a confirmed one that named its object
// (the same name, case and spacing aside) are one link.
const objectKeyOf = (c) => objectKey(c.objectName || c.value);

/**
 * The knowledge links of each person: Map personKey → [{ kind, objectId, name, state, claims }].
 * A claim about an account counts for the person whose account it is. Pure.
 */
export function buildKnowledge(people, claimRows) {
  const personOf = new Map();
  for (const p of people) {
    if (p.identityId) personOf.set(`i:${p.identityId}`, p.key);
    for (const a of p.accounts) personOf.set(`p:${a.id}`, p.key);
  }
  const groups = new Map();
  for (const c of claimRows) {
    const pk = (c.identityId && personOf.get(`i:${c.identityId}`)) || (c.principalId && personOf.get(`p:${c.principalId}`));
    if (!pk) continue;
    const k = `${pk}|${c.claimKind}|${objectKeyOf(c)}`;
    if (!groups.has(k)) groups.set(k, { person: pk, kind: c.claimKind, objectId: c.objectContextId ?? null, name: c.objectName || c.value, claims: [] });
    const g = groups.get(k);
    if (!g.objectId && c.objectContextId) { g.objectId = c.objectContextId; g.name = c.objectName || g.name; }
    g.claims.push(evidence(c));
  }
  const out = new Map();
  for (const g of groups.values()) {
    const link = { kind: g.kind, objectId: g.objectId, name: g.name, state: linkState(g.claims), claims: g.claims };
    if (!out.has(g.person)) out.set(g.person, []);
    out.get(g.person).push(link);
  }
  return out;
}

const evidence = (c) => ({
  id: c.id, status: c.status, value: c.value, quote: c.quote ?? null, proposedBy: c.proposedBy,
  decidedBy: c.decidedBy ?? null, decidedAt: c.decidedAt ?? null, contextId: c.contextId, contextName: c.contextName ?? null,
  source: { kind: c.sourceKind, name: c.intervieweeName, fileName: c.fileName, date: c.interviewedAt },
});
