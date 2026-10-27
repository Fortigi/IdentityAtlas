// Authorization workbench — GET /api/contexts/:id/workbench, the reads.
// Design: docs/architecture/m1-discovery-and-design.md.
//
// A fixed number of statements whatever the size of the unit (no N+1):
//   1  the unit and its scope (itself, or itself and every sub-unit)
//   1  the people and accounts the scope lists (ContextMembers, minus the members
//      a decision marked former — ContextMemberOverrides)
//   3  who those accounts belong to, the people's attributes, their other accounts
//   2  the access of every account (the matrix matview) and the business roles that explain it
//   2  the resources held, and what the business roles among them Contain
//   1  every activity / expertise / duty claim about these people, in any unit
// The matrix data is the global matrix's own (vw_ResourceUserPermissionAssignments,
// vw_UserPermissionAssignmentViaBusinessRole); nothing here changes it.
// Read-only: the workbench never writes.

import {
  buildPeople, buildCells, buildColumns, buildKnowledge, accountIds, unresolvedMembers,
} from './model.js';
import { KNOWLEDGE_KINDS, KNOWLEDGE } from '../../lib/orgKnowledge.js';
import { withContexts } from './resourceContexts.js';
import { SOURCE_KIND_SQL } from '../interviews/store.js';

export const MAX_PEOPLE = 400;
export const MAX_COLUMNS = 300;

export class WorkbenchError extends Error {
  constructor(status, message) { super(message); this.name = 'WorkbenchError'; this.status = status; }
}

// The unit, and who answers for it (its Accountable — a proposed role's approver may be them).
export const UNIT_SQL = `
  SELECT c.id, c."displayName", c."contextType", c."contextCategory", c."targetType",
         (SELECT COALESCE(p."displayName", i."displayName") FROM "ContextRoles" r
            LEFT JOIN "Principals" p ON p.id = r."principalId" LEFT JOIN "Identities" i ON i.id = r."identityId"
           WHERE r."contextId" = c.id AND r.role = 'Accountable' LIMIT 1) AS accountable
    FROM "Contexts" c WHERE c.id = $1`;

export const SCOPE_SQL = `
  WITH RECURSIVE scope AS (
    SELECT id, "displayName", 0 AS depth FROM "Contexts" WHERE id = $1
    UNION ALL
    SELECT c.id, c."displayName", s.depth + 1 FROM "Contexts" c JOIN scope s ON c."parentContextId" = s.id
     WHERE $2::boolean AND s.depth < 20
  )
  SELECT id, "displayName" FROM scope`;

export const MEMBERS_SQL = `
  SELECT DISTINCT ON (cm."memberType", cm."memberId")
         cm."memberType", cm."memberId", (cm."contextId" = $2) AS direct, c."displayName" AS "unitName"
    FROM "ContextMembers" cm
    JOIN "Contexts" c ON c.id = cm."contextId"
   WHERE cm."contextId" = ANY($1::uuid[])
     AND cm."memberType" IN ('Identity', 'Principal')
     AND NOT EXISTS (SELECT 1 FROM "ContextMemberOverrides" o WHERE o."contextId" = cm."contextId" AND o."memberId" = cm."memberId")
   ORDER BY cm."memberType", cm."memberId", (cm."contextId" = $2) DESC
   LIMIT $3`;

export const LINKS_SQL = `SELECT "principalId", "identityId" FROM "IdentityMembers" WHERE "principalId" = ANY($1::uuid[])`;

export const IDENTITIES_SQL = `
  SELECT i.id, i."displayName", i.email, i."jobTitle", i.department, i."employeeId", i."companyName", i."officeLocation",
         i.city, i.country, m."displayName" AS manager
    FROM "Identities" i LEFT JOIN "Identities" m ON m.id = i."managerIdentityId"
   WHERE i.id = ANY($1::uuid[])`;

const PRINCIPAL_COLUMNS = `p.id, p."displayName", p.email, p."principalType", p."jobTitle", p.department, p."employeeId", p."companyName",
       s."displayName" AS "systemName", (SELECT mp."displayName" FROM "Principals" mp WHERE mp.id = p."managerId") AS manager`;

export const ACCOUNTS_SQL = `
  SELECT im."identityId", ${PRINCIPAL_COLUMNS}
    FROM "IdentityMembers" im
    JOIN "Principals" p ON p.id = im."principalId" AND p."deletedAt" IS NULL
    LEFT JOIN "Systems" s ON s.id = p."systemId"
   WHERE im."identityId" = ANY($1::uuid[])`;

export const PRINCIPALS_SQL = `
  SELECT ${PRINCIPAL_COLUMNS}
    FROM "Principals" p LEFT JOIN "Systems" s ON s.id = p."systemId"
   WHERE p.id = ANY($1::uuid[]) AND p."deletedAt" IS NULL`;

export const ACCESS_SQL = `
  SELECT "principalId", "resourceId", "membershipType", "managedByAccessPackage"
    FROM "vw_ResourceUserPermissionAssignments"
   WHERE "principalId" = ANY($1::uuid[])`;

export const VIA_ROLE_SQL = `
  SELECT "userId", "resourceId", "businessRoleId"
    FROM "vw_UserPermissionAssignmentViaBusinessRole"
   WHERE "userId" = ANY($1::uuid[])`;

