// What a context owner's request may reach — the allow-list.
//
// A context owner (auth/contextOwner.js) signed in without an Identity Atlas
// role and is let in only to see the contexts they answer for. Everything they
// may call is listed here; anything not listed is refused. That is the point of
// keeping it a table: a route added to the API tomorrow is closed to them until
// someone adds it here on purpose.
//
// Reads only. A context owner cannot change a role, a member or a setting. The
// one POST is the team matrix, a read whose filter is forced to their team.
//
// Paths are compared as middleware/auth.js guardPath() hands them over: the
// full /api/... path, without the query string, lower-cased. Context ids are
// uuids, held lower-cased in `contextIds`. A path that differs in any way from
// a listed shape (a trailing slash, an extra segment, an encoded character) is
// simply not on the list.

import { entityEndpointFor } from './ownerAccess/endpoints.js';
import { MATRIX_DATA_PATH } from './ownerAccess/matrixFilter.js';
import { BUSINESS_ROLE_CATALOGUE_PATH } from './ownerAccess/responses.js';

export const CONTEXT_OWNER_DENIED = 'Context owners can only open their own context';

// The app shell: who am I, which features are on, the version, my own UI
// preferences and the attribute labels the detail page uses for headings.
export const SHELL_PATHS = new Set([
  '/api/auth-me',
  '/api/features',
  '/api/version',
  '/api/preferences',
  '/api/attribute-labels',
]);

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

// The reads behind one context's page. The captured id must be in scope.
export const CONTEXT_PATHS = [
  new RegExp(`^/api/contexts/${UUID}$`),
  new RegExp(`^/api/contexts/${UUID}/members$`),
  new RegExp(`^/api/contexts/${UUID}/roles$`),
  new RegExp(`^/api/contexts/${UUID}/relationships$`),
  // What interviews established about it: the route answers a context owner
  // with confirmed claims only (routes/contexts/interviews.js).
  new RegExp(`^/api/contexts/${UUID}/claims$`),
  // The People overview: who is in it, who left and what they still hold — from
  // confirmed claims only for a context owner (routes/contexts/read.js).
  new RegExp(`^/api/contexts/${UUID}/people$`),
  new RegExp(`^/api/contexts/${UUID}/timeline$`),
  new RegExp(`^/api/risk-scores/contexts/${UUID}$`),
];

// One member's direct references (names only, no ids — see
// contexts/memberReferences.js). Allowed when the context is in scope AND the
// member is a member of that context itself; the second half needs the
// database, so the verdict hands it to the caller as `member`
// (middleware/contextOwnerMode.js). A member id taken from another context, or
// from one of this context's sub-units, is refused there.
export const MEMBER_REFERENCES_PATH = new RegExp(`^/api/contexts/${UUID}/members/${UUID}/references$`);

// The Actions cards' downloads: the Entitlement Pivot (an application) and the
// unit report (a unit of accounts or people). Allowed only when every context
// they name is in scope; the caller then checks what those values RESOLVE to (a
// value is matched as an id or as a name by the report) — see
// middleware/contextOwnerMode.js.
//
// Per path, the parameters refused outright, whatever their value, because they
// would widen what the report reads beyond the contexts named:
//   - the Entitlement Pivot's older `applications` alias is read instead of
//     `contexts` when present;
//
// And per path, the parameter that widens the report to every unit BELOW the
// named ones (the unit report's `includeSubUnits`). An owner answers for every
// descendant of what they hold, so it is allowed — but a variant in scope does
// not bring its own sub-units with it, so the verdict asks the caller to check
// that the named contexts' descendants are all in scope (`descendants`).
export const REPORT_EXPORT_PATH = '/api/reports/application-access-review/export';
export const UNIT_REPORT_EXPORT_PATH = '/api/reports/unit-members/export';
export const REPORT_EXPORTS = new Map([
  [REPORT_EXPORT_PATH, ['applications']],
  [UNIT_REPORT_EXPORT_PATH, []],
]);
export const SUB_UNIT_PARAMS = new Map([[UNIT_REPORT_EXPORT_PATH, 'includeSubUnits']]);

