// Relationship-edge catalog — the single source of truth for the ad-hoc
// "filter entities by relationship presence/absence/count" feature (#840, Phase 1).
//
// Each edge's SQL traversal is IRREDUCIBLY bespoke (ownership is a 3-hop walk
// through a synthetic *Ownership resource; membership is a ResourceAssignments
// row; owner/sponsor is a PrincipalRelationships row), so the catalog is code,
// not data. What keeps it from silently drifting is (a) availability is computed
// live from these same probes and (b) the coverage guard below fails when the
// data contains a relationship type this catalog neither consumes nor ignores.
//
// An edge entry:
//   id            stable id, `<entity>.<name>` (also the wire value)
//   label         user-facing text ("has members")
//   fromEntity    'Resource' | 'Principal' — the list this edge is offered on
//   inverseOf     (optional) the id this edge is the reverse direction of
//   fromWhere(a)  correlated `FROM … WHERE …=a."id" …` fragment (a = outer alias)
//   countCol      the COUNT(...) expression for count operators
//   availableProbe a non-correlated `SELECT 1 …` used to decide `available`
//
// `fromWhere` and `countCol` are composed by relationshipSql.js into EXISTS /
// NOT EXISTS / scalar-count predicates — kept apart here so the join text is
// written once per edge (no exists-vs-count duplication).

// Ownership is modelled as a Direct assignment on a synthetic ownership resource
// (migration 046 + the app-owners crawler). These are the resourceTypes and the
// relationshipTypes that carry it.
const OWNERSHIP_RESOURCE_TYPES = "('GroupOwnership','ServicePrincipalOwnership','ApplicationOwnership')";
const OWNERSHIP_REL_TYPES = "('HasOwnership','HasAppOwnership')";

export const EDGES = {
  // ─── Resource-anchored (offered on the Resources list) ───────────────
  'resource.members': {
    id: 'resource.members',
    label: 'has members',
    fromEntity: 'Resource',
    fromWhere: (a) => `FROM "ResourceAssignments" ra WHERE ra."resourceId" = ${a}."id" AND ra."deletedAt" IS NULL`,
    countCol: 'count(DISTINCT ra."principalId")',
    availableProbe: 'SELECT 1 FROM "ResourceAssignments" WHERE "deletedAt" IS NULL',
  },
  'resource.owners': {
    id: 'resource.owners',
    label: 'has owners',
    fromEntity: 'Resource',
    fromWhere: (a) => `FROM "ResourceRelationships" rr
      JOIN "Resources" own ON own."id" = rr."childResourceId" AND own."deletedAt" IS NULL
      JOIN "ResourceAssignments" ra ON ra."resourceId" = own."id" AND ra."assignmentType" = 'Direct' AND ra."deletedAt" IS NULL
     WHERE rr."parentResourceId" = ${a}."id" AND rr."relationshipType" IN ${OWNERSHIP_REL_TYPES}`,
    countCol: 'count(DISTINCT ra."principalId")',
    availableProbe: `SELECT 1 FROM "ResourceRelationships" WHERE "relationshipType" IN ${OWNERSHIP_REL_TYPES}`,
  },

  // ─── Principal-anchored (offered on the Users list) ──────────────────
  'principal.memberOf': {
    id: 'principal.memberOf',
    label: 'is a member of a resource',
    fromEntity: 'Principal',
    inverseOf: 'resource.members',
    fromWhere: (a) => `FROM "ResourceAssignments" ra WHERE ra."principalId" = ${a}."id" AND ra."deletedAt" IS NULL`,
    countCol: 'count(DISTINCT ra."resourceId")',
    availableProbe: 'SELECT 1 FROM "ResourceAssignments" WHERE "deletedAt" IS NULL',
  },
  'principal.owns': {
    id: 'principal.owns',
    label: 'owns a resource',
    fromEntity: 'Principal',
    inverseOf: 'resource.owners',
    fromWhere: (a) => `FROM "ResourceAssignments" ra
      JOIN "Resources" own ON own."id" = ra."resourceId" AND own."resourceType" IN ${OWNERSHIP_RESOURCE_TYPES} AND own."deletedAt" IS NULL
     WHERE ra."principalId" = ${a}."id" AND ra."assignmentType" = 'Direct' AND ra."deletedAt" IS NULL`,
    countCol: 'count(DISTINCT ra."resourceId")',
    availableProbe: `SELECT 1 FROM "Resources" WHERE "resourceType" IN ${OWNERSHIP_RESOURCE_TYPES} AND "deletedAt" IS NULL`,
  },
  'principal.owner': {
    id: 'principal.owner',
    label: 'has an owner',
    fromEntity: 'Principal',
    fromWhere: (a) => `FROM "PrincipalRelationships" prx WHERE prx."principalId" = ${a}."id" AND prx."relationshipType" = 'Owner'`,
    countCol: 'count(*)',
    availableProbe: `SELECT 1 FROM "PrincipalRelationships" WHERE "relationshipType" = 'Owner'`,
  },
  'principal.sponsor': {
    id: 'principal.sponsor',
    label: 'has a sponsor',
    fromEntity: 'Principal',
    fromWhere: (a) => `FROM "PrincipalRelationships" prx WHERE prx."principalId" = ${a}."id" AND prx."relationshipType" = 'Sponsor'`,
    countCol: 'count(*)',
    availableProbe: `SELECT 1 FROM "PrincipalRelationships" WHERE "relationshipType" = 'Sponsor'`,
  },
  'principal.ownsPrincipals': {
    id: 'principal.ownsPrincipals',
    label: 'is an owner of a principal',
    fromEntity: 'Principal',
    inverseOf: 'principal.owner',
    fromWhere: (a) => `FROM "PrincipalRelationships" prx WHERE prx."relatedPrincipalId" = ${a}."id" AND prx."relationshipType" = 'Owner'`,
    countCol: 'count(*)',
    availableProbe: `SELECT 1 FROM "PrincipalRelationships" WHERE "relationshipType" = 'Owner'`,
  },
  'principal.sponsorsPrincipals': {
    id: 'principal.sponsorsPrincipals',
    label: 'sponsors a guest',
    fromEntity: 'Principal',
    inverseOf: 'principal.sponsor',
    fromWhere: (a) => `FROM "PrincipalRelationships" prx WHERE prx."relatedPrincipalId" = ${a}."id" AND prx."relationshipType" = 'Sponsor'`,
    countCol: 'count(*)',
    availableProbe: `SELECT 1 FROM "PrincipalRelationships" WHERE "relationshipType" = 'Sponsor'`,
  },
};

