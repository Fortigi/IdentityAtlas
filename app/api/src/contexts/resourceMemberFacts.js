// What the context page's member list shows about a RESOURCE member besides its
// own columns: how many people hold it, who owns it, and which business roles
// contain it.
//
// One page of members at a time (at most 500 ids), three set-based reads for the
// whole page, never one per row:
//   - holders: distinct holders per resource from live ResourceAssignments over
//     the page's id array — the index on "resourceId" serves it, so the 40M-row
//     table is only touched for those resources. Nothing stores a per-resource
//     count (migration 083's counts are per context), so it is computed here.
//     A holder is the principal, or the identity where a source links one —
//     the same holder the Entitlement Pivot counts.
//   - owners: lib/resourceOwners.js, the Entitlement Pivot's own resolution
//     (ownership link, else the source's ownerId reference, else its ownerName).
//   - business roles: the live governance resources with a Contains link to it,
//     over the index on "childResourceId".
//
// The page query selects each resource's extendedAttributes only so the owner
// reference can be read; it is dropped from the rows returned.

import * as db from '../db/connection.js';
import { fetchOwners } from '../lib/resourceOwners.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchHolderCounts(ids) {
  const { rows } = await db.query(
    `SELECT d.id, count(*)::int AS "holderCount"
       FROM (SELECT DISTINCT ra."resourceId" AS id, COALESCE(ra."principalId", ra."identityId") AS h
               FROM "ResourceAssignments" ra
              WHERE ra."resourceId" = ANY($1::uuid[])
                AND ra."deletedAt" IS NULL) d
      GROUP BY d.id`, [ids]);
  return new Map(rows.map(r => [r.id, r.holderCount]));
}

// Resource id -> [{ id, displayName }] of the live business roles containing it,
// by name. A role with several role scopes on one resource is listed once.
async function fetchBusinessRoles(ids) {
  const { rows } = await db.query(
    `SELECT DISTINCT rr."childResourceId" AS "resourceId", br.id, br."displayName"
       FROM "ResourceRelationships" rr
       JOIN "Resources" br ON br.id = rr."parentResourceId"
        AND br."governanceResource" AND br."deletedAt" IS NULL
      WHERE rr."childResourceId" = ANY($1::uuid[])
        AND rr."relationshipType" = 'Contains'
      ORDER BY br."displayName", br.id`, [ids]);
  const byResource = new Map();
  for (const { resourceId, id, displayName } of rows) {
    if (!byResource.has(resourceId)) byResource.set(resourceId, []);
    byResource.get(resourceId).push({ id, displayName });
  }
  return byResource;
}

/** The page's resource rows with holderCount, the owner's name, employee ID and e-mail, and businessRoles. */
export async function withResourceMemberFacts(rows) {
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map(r => r.id))];
  const [holders, owners, roles] = await Promise.all([fetchHolderCounts(ids), fetchOwners(rows), fetchBusinessRoles(ids)]);
  return rows.map(({ extendedAttributes: _readForTheOwner, ...row }) => {
    const owner = owners.get(row.id);
    return {
      ...row,
      holderCount: holders.get(row.id) ?? 0,
      // A copy per row: one id can appear twice on a page with sub-units included.
      businessRoles: (roles.get(row.id) ?? []).map(role => ({ ...role })),
      ownerDisplayName: owner?.ownerName ?? null,
      ownerEmployeeId: owner?.ownerEmployeeId ?? null,
      ownerEmail: owner?.ownerEmail ?? null,
      // The account to link to: the first owner that resolved to one (an owner
      // only the source named has a 'source:' id and no account).
      ownerPrincipalId: owner?.ownerIds?.find(id => UUID.test(String(id))) ?? null,
    };
  });
}
