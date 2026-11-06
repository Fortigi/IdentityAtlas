// What a context owner's request may reach — the allow-list.
//
// A context owner (auth/contextOwner.js) signed in without an Identity Atlas
// role and is let in only to see the contexts they answer for. Everything they
// may call is listed here; anything not listed is refused. That is the point of
// keeping it a table: a route added to the API tomorrow is closed to them until
// someone adds it here on purpose.
//
// Reads only. A context owner cannot change a role, a member or a setting.
//
// Paths are compared as middleware/auth.js guardPath() hands them over: the
// full /api/... path, without the query string, lower-cased. Context ids are
// uuids, held lower-cased in `contextIds`. A path that differs in any way from
// a listed shape (a trailing slash, an extra segment, an encoded character) is
// simply not on the list.

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
//   - the unit report's `includeSubUnits` adds every unit BELOW the named ones,
//     which need not be the owner's. Refused rather than checked against the
//     subtree: the card never sends it, and the owner of a sub-unit downloads
//     from that sub-unit's own page.
export const REPORT_EXPORT_PATH = '/api/reports/application-access-review/export';
export const UNIT_REPORT_EXPORT_PATH = '/api/reports/unit-members/export';
export const REPORT_EXPORTS = new Map([
  [REPORT_EXPORT_PATH, ['applications']],
  [UNIT_REPORT_EXPORT_PATH, ['includeSubUnits']],
]);

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
// context ids — a name never passes here.
export function reportExportVerdict(query, contextIds, refused = REPORT_EXPORTS.get(REPORT_EXPORT_PATH)) {
  if (refused.some(param => query?.[param] !== undefined)) return DENY;
  const wanted = requestedContexts(query?.contexts);
  if (!wanted || wanted.length === 0) return DENY;
  if (!wanted.every(id => contextIds.has(id))) return DENY;
  return { allow: false, resolve: wanted };
}

// A member's references: the context must be in scope; whether the member is
// one of its members is for the caller to check. null when not this path.
export function memberReferencesVerdict(path, contextIds) {
  const m = MEMBER_REFERENCES_PATH.exec(path);
  if (!m) return null;
  if (!contextIds.has(m[1])) return DENY;
  return { allow: false, member: { contextId: m[1], memberId: m[2] } };
}

// { method, path, query } + the owner's scope → ALLOW, DENY,
// { allow: false, resolve: [...] } when the answer depends on what the named
// contexts resolve to, or { allow: false, member: { contextId, memberId } }
// when it depends on that member being in that context.
export function contextOwnerVerdict({ method, path, query }, contextIds) {
  if (method !== 'GET') return DENY;
  if (SHELL_PATHS.has(path)) return ALLOW;
  for (const shape of CONTEXT_PATHS) {
    const m = shape.exec(path);
    if (m) return contextIds.has(m[1]) ? ALLOW : DENY;
  }
  const member = memberReferencesVerdict(path, contextIds);
  if (member) return member;
  const refused = REPORT_EXPORTS.get(path);
  if (refused) return reportExportVerdict(query, contextIds, refused);
  return DENY;
}
