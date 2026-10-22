// What the context page's member list shows about a RESOURCE member besides its
// own columns: how many people hold it, and who owns it.
//
// One page of members at a time (at most 500 ids), two set-based reads for the
// whole page, never one per row:
//   - holders: distinct holders per resource from live ResourceAssignments over
//     the page's id array — the index on "resourceId" serves it, so the 40M-row
//     table is only touched for those resources. Nothing stores a per-resource
//     count (migration 083's counts are per context), so it is computed here.
//     A holder is the principal, or the identity where a source links one —
//     the same holder the Entitlement Pivot counts.
//   - owners: lib/resourceOwners.js, the Entitlement Pivot's own resolution
//     (ownership link, else the source's ownerId reference, else its ownerName).
//
// The page query selects each resource's extendedAttributes only so the owner
// reference can be read; it is dropped from the rows returned.

import * as db from '../db/connection.js';
import { fetchOwners } from '../lib/resourceOwners.js';

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

/** The page's resource rows with holderCount and the owner's name, employee ID and e-mail. */
export async function withResourceMemberFacts(rows) {
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map(r => r.id))];
  const [holders, owners] = await Promise.all([fetchHolderCounts(ids), fetchOwners(rows)]);
  return rows.map(({ extendedAttributes: _readForTheOwner, ...row }) => {
    const owner = owners.get(row.id);
    return {
      ...row,
      holderCount: holders.get(row.id) ?? 0,
      ownerDisplayName: owner?.ownerName ?? null,
      ownerEmployeeId: owner?.ownerEmployeeId ?? null,
      ownerEmail: owner?.ownerEmail ?? null,
    };
  });
}
