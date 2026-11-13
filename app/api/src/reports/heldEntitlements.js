// The Entitlement Pivot's reads for a unit of ACCOUNTS (a context whose members
// are Principals): the entitlements its members hold, and how they hold them.
//
// A context of resources lists its entitlements as members. A unit of accounts
// does not — its entitlements are whatever its members were granted. So here the
// entitlement set is derived from the members' live assignments, and the holder
// counts are counted AMONG THOSE MEMBERS: a line manager reviewing Finance wants
// "3 of my people hold this", not the company-wide 4,000. A resource held only by
// someone outside the unit is not in scope.
//
// Members are the unit's DIRECT members, the same rule the resource side follows
// (it reads ContextMembers of the named context only). Sub-units are not folded
// in: a parent unit and its sub-units are separate rows of a review, and the
// caller can name the sub-units too.
//
// Business roles are left out as entitlements — the matrix's default visibility
// rule (lib/resourceVisibility.js). A role a member holds is governance intent; it
// already shows as the "Granted by role(s)" column of the entitlements it grants.
// Ownership resources stay in: owning a group is access an owner should see.
//
// Same performance shape as the resource side: the entitlement ids go in as an
// explicit uuid[], and de-duplication is an inner DISTINCT (see the template).

import * as db from '../db/connection.js';
import { visibleResourceTypesSql } from '../lib/resourceVisibility.js';

// The live (contextId, account) pairs of the named units.
const MEMBERS_SQL = `
       FROM "ContextMembers" cm
       JOIN "Principals" p ON p.id = cm."memberId" AND p."deletedAt" IS NULL
       JOIN "ResourceAssignments" ra ON ra."principalId" = cm."memberId" AND ra."deletedAt" IS NULL
      WHERE cm."contextId" = ANY($1::uuid[])
        AND cm."memberType" = 'Principal'`;

/** One row per (unit, entitlement a member of it holds), same shape as the resource side. */
export async function fetchHeldEntitlements(contextIds, limit) {
  const { rows } = await db.query(
    `SELECT r.id, r."displayName", r."resourceType", r.description, r."extendedAttributes",
            s."displayName" AS "systemName", h."contextId"
       FROM (SELECT DISTINCT cm."contextId", ra."resourceId" ${MEMBERS_SQL}) h
       JOIN "Resources" r ON r.id = h."resourceId"
       LEFT JOIN "Systems" s ON s.id = r."systemId"
      WHERE r."deletedAt" IS NULL
        AND ${visibleResourceTypesSql('r."resourceType"')}
      ORDER BY r."displayName", r.id
      LIMIT ${limit}`, [contextIds]);
  return rows;
}

/** The key a held entitlement's counts are filed under: per unit, because each unit counts its own members. */
export const memberCountKey = (contextId, resourceId) => `${contextId}|${resourceId}`;

/** Holders per (unit, entitlement), among that unit's members, split by how they hold it. */
export async function fetchMemberAssignmentCounts(contextIds, ids) {
  const { rows } = await db.query(
    `SELECT d."contextId", d.id,
            count(*) FILTER (WHERE d.t = 'Direct')::int   AS "direct",
            count(*) FILTER (WHERE d.t = 'Indirect')::int AS "indirect",
            count(*) FILTER (WHERE d.t = 'Eligible')::int AS "eligible"
       FROM (SELECT DISTINCT cm."contextId", ra."resourceId" AS id, ra."principalId" AS h, ra."assignmentType" AS t
               ${MEMBERS_SQL}
                AND ra."resourceId" = ANY($2::uuid[])) d
      GROUP BY d."contextId", d.id`, [contextIds, ids]);
  return new Map(rows.map(r => [memberCountKey(r.contextId, r.id), r]));
}

/** Distinct members, across the named units, who hold at least one in-scope entitlement. */
export async function fetchMemberUserTotal(contextIds, ids) {
  const row = await db.queryOne(
    `SELECT count(*)::int AS "users"
       FROM (SELECT DISTINCT ra."principalId" AS h
               ${MEMBERS_SQL}
                AND ra."resourceId" = ANY($2::uuid[])) s`, [contextIds, ids]);
  return row?.users ?? 0;
}
