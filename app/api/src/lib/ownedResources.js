// What a principal owns — the reverse of lib/resourceOwners.js, for the
// principal's own detail page. A resource is listed here exactly when that
// module would name this principal as its owner, by either of its two routes:
//
//   1. The ownership LINK: a Direct assignment of this principal on an ownership
//      resource, whose ownership relationship points at the owned resource.
//   2. The source's own REFERENCE: the resource has no linked owner at all, and
//      its `ownerId` attribute resolves to this principal. Which values resolve
//      to this principal is decided by that module's own resolver (external id
//      first, else an employee number exactly one live account carries), so the
//      two directions cannot disagree about who a reference names.
//
// The reference route reads the attribute under its contract name, `ownerId`
// (what the SQL connector writes), and is served by the partial index of
// migration 111 — the owner side of a catalogue with hundreds of thousands of
// entitlements must not scan them on every page load.

import * as db from '../db/connection.js';
import { OWNERSHIP_RELATIONSHIP_TYPES_SQL, OWNERSHIP_TYPES_SQL } from './ownershipTypes.js';
import { linkedOwnerExistsSql, resolveReferences } from './resourceOwners.js';

// The list is a page of names to click through, not an export: one person can
// own tens of thousands of entitlements. The count is always exact.
export const OWNED_LIST_LIMIT = 1000;

const OWNED_SQL = `
  SELECT r.id AS "resourceId", r."displayName", r."resourceType", 'link' AS via
    FROM "ResourceAssignments" ra
    JOIN "Principals" p ON p.id = ra."principalId" AND p."deletedAt" IS NULL
    JOIN "Resources" o ON o.id = ra."resourceId"
     AND o."resourceType" IN ${OWNERSHIP_TYPES_SQL}
     AND o."deletedAt" IS NULL
    JOIN "ResourceRelationships" rr ON rr."childResourceId" = o.id
     AND rr."relationshipType" IN ${OWNERSHIP_RELATIONSHIP_TYPES_SQL}
    JOIN "Resources" r ON r.id = rr."parentResourceId" AND r."deletedAt" IS NULL
   WHERE ra."principalId" = $1
     AND ra."assignmentType" = 'Direct'
     AND ra."deletedAt" IS NULL
  UNION
  SELECT r.id, r."displayName", r."resourceType", 'reference'
    FROM "Resources" r
   WHERE r."extendedAttributes"->>'ownerId' = ANY($2::text[])
     AND r."deletedAt" IS NULL
     AND NOT EXISTS (${linkedOwnerExistsSql('r.id')})`;

const text = value => (typeof value === 'string' ? value.trim() : '');

/** The owner references that name THIS principal: its external id and/or employee number. */
export async function ownReferences(principal) {
  const candidates = [...new Set([text(principal.externalId), text(principal.employeeId)].filter(Boolean))];
  const resolved = await resolveReferences(candidates);
  return candidates.filter(ref => resolved.get(ref)?.id === principal.id);
}

/** How many live resources this principal owns. `principal` is `{ id, externalId, employeeId }`. */
export async function countOwnedResources(principal) {
  const refs = await ownReferences(principal);
  const { rows } = await db.query(`SELECT count(*)::int AS cnt FROM (${OWNED_SQL}) owned`, [principal.id, refs]);
  return rows[0]?.cnt ?? 0;
}

/** The resources this principal owns, by name: `{ resourceId, displayName, resourceType, via }`. */
export async function fetchOwnedResources(principal) {
  const refs = await ownReferences(principal);
  const { rows } = await db.query(
    `${OWNED_SQL}
     ORDER BY "displayName", "resourceId"
     LIMIT ${OWNED_LIST_LIMIT}`, [principal.id, refs]);
  return rows;
}
