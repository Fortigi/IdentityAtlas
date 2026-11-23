// Best guess for who answers for a business role.
//
//   Accountable  the Accountable of the context the request scope maps to, else
//                the manager of most named approvers and reviewers, else the
//                manager of most people holding the role, else the owner of most
//                resources in it: someone who answers for the people.
//   Responsible  the owner of most resources in it, else the manager of most
//                holders: someone who knows what the role contains.
//
// A candidate must cover at least SUGGESTION_THRESHOLD of the holders or
// resources (the same bar contexts use), is never someone turned down for this
// role, and the Responsible guess is never the Accountable.

import * as db from '../db/connection.js';
import { pickCandidate, share } from '../contexts/roleSuggestion.js';
import { OWNERSHIP_TYPES_SQL, OWNERSHIP_RELATIONSHIP_TYPES_SQL } from './ownershipTypes.js';

const notExcluded = (column) => `
       AND ${column} <> ALL($3::uuid[])
       AND NOT EXISTS (SELECT 1 FROM "BusinessRoleOwnerRejections" x
                        WHERE x."resourceId" = $1 AND x.role = $2 AND x."principalId" = ${column})`;

const LIVE_HOLDER = `a."resourceId" = $1 AND a."principalId" IS NOT NULL AND a."deletedAt" IS NULL`;

export const HOLDER_TOTAL_SQL = `
    SELECT COUNT(DISTINCT a."principalId")::int AS total
      FROM "ResourceAssignments" a
      JOIN "Principals" e ON e.id = a."principalId" AND e."deletedAt" IS NULL
     WHERE ${LIVE_HOLDER}`;

export const MANAGER_SQL = `
    SELECT m.id, m."displayName", COUNT(DISTINCT e.id)::int AS count
      FROM "ResourceAssignments" a
      JOIN "Principals" e ON e.id = a."principalId" AND e."deletedAt" IS NULL
      JOIN "Principals" m ON m.id = e."managerId" AND m."deletedAt" IS NULL
     WHERE ${LIVE_HOLDER}${notExcluded('m.id')}
     GROUP BY m.id, m."displayName"
     ORDER BY count DESC, m."displayName", m.id
     LIMIT 1`;

const CONTAINED = `c."parentResourceId" = $1 AND c."relationshipType" = 'Contains'`;

export const RESOURCE_TOTAL_SQL = `
    SELECT COUNT(DISTINCT c."childResourceId")::int AS total
      FROM "ResourceRelationships" c
      JOIN "Resources" r ON r.id = c."childResourceId" AND r."deletedAt" IS NULL
     WHERE ${CONTAINED}`;

export const RESOURCE_OWNER_SQL = `
    SELECT p.id, p."displayName", COUNT(DISTINCT c."childResourceId")::int AS count
      FROM "ResourceRelationships" c
      JOIN "Resources" r ON r.id = c."childResourceId" AND r."deletedAt" IS NULL
      JOIN "ResourceRelationships" rr ON rr."parentResourceId" = c."childResourceId"
       AND rr."relationshipType" IN ${OWNERSHIP_RELATIONSHIP_TYPES_SQL}
      JOIN "Resources" o ON o.id = rr."childResourceId"
       AND o."resourceType" IN ${OWNERSHIP_TYPES_SQL} AND o."deletedAt" IS NULL
      JOIN "ResourceAssignments" ra ON ra."resourceId" = o.id
       AND ra."assignmentType" = 'Direct' AND ra."deletedAt" IS NULL
      JOIN "Principals" p ON p.id = ra."principalId" AND p."deletedAt" IS NULL
     WHERE ${CONTAINED}${notExcluded('p.id')}
     GROUP BY p.id, p."displayName"
     ORDER BY count DESC, p."displayName", p.id
     LIMIT 1`;

const SIGNALS = {
  manager: { totalSql: HOLDER_TOTAL_SQL, sql: MANAGER_SQL, reason: (n, total) => `manages ${share(n, total, 'holder')}` },
  owner: { totalSql: RESOURCE_TOTAL_SQL, sql: RESOURCE_OWNER_SQL, reason: (n, total) => `owns ${share(n, total, 'resource')}` },
};

