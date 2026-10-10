// Organisation truth — one person, several records: an identity and its
// accounts count as the same person when an activity names one of them and a
// list names another (Ann's timesheet rows resolve to her identity, the customer
// list names her account as owner).
//
//   loadFamily(refs)              → family index over the IdentityMembers rows of those refs
//   familyIndex(rows)             → (targetType, targetId) => Set of keys 'Type:id'
//   membershipIndex(links, family)→ (targetType, targetId) => roles (sorted, distinct)
//
// family('Principal', p) = p, the identities p belongs to, and their other accounts
// family('Identity', i)  = i and its accounts
// family(anything else)  = itself only
//
// loadFamily reads the IdentityMembers rows touching any of the given ids, so
// two accounts of one identity are siblings only when at least one of them (or
// the identity) is among the refs — pass every principal/identity you compare.
import { query } from '../../db/connection.js';

export const keyOf = (targetType, targetId) => `${targetType}:${targetId}`;
const PERSON_TYPES = new Set(['Principal', 'Identity']);

export function familyIndex(rows) {
  const identitiesOf = new Map();
  const accountsOf = new Map();
  const add = (map, k, v) => { const s = map.get(k) ?? new Set(); s.add(v); map.set(k, s); };
  for (const r of rows) {
    add(identitiesOf, r.principalId, r.identityId);
    add(accountsOf, r.identityId, r.principalId);
  }
  const accountsAsKeys = (identityId, out) => {
    for (const p of accountsOf.get(identityId) ?? []) out.add(keyOf('Principal', p));
  };
  return (targetType, targetId) => {
    const out = new Set([keyOf(targetType, targetId)]);
    if (targetType === 'Identity') accountsAsKeys(targetId, out);
    if (targetType === 'Principal') {
      for (const i of identitiesOf.get(targetId) ?? []) {
        out.add(keyOf('Identity', i));
        accountsAsKeys(i, out);
      }
    }
    return out;
  };
}

/** @param {{targetType: string, targetId: string}[]} refs */
export async function loadFamily(refs) {
  const ids = [...new Set(refs.filter(r => PERSON_TYPES.has(r.targetType) && r.targetId).map(r => r.targetId))];
  if (ids.length === 0) return familyIndex([]);
  const r = await query(
    `SELECT "principalId", "identityId" FROM "IdentityMembers" WHERE "principalId" = ANY($1::uuid[]) OR "identityId" = ANY($1::uuid[])`,
    [ids],
  );
  return familyIndex(r.rows);
}

/**
 * Which roles (link vias) a person holds through `links`, counting a link to
 * any record of the same person.
 * @param {{ via: string, targetType: string, targetId: string }[]} links
 */
export function membershipIndex(links, family) {
  const rolesByKey = new Map();
  for (const l of links) {
    for (const k of family(l.targetType, l.targetId)) {
      const roles = rolesByKey.get(k) ?? new Set();
      roles.add(l.via);
      rolesByKey.set(k, roles);
    }
  }
  return (targetType, targetId) => {
    const roles = new Set();
    for (const k of family(targetType, targetId)) for (const role of rolesByKey.get(k) ?? []) roles.add(role);
    return [...roles].sort();
  };
}
