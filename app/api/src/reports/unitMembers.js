// The unit report's reads: the members of one or more organisational units, and
// how many entitlements each holds.
//
// Two kinds of unit, one shape of row:
//   - a unit of ACCOUNTS (targetType Principal): its member accounts, and the
//     distinct resources each account holds;
//   - a unit of PEOPLE (targetType Identity): its member people, and the
//     distinct resources held across every account linked to the person
//     (IdentityMembers), plus anything assigned to the person directly
//     (ResourceAssignments.identityId).
// Business roles are not counted: a role is intent, and the entitlements it
// grants are counted themselves (lib/resourceVisibility.js, the matrix's rule).
//
// Members are the units' DIRECT members unless `includeSubUnits`, which takes
// the whole subtree under each unit (a recursive walk; UNION stops on a cycle).
//
// Counts are one grouped statement over the page's member ids as an explicit
// uuid[] — the same shape as the Entitlement Pivot's counts, for the same reason
// (docs/architecture/reports.md → "Counting assignments at scale").

import * as db from '../db/connection.js';
import { visibleResourceTypesSql } from '../lib/resourceVisibility.js';

// The contexts whose members are read: the named units, or their subtrees.
export function scopeSql(includeSubUnits) {
  if (!includeSubUnits) return 'SELECT unnest($1::uuid[]) AS id';
  return `WITH RECURSIVE scope AS (
            SELECT c.id FROM "Contexts" c WHERE c.id = ANY($1::uuid[])
            UNION
            SELECT c.id FROM "Contexts" c JOIN scope s ON c."parentContextId" = s.id
          )
          SELECT id FROM scope`;
}

// Per kind of unit: the member table and the columns a row carries.
const MEMBER_SQL = {
  Principal: `
    SELECT DISTINCT ON (cm."contextId", m.id)
           m.id, m."displayName", m.email, m."jobTitle", m.department, m."employeeId",
           m."principalType", m."accountEnabled", mgr."displayName" AS "managerName",
           s."displayName" AS "systemName", m."extendedAttributes",
           cm."contextId", u."displayName" AS "unitName"
      FROM "ContextMembers" cm
      JOIN "Principals" m ON m.id = cm."memberId" AND m."deletedAt" IS NULL
      JOIN "Contexts" u ON u.id = cm."contextId"
      LEFT JOIN "Principals" mgr ON mgr.id = m."managerId"
      LEFT JOIN "Systems" s ON s.id = m."systemId"
     WHERE cm."memberType" = 'Principal'`,
  Identity: `
    SELECT DISTINCT ON (cm."contextId", m.id)
           m.id, m."displayName", m.email, m."jobTitle", m.department, m."employeeId",
           m."accountCount", mgr."displayName" AS "managerName", m."extendedAttributes",
           cm."contextId", u."displayName" AS "unitName"
      FROM "ContextMembers" cm
      JOIN "Identities" m ON m.id = cm."memberId"
      JOIN "Contexts" u ON u.id = cm."contextId"
      LEFT JOIN "Identities" mgr ON mgr.id = m."managerIdentityId"
     WHERE cm."memberType" = 'Identity'`,
};

/** One row per (unit, member), at most `limit`, by unit then member name. */
export async function fetchUnitMembers(kind, contextIds, { includeSubUnits = false, limit }) {
  const { rows } = await db.query(
    `SELECT * FROM (${MEMBER_SQL[kind]}
        AND cm."contextId" IN (${scopeSql(includeSubUnits)})
      ORDER BY cm."contextId", m.id) members
      ORDER BY "unitName", "displayName", id
      LIMIT ${Number(limit)}`, [contextIds]);
  return rows;
}

const VISIBLE = visibleResourceTypesSql('r."resourceType"');

// Per kind of unit: (member id, resource id) pairs, de-duplicated, then counted.
const HELD_SQL = {
  Principal: `
    SELECT DISTINCT ra."principalId" AS id, ra."resourceId" AS r
      FROM "ResourceAssignments" ra
      JOIN "Resources" r ON r.id = ra."resourceId" AND r."deletedAt" IS NULL AND ${VISIBLE}
     WHERE ra."principalId" = ANY($1::uuid[]) AND ra."deletedAt" IS NULL`,
  Identity: `
    SELECT im."identityId" AS id, ra."resourceId" AS r
      FROM "IdentityMembers" im
      JOIN "ResourceAssignments" ra ON ra."principalId" = im."principalId" AND ra."deletedAt" IS NULL
      JOIN "Resources" r ON r.id = ra."resourceId" AND r."deletedAt" IS NULL AND ${VISIBLE}
     WHERE im."identityId" = ANY($1::uuid[])
    UNION
    SELECT ra."identityId" AS id, ra."resourceId" AS r
      FROM "ResourceAssignments" ra
      JOIN "Resources" r ON r.id = ra."resourceId" AND r."deletedAt" IS NULL AND ${VISIBLE}
     WHERE ra."identityId" = ANY($1::uuid[]) AND ra."deletedAt" IS NULL`,
};

/** Member id → number of distinct entitlements held. One statement for all members. */
export async function fetchEntitlementCounts(kind, memberIds) {
  if (!memberIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT d.id, count(*)::int AS "entitlements"
       FROM (${HELD_SQL[kind]}) d
      GROUP BY d.id`, [memberIds]);
  return new Map(rows.map(r => [r.id, r.entitlements]));
}