// The operators every edge supports. `exists`/`absent` are existence; `eq`/`lt`/
// `gt` are count comparisons and require an integer `n >= 0`.
export const OPS = ['exists', 'absent', 'eq', 'lt', 'gt'];
export const COUNT_OPS = ['eq', 'lt', 'gt'];
export const OP_SYMBOL = { eq: '=', lt: '<', gt: '>' };

// Return the catalogue entries offered for a given entity target, as the shape
// the /relationship-edges endpoint and the UI consume (no SQL leaked).
export function edgesForEntity(entity) {
  return Object.values(EDGES)
    .filter((e) => e.fromEntity === entity)
    .map((e) => ({ id: e.id, label: e.label, fromEntity: e.fromEntity, inverseOf: e.inverseOf || null, ops: OPS }));
}

// ─── Coverage guard (closes the "static catalog silently drifts" loose end) ──
//
// The relationship types the catalog actually consumes as filter edges, and the
// ones it deliberately ignores (they exist but aren't relationship-presence
// filters). Any distinct relationshipType found in the data that is in NEITHER
// set is drift — a new mechanism nobody taught the catalog about — and
// assertCatalogCoversData() flags it so a human adds an edge (or ignores it).
export const CONSUMED_RESOURCE_REL_TYPES = new Set(['HasOwnership', 'HasAppOwnership']);
export const IGNORED_RESOURCE_REL_TYPES = new Set([
  'Contains', 'GrantsAccessTo', 'DelegatesScope', 'HasAppRole', 'HasApplicationPermission',
]);
export const CONSUMED_PRINCIPAL_REL_TYPES = new Set(['Owner', 'Sponsor']);

// Given the distinct relationshipType values present in each relationship-bearing
// table, return the list of uncovered (drifted) types. Empty ⇒ catalog is complete.
// Pure function so it is unit-testable without a DB; the contract test feeds it
// values read from the live schema.
export function findUncoveredRelationshipTypes({ resourceRelTypes = [], principalRelTypes = [] }) {
  const uncovered = [];
  for (const t of resourceRelTypes) {
    if (!CONSUMED_RESOURCE_REL_TYPES.has(t) && !IGNORED_RESOURCE_REL_TYPES.has(t)) {
      uncovered.push({ table: 'ResourceRelationships', relationshipType: t });
    }
  }
  for (const t of principalRelTypes) {
    if (!CONSUMED_PRINCIPAL_REL_TYPES.has(t)) {
      uncovered.push({ table: 'PrincipalRelationships', relationshipType: t });
    }
  }
  return uncovered;
}