export const ALLOW = Object.freeze({ allow: true });
export const DENY = Object.freeze({ allow: false });

// The context values a report request names, lower-cased, or null when the
// parameter has a shape the report would not read as a list of strings.
export function requestedContexts(value) {
  let parts;
  if (Array.isArray(value)) parts = value;
  else if (typeof value === 'string') parts = value.split(',');
  else return null;
  if (parts.some(p => typeof p !== 'string')) return null;
  return parts.map(p => p.trim().toLowerCase()).filter(Boolean);
}

// A download: `contexts` only (any of the path's `refused` parameters present
// denies outright), at least one value, and every value one of the owner's
// context ids — a name never passes here. With the path's sub-unit parameter
// present (any value), the caller also checks the named contexts' descendants.
export function reportExportVerdict(query, contextIds, refused = REPORT_EXPORTS.get(REPORT_EXPORT_PATH), subUnitParam = null) {
  if (refused.some(param => query?.[param] !== undefined)) return DENY;
  const wanted = requestedContexts(query?.contexts);
  if (!wanted || wanted.length === 0) return DENY;
  if (!wanted.every(id => contextIds.has(id))) return DENY;
  const descendants = !!subUnitParam && query?.[subUnitParam] !== undefined;
  return descendants ? { allow: false, resolve: wanted, descendants: true } : { allow: false, resolve: wanted };
}

// A member's references: the context must be in scope; whether the member is
// one of its members is for the caller to check. null when not this path.
export function memberReferencesVerdict(path, contextIds) {
  const m = MEMBER_REFERENCES_PATH.exec(path);
  if (!m) return null;
  if (!contextIds.has(m[1])) return DENY;
  return { allow: false, member: { contextId: m[1], memberId: m[2] } };
}

// One object's detail page (a team member, a resource the team holds): the
// object must open in full for this owner — auth/ownerAccess decides from the
// data, so the verdict hands the object to the caller as `entity`. The paths
// are listed in auth/ownerAccess/endpoints.js. null when not such a path.
export function entityVerdict(path) {
  const e = entityEndpointFor(path);
  return e ? { allow: false, entity: { kind: e.kind, id: e.id } } : null;
}

// Reads whose RESPONSE is cut to the owner's scope before it is sent
// (auth/ownerAccess/responses.js): the business-role catalogue the matrix maps
// roles to groups with, reduced to the roles this owner may open. Allowed only
// because middleware/contextOwnerMode.js always applies that cut on this path.
export const SCOPED_PATHS = new Set([BUSINESS_ROLE_CATALOGUE_PATH]);

// The team matrix — the one POST an owner may send: a read, whose filter the
// caller forces to the owner's team (auth/ownerAccess/matrixFilter.js).
export const MATRIX_VERDICT = Object.freeze({ allow: false, matrix: true });

// { method, path, query } + the owner's scope → ALLOW, DENY,
// { allow: false, resolve: [...] } when the answer depends on what the named
// contexts resolve to, { allow: false, member: { contextId, memberId } }
// when it depends on that member being in that context, { allow: false,
// entity: { kind, id } } when it depends on that object being openable, or
// MATRIX_VERDICT for the team matrix.
export function contextOwnerVerdict({ method, path, query }, contextIds) {
  if (method === 'POST' && path === MATRIX_DATA_PATH) return MATRIX_VERDICT;
  if (method !== 'GET') return DENY;
  if (SHELL_PATHS.has(path) || SCOPED_PATHS.has(path)) return ALLOW;
  for (const shape of CONTEXT_PATHS) {
    const m = shape.exec(path);
    if (m) return contextIds.has(m[1]) ? ALLOW : DENY;
  }
  const member = memberReferencesVerdict(path, contextIds);
  if (member) return member;
  const entity = entityVerdict(path);
  if (entity) return entity;
  const refused = REPORT_EXPORTS.get(path);
  if (refused) return reportExportVerdict(query, contextIds, refused, SUB_UNIT_PARAMS.get(path));
  return DENY;
}