// policyKind: how the source assigns a business role, read from its crawled assignment
// policies (Entra access-package policies, …): an auto-add rule → 'rule', a policy
// without one → 'requestable' (people request it), none → null.
export const RESOURCES_SQL = `
  SELECT r.id, r."displayName", r."resourceType", r."governanceResource", s."displayName" AS "systemName",
         (SELECT CASE WHEN bool_or(ap."hasAutoAddRule") THEN 'rule' WHEN count(*) > 0 THEN 'requestable' END
            FROM "AssignmentPolicies" ap WHERE ap."resourceId" = r.id) AS "policyKind"
    FROM "Resources" r LEFT JOIN "Systems" s ON s.id = r."systemId"
   WHERE r.id = ANY($1::uuid[])`;

export const ROLE_PARTS_SQL = `
  SELECT "parentResourceId" AS "roleId", "childResourceId" AS "resourceId"
    FROM "ResourceRelationships"
   WHERE "relationshipType" = 'Contains' AND "parentResourceId" = ANY($1::uuid[])`;

export const KNOWLEDGE_SQL = `
  SELECT c.id, c."contextId", ctx."displayName" AS "contextName", c."claimKind", c."identityId", c."principalId",
         c.value, c.quote, c."claimStatus" AS status, c."proposedBy", c."decidedBy", c."decidedAt",
         c."objectContextId", o."displayName" AS "objectName",
         iv."intervieweeName", iv."interviewedAt"::text AS "interviewedAt", iv."fileName", ${SOURCE_KIND_SQL} AS "sourceKind"
    FROM "ContextClaims" c
    JOIN "ContextInterviews" iv ON iv.id = c."interviewId"
    JOIN "Contexts" ctx ON ctx.id = c."contextId"
    LEFT JOIN "Contexts" o ON o.id = c."objectContextId"
   WHERE c."claimKind" = ANY($3::text[])
     AND (c."identityId" = ANY($1::uuid[]) OR c."principalId" = ANY($2::uuid[]))
   ORDER BY iv."interviewedAt" DESC, c."createdAt"`;

const rowsOf = async (db, sql, params) => (await db.query(sql, params)).rows;

async function loadUnit(db, contextId) {
  const unit = await db.queryOne(UNIT_SQL, [contextId]);
  if (!unit) throw new WorkbenchError(404, 'Context not found');
  if (unit.contextCategory !== 'OrganizationalUnit') {
    throw new WorkbenchError(400, 'The authorization workbench opens on an organizational unit.');
  }
  return unit;
}

async function loadPeopleRows(db, scopeIds, unitId) {
  const members = await rowsOf(db, MEMBERS_SQL, [scopeIds, unitId, MAX_PEOPLE + 1]);
  const principalMembers = members.filter(m => m.memberType === 'Principal').map(m => m.memberId);
  const links = principalMembers.length ? await rowsOf(db, LINKS_SQL, [principalMembers]) : [];
  const linked = new Set(links.map(l => l.principalId));
  const identityIds = [...new Set([
    ...members.filter(m => m.memberType === 'Identity').map(m => m.memberId), ...links.map(l => l.identityId)])];
  const [identities, accounts, principals] = await Promise.all([
    rowsOf(db, IDENTITIES_SQL, [identityIds]),
    rowsOf(db, ACCOUNTS_SQL, [identityIds]),
    rowsOf(db, PRINCIPALS_SQL, [principalMembers.filter(id => !linked.has(id))]),
  ]);
  return { members, links, identities, accounts, principals };
}

/** Everything the workbench shows for one organizational unit. */
export async function loadWorkbench(db, contextId, { includeChildren = true } = {}) {
  const unit = await loadUnit(db, contextId);
  const scope = await rowsOf(db, SCOPE_SQL, [contextId, includeChildren]);
  const scopeIds = scope.map(s => s.id);
  const rows = await loadPeopleRows(db, scopeIds, contextId);
  const truncatedPeople = rows.members.length > MAX_PEOPLE;
  const shownRows = { ...rows, members: rows.members.slice(0, MAX_PEOPLE) };
  const people = buildPeople(shownRows);
  const unresolved = unresolvedMembers(shownRows);

  const principalIds = accountIds(people);
  const identityIds = people.map(p => p.identityId).filter(Boolean);
  const [access, viaRoles, claims] = await Promise.all([
    rowsOf(db, ACCESS_SQL, [principalIds]),
    rowsOf(db, VIA_ROLE_SQL, [principalIds]),
    rowsOf(db, KNOWLEDGE_SQL, [identityIds, principalIds, KNOWLEDGE_KINDS]),
  ]);
  const { cells, holders } = buildCells(people, access, viaRoles);
  const resources = await rowsOf(db, RESOURCES_SQL, [[...holders.keys()]]);
  const roleIds = resources.filter(r => r.governanceResource || r.resourceType === 'BusinessRole').map(r => r.id);
  const roleParts = roleIds.length ? await rowsOf(db, ROLE_PARTS_SQL, [roleIds]) : [];
  const built = buildColumns(resources, holders, roleParts, MAX_COLUMNS);
  const { columns, contexts } = await withContexts(db, built.columns);
  const truncated = built.truncated;
  const shown = new Set(columns.map(c => c.id));
  const knowledge = buildKnowledge(people, claims);

  return {
    unit: { id: unit.id, displayName: unit.displayName, contextType: unit.contextType, targetType: unit.targetType, accountable: unit.accountable ?? null },
    scope: { includeChildren, units: scope.length, truncatedPeople, maxPeople: MAX_PEOPLE, unresolved },
    kinds: KNOWLEDGE_KINDS.map(k => ({ kind: k, label: KNOWLEDGE[k].label, predicate: KNOWLEDGE[k].predicate })),
    people: people.map(p => ({ ...p, knowledge: knowledge.get(p.key) ?? [] })),
    columns,
    truncatedColumns: truncated,
    contexts,
    cells: cells.filter(c => shown.has(c.resourceId)),
    generatedAt: new Date().toISOString(),
  };
}
