// A context member's direct references — names only.
//
// For one member of one context: what else that member is tied to, directly.
//   an account or a person  → the groups and resources they hold (with how:
//                             Direct / Indirect / Eligible), the business roles
//                             they hold, and the other contexts they are in;
//   a resource              → who holds it, the business roles that contain it,
//                             and the other contexts it is in;
//   a system                → the other contexts it is in.
//
// This is the "reference" projection behind GET
// /api/contexts/:id/members/:memberId/references, and the reason it exists is a
// context owner (docs/architecture/context-owner-access.md): somebody who may
// see their own unit but nothing outside it. They can see THAT a member of their
// unit holds "Finance-Admins", not open "Finance-Admins". So the projection
// carries no ids at all — a display name and the few words needed to read it
// (a type, a system, an assignment type). There is nothing in it to follow.
//
// Each group holds at most REFERENCE_CAP names, alphabetically, plus the true
// total, so the page can say "+ 1,234 more" without reading them.
//
// Every function takes the pool explicitly so the contract test can run the
// exact statements against PostgreSQL (contract-tests/memberReferences.contract.test.js).

export const REFERENCE_CAP = 50;

// The member's own row in this context, or null when it is not a member of it.
export async function findContextMember(pool, contextId, memberId) {
  const { rows } = await pool.query(
    `SELECT cm."memberType" FROM "ContextMembers" cm WHERE cm."contextId" = $1::uuid AND cm."memberId" = $2::uuid`,
    [contextId, memberId],
  );
  return rows[0] ?? null;
}

// One reference group from capped rows that each carry the full count as
// `total` (COUNT(*) OVER ()): at most `cap` items, without `total` on them.
export function toReferenceGroup(key, rows, cap = REFERENCE_CAP) {
  const items = rows.slice(0, cap).map(({ total: _total, ...item }) => item);
  const total = Math.max(Number(rows[0]?.total ?? 0), items.length);
  return { key, items, total };
}

// Who "the member" is for assignment and membership lookups: the accounts that
// stand for it and, for a person, the person itself (an IGA source can assign
// to a person rather than an account).
export async function memberSubjects(pool, memberType, memberId) {
  if (memberType === 'Principal') return { principalIds: [memberId], identityId: null };
  if (memberType !== 'Identity') return { principalIds: [], identityId: null };
  const { rows } = await pool.query(
    `SELECT im."principalId" FROM "IdentityMembers" im WHERE im."identityId" = $1::uuid`,
    [memberId],
  );
  return { principalIds: rows.map(r => r.principalId), identityId: memberId };
}

// The resources the subjects hold — business roles or everything else. One row
// per (resource, assignment type): a person holding a group through two of
// their accounts sees it once.
async function heldResources(pool, { principalIds, identityId }, businessRoles, cap) {
  const { rows } = await pool.query(
    `SELECT r."displayName", r."resourceType", s."displayName" AS "systemName", ra."assignmentType",
            COUNT(*) OVER () AS total
       FROM (SELECT DISTINCT a."resourceId", a."assignmentType"
               FROM "ResourceAssignments" a
              WHERE a."deletedAt" IS NULL
                AND (a."principalId" = ANY($1::uuid[]) OR ($2::uuid IS NOT NULL AND a."identityId" = $2::uuid))) ra
       JOIN "Resources" r ON r.id = ra."resourceId" AND r."deletedAt" IS NULL
       LEFT JOIN "Systems" s ON s.id = r."systemId"
      WHERE (r."resourceType" IS NOT DISTINCT FROM 'BusinessRole') = $3::boolean
      ORDER BY r."displayName", ra."assignmentType"
      LIMIT $4`,
    [principalIds, identityId, businessRoles, cap],
  );
  return rows;
}