export const SIGNAL_ORDER = { Accountable: ['manager', 'owner'], Responsible: ['owner', 'manager'] };

async function trySignal(signal, resourceId, role, excluded) {
  const totalRow = await db.queryOne(signal.totalSql, [resourceId]);
  const total = totalRow?.total || 0;
  if (!total) return null;
  const { rows } = await db.query(signal.sql, [resourceId, role, excluded]);
  const best = pickCandidate(rows, total);
  if (!best) return null;
  return { role, principalId: best.id, displayName: best.displayName, reason: signal.reason(best.count, total), count: best.count, total };
}

export async function suggestOwner(resourceId, role, excluded = []) {
  for (const name of SIGNAL_ORDER[role]) {
    const found = await trySignal(SIGNALS[name], resourceId, role, excluded);
    if (found) return found;
  }
  return null;
}

export const SCOPE_ACCOUNTABLE_SQL = `
    SELECT DISTINCT p.id, p."displayName", c."displayName" AS "contextName"
      FROM "ContextRoles" r
      JOIN "Contexts" c ON c.id = r."contextId"
      JOIN "Principals" p ON p.id = r."principalId" AND p."deletedAt" IS NULL
     WHERE r.role = 'Accountable' AND r."contextId" = ANY($2::uuid[])
       AND NOT EXISTS (SELECT 1 FROM "BusinessRoleOwnerRejections" x
                        WHERE x."resourceId" = $1 AND x.role = 'Accountable' AND x."principalId" = p.id)`;

export const RESPONSIBLE_MANAGER_SQL = `
    SELECT m.id, m."displayName", COUNT(DISTINCT e.id)::int AS count
      FROM "Principals" e
      JOIN "Principals" m ON m.id = e."managerId" AND m."deletedAt" IS NULL
     WHERE e.id = ANY($2::uuid[]) AND e."deletedAt" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "BusinessRoleOwnerRejections" x
                        WHERE x."resourceId" = $1 AND x.role = 'Accountable' AND x."principalId" = m.id)
     GROUP BY m.id, m."displayName"
     ORDER BY count DESC, m."displayName", m.id
     LIMIT 1`;

const accountableGuess = (row, reason, count, total) => ({
  role: 'Accountable', principalId: row.id, displayName: row.displayName, reason, count, total,
});

// One clear Accountable across the contexts the request scope maps to.
async function fromRequestScope(resourceId, participants) {
  const contexts = [...new Set(participants.filter(p => p.participation === 'Requestor' && p.contextId).map(p => p.contextId))];
  if (contexts.length === 0) return null;
  const { rows } = await db.query(SCOPE_ACCOUNTABLE_SQL, [resourceId, contexts]);
  if (new Set(rows.map(r => r.id)).size !== 1) return null;
  return accountableGuess(rows[0], `accountable for ${rows[0].contextName}, who may request this role`, 1, 1);
}

async function fromApproversAndReviewers(resourceId, owners) {
  const people = owners.filter(o => o.derivedFrom?.length && o.principalId).map(o => o.principalId);
  if (people.length === 0) return null;
  const { rows } = await db.query(RESPONSIBLE_MANAGER_SQL, [resourceId, people]);
  const best = pickCandidate(rows, people.length);
  if (!best) return null;
  const reason = people.length === 1 ? 'manages the approver or reviewer' : `manages ${best.count} of the ${people.length} approvers and reviewers`;
  return accountableGuess(best, reason, best.count, people.length);
}

// A guess for each place nobody holds yet.
export async function suggestBusinessRoleOwners(resourceId, owners, participants = []) {
  const accountable = owners.find(o => o.role === 'Accountable');
  const hasResponsible = owners.some(o => o.role === 'Responsible');
  const Accountable = accountable ? null
    : (await fromRequestScope(resourceId, participants))
      ?? (await fromApproversAndReviewers(resourceId, owners))
      ?? (await suggestOwner(resourceId, 'Accountable'));
  const taken = [accountable?.principalId, Accountable?.principalId].filter(Boolean);
  const Responsible = hasResponsible ? null : await suggestOwner(resourceId, 'Responsible', taken);
  return { Accountable, Responsible };
}
