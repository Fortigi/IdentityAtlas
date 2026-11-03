// The detail endpoints a context owner may read about ONE object, and where
// the references to other objects sit in each response.
//
// An entry's path names its target object; the owner's request is allowed when
// that object opens in full (./ownerAccess.js canOpen) and refused otherwise.
// `refs` say which objects the response mentions, so the response can carry an
// access flag on each (./annotate.js): the facts are never stripped — a group's
// page lists every member — but a member the owner may not open is marked.
//
// A ref is { at, key, kind | kindKey, flag? }:
//   at       dotted path to the object or array holding the reference ('' = the body)
//   key      the field holding the referenced id
//   kind     the referenced object's kind, or
//   kindKey  the field holding it (timeline events and diff items carry a UI kind)
//   flag     the field the verdict is written to (default 'accessible'). The
//            first ref of an object that has an id sets the flag; a later ref
//            writing the same flag leaves it.
//
// Paths are compared as middleware/auth.js guardPath() hands them over: the full
// /api/... path, without the query string, lower-cased.

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

const at = (path, kind, key, flag) => ({ at: path, kind, key, ...(flag ? { flag } : {}) });

const CONTEXT_LIST = [at('', 'context', 'id')];
const EVENTS = [{ at: 'events', kindKey: 'counterpartyKind', key: 'counterpartyId' }];
const DIFF = [
  { at: 'before.relationships', kindKey: 'kind', key: 'id' },
  { at: 'after.relationships', kindKey: 'kind', key: 'id' },
];
// A person row names an account, else a person — the same preference the UI
// links by (contexts/people/people.helpers.js personLink).
const HOLDERS = (path) => [at(path, 'principal', 'principalId'), at(path, 'identity', 'identityId')];

// [path suffix after /api/, target kind, refs]
const USER = [
  [`user/${UUID}`, [at('linkedResource', 'resource', 'id')]],
  [`user/${UUID}/principal-relationships`, [at('', 'principal', 'principalId')]],
  [`user/${UUID}/activity`, [at('perApp', 'principal', 'resourceId')]],
  [`user/${UUID}/contexts`, CONTEXT_LIST],
  [`user/${UUID}/memberships`, [at('', 'resource', 'resourceId')]],
  [`user/${UUID}/access-packages`, [at('', 'resource', 'resourceId')]],
  [`user/${UUID}/oauth2-grants`, [at('', 'resource', 'scopeResourceId'), at('', 'resource', 'clientSpId', 'clientAccessible')]],
  [`user/${UUID}/history`, []],
  [`user/${UUID}/(?:timeline|recent-changes)`, EVENTS],
  [`user/${UUID}/diff`, DIFF],
  [`identities/by-user/${UUID}`, [at('identity', 'identity', 'id'), at('otherMembers', 'principal', 'userId')]],
  [`org-chart/user/${UUID}/manager`, [at('manager', 'principal', 'id')]],
  [`org-chart/user/${UUID}/reports`, [at('reports', 'principal', 'id')]],
];

const IDENTITY = [
  [`identities/${UUID}`, [at('members', 'principal', 'principalId')]],
  [`identities/${UUID}/contexts`, CONTEXT_LIST],
  [`identities/${UUID}/assignments`, [at('', 'resource', 'resourceId'), at('', 'principal', 'principalId', 'principalAccessible')]],
  [`identities/${UUID}/account-matrix`, [at('accounts', 'principal', 'id')]],
  [`identities/${UUID}/(?:timeline|recent-changes)`, EVENTS],
  [`identities/${UUID}/diff`, DIFF],
];

const RESOURCE = [
  [`resources/${UUID}`, []],
  [`resources/${UUID}/assignments`, [at('', 'principal', 'principalId')]],
  [`resources/${UUID}/business-roles`, [at('', 'resource', 'businessRoleId')]],
  [`resources/${UUID}/parent-resources`, [at('', 'resource', 'parentResourceId')]],
  [`resources/${UUID}/contexts`, CONTEXT_LIST],
  [`resources/${UUID}/members`, [at('', 'principal', 'memberId')]],
  [`resources/${UUID}/history`, []],
  [`(?:resources|access-package)/${UUID}/(?:timeline|recent-changes)`, EVENTS],
  [`(?:resources|access-package)/${UUID}/diff`, DIFF],
  [`group/${UUID}`, []],
  [`group/${UUID}/members`, [at('', 'principal', 'memberId')]],
  [`group/${UUID}/access-packages`, [at('', 'resource', 'resourceId')]],
  [`access-package/${UUID}`, []],
  [`access-package/${UUID}/assignments`, [at('', 'principal', 'principalId')]],
  [`access-package/${UUID}/resource-roles`, [at('', 'resource', 'childResourceId')]],
  [`access-package/${UUID}/(?:policies|reviews|requests|history)`, []],
];

// eslint-disable-next-line security/detect-non-literal-regexp -- the suffixes are this file's own literals, never request input
const compile = (kind) => ([suffix, refs]) => ({ re: new RegExp(`^/api/${suffix}$`), kind, refs });

export const ENTITY_ENDPOINTS = [
  ...USER.map(compile('principal')),
  ...IDENTITY.map(compile('identity')),
  ...RESOURCE.map(compile('resource')),
];

// The risk panel of an openable object: read-only (the override PUT/DELETE
// stays refused with every other write).
const RISK_PATH = new RegExp(`^/api/risk-scores/(users|identities|groups|resources|business-roles)/${UUID}$`);
const RISK_KIND = { users: 'principal', identities: 'identity', groups: 'resource', resources: 'resource', 'business-roles': 'resource' };

/** { kind, id, refs } for a detail endpoint about one object, or null. */
export function entityEndpointFor(path) {
  for (const e of ENTITY_ENDPOINTS) {
    const m = e.re.exec(path);
    if (m) return { kind: e.kind, id: m[1], refs: e.refs };
  }
  const risk = RISK_PATH.exec(path);
  if (risk) return { kind: RISK_KIND[risk[1]], id: risk[2], refs: [] };
  return null;
}

// The context pages an owner already reads (auth/contextOwnerScope.js
// CONTEXT_PATHS) whose responses name people or objects.
const CONTEXT_REFS = [
  [new RegExp(`^/api/contexts/${UUID}/members$`), [at('data', 'member', 'id')]],
  [new RegExp(`^/api/contexts/${UUID}/people$`), HOLDERS('data')],
  [new RegExp(`^/api/contexts/${UUID}/roles$`), HOLDERS('')],
  [new RegExp(`^/api/contexts/${UUID}/timeline$`), EVENTS],
];

/** The refs to mark in this path's response, or null when there are none. */
export function refsFor(path) {
  const entity = entityEndpointFor(path);
  if (entity) return entity.refs.length > 0 ? entity.refs : null;
  for (const [re, refs] of CONTEXT_REFS) if (re.test(path)) return refs;
  return null;
}