// The other contexts the member — or, for a person, one of their accounts — is in.
async function otherContexts(pool, contextId, memberIds, cap) {
  const { rows } = await pool.query(
    `SELECT c."displayName", c."contextType", c."targetType", COUNT(*) OVER () AS total
       FROM "Contexts" c
      WHERE c.id <> $1::uuid
        AND c.id IN (SELECT cm."contextId" FROM "ContextMembers" cm WHERE cm."memberId" = ANY($2::uuid[]))
      ORDER BY c."displayName"
      LIMIT $3`,
    [contextId, memberIds, cap],
  );
  return rows;
}

// Who holds a resource: accounts by their own name and type, a person (an
// assignment made to the identity) as 'Person'.
async function resourceHolders(pool, resourceId, cap) {
  const { rows } = await pool.query(
    `SELECT COALESCE(p."displayName", i."displayName") AS "displayName",
            CASE WHEN ra."identityId" IS NOT NULL THEN 'Person' ELSE p."principalType" END AS "holderType",
            ra."assignmentType", COUNT(*) OVER () AS total
       FROM (SELECT DISTINCT a."principalId", a."identityId", a."assignmentType"
               FROM "ResourceAssignments" a
              WHERE a."resourceId" = $1::uuid AND a."deletedAt" IS NULL) ra
       LEFT JOIN "Principals" p ON p.id = ra."principalId" AND p."deletedAt" IS NULL
       LEFT JOIN "Identities" i ON i.id = ra."identityId"
      WHERE p.id IS NOT NULL OR i.id IS NOT NULL
      ORDER BY 1, ra."assignmentType"
      LIMIT $2`,
    [resourceId, cap],
  );
  return rows;
}

// The business roles that contain a resource.
async function containingBusinessRoles(pool, resourceId, cap) {
  const { rows } = await pool.query(
    `SELECT br."displayName", s."displayName" AS "systemName", COUNT(*) OVER () AS total
       FROM "ResourceRelationships" rr
       JOIN "Resources" br ON br.id = rr."parentResourceId"
                          AND br."resourceType" = 'BusinessRole' AND br."deletedAt" IS NULL
       LEFT JOIN "Systems" s ON s.id = br."systemId"
      WHERE rr."childResourceId" = $1::uuid AND rr."relationshipType" = 'Contains'
      ORDER BY br."displayName"
      LIMIT $2`,
    [resourceId, cap],
  );
  return rows;
}

async function accountOrPersonGroups(pool, contextId, memberType, memberId, cap) {
  const subjects = await memberSubjects(pool, memberType, memberId);
  const [resources, businessRoles, contexts] = await Promise.all([
    heldResources(pool, subjects, false, cap),
    heldResources(pool, subjects, true, cap),
    otherContexts(pool, contextId, [memberId, ...subjects.principalIds], cap),
  ]);
  return [
    toReferenceGroup('resources', resources, cap),
    toReferenceGroup('businessRoles', businessRoles, cap),
    toReferenceGroup('contexts', contexts, cap),
  ];
}

async function resourceGroups(pool, contextId, memberId, cap) {
  const [holders, businessRoles, contexts] = await Promise.all([
    resourceHolders(pool, memberId, cap),
    containingBusinessRoles(pool, memberId, cap),
    otherContexts(pool, contextId, [memberId], cap),
  ]);
  return [
    toReferenceGroup('holders', holders, cap),
    toReferenceGroup('businessRoles', businessRoles, cap),
    toReferenceGroup('contexts', contexts, cap),
  ];
}

// { memberType, groups: [{ key, items, total }] } for one member of a context.
// The caller has already checked that memberId is a member of contextId.
export async function loadMemberReferences(pool, contextId, memberType, memberId, cap = REFERENCE_CAP) {
  let groups;
  if (memberType === 'Resource') groups = await resourceGroups(pool, contextId, memberId, cap);
  else if (memberType === 'System') groups = [toReferenceGroup('contexts', await otherContexts(pool, contextId, [memberId], cap), cap)];
  else groups = await accountOrPersonGroups(pool, contextId, memberType, memberId, cap);
  return { memberType, groups };
}
