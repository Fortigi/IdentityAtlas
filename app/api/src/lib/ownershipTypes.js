// The resourceTypes that mean "this row is an ownership of something else",
// in ONE place.
//
// Ownership is not an assignmentType (that enum was collapsed to
// Direct/Indirect/Eligible): it is a synthetic resource named after the thing
// owned, linked to it by a `HasOwnership` / `HasAppOwnership` relationship,
// with a plain `Direct` assignment per owner. See CLAUDE.md → Assignment types
// and docs/architecture/matrix.md → "Owner rows are their own resource".
//
// That shape has one consequence every consumer has to know about: an owner's
// row is a `Direct` assignment like any other, so a query that counts "who has
// access" must exclude these or ownership silently inflates it. The risk engine
// said so in a comment and then named a single literal ('GroupOwnership'), which
// left the two app-ownership types counting as memberships from the day they
// shipped. The list therefore lives here, is imported by everyone who filters on
// it, and grows once when a new ownership type appears.
//
// `resourceType` stays an OPEN vocabulary (ingest/resourceTypes.guard.test.js):
// this is a list of the ownership types Identity Atlas's own crawlers emit, not
// an allow-list. A type not named here is treated as ordinary access, which is
// the safe default for an unknown value.
export const OWNERSHIP_RESOURCE_TYPES = [
  // Owners of an Entra group (migration 046).
  'GroupOwnership',
  // Owners of an enterprise app's service principal / of the app registration.
  'ServicePrincipalOwnership',
  'ApplicationOwnership',
  // Owners of a resource loaded by the SQL connector — one generic type,
  // because that crawler's `resourceType` is whatever the operator's statement
  // says (Entitlement, SAPRole, …) and a per-owned-type name would be an
  // unbounded family no consumer could enumerate. The owned resource's own type
  // is kept on the ownership row's `extendedAttributes.ownedResourceType`.
  'ResourceOwnership',
];

// The relationship types that link an owned resource (parent) to its ownership
// resource (child). `HasAppOwnership` exists only so the Entra group-owner full
// sync cannot reconcile the app-owner links away; both mean the same edge.
export const OWNERSHIP_RELATIONSHIP_TYPES = ['HasOwnership', 'HasAppOwnership'];

// `('A','B',…)` for an SQL `IN` / `NOT IN` list. The values are module
// constants, never request input, so quoting them here cannot interpolate
// anything a caller controls.
export function sqlInList(values) {
  return `(${values.map(v => `'${v}'`).join(',')})`;
}

export const OWNERSHIP_TYPES_SQL = sqlInList(OWNERSHIP_RESOURCE_TYPES);
export const OWNERSHIP_RELATIONSHIP_TYPES_SQL = sqlInList(OWNERSHIP_RELATIONSHIP_TYPES);
