// Single source of truth that maps every catalog permission (see permissions.js)
// to HOW it is enforced and a representative protected endpoint.
//
// Consumed by:
//   - auth/permissionMatrix.test.js  — drives the allow/deny enforcement matrix
//     and the catalog-completeness guard.
//   - docs/reference/permissions.md  — kept in sync by docsCoverage.test.js.
//
// THE GUARD: every key in PERMISSIONS must appear in exactly ONE of the three
// maps below, or permissionMatrix.test.js fails. That is what makes it
// impossible to add a new "permission checkbox" without consciously deciding
// (and testing) how it is enforced.

// ── Gated permissions ───────────────────────────────────────────────────────
// Enforced by requirePermission() on one or more routes. For each we record ONE
// representative endpoint the matrix test exercises with an ALLOW token (has the
// permission → not 403) and a DENY token (has every OTHER permission → 403).
// The gate runs before the handler, so the request body only needs to exist for
// body-parsing — a denied request never reaches validation, and an allowed one
// only needs to get PAST the gate (any non-403 status counts).
export const GATED_ENDPOINTS = {
  'data.export.ui':        { method: 'GET',  path: '/api/admin/export/curated' },
  'data.export.apikey':    { method: 'POST', path: '/api/admin/read-tokens', body: { name: 'matrix-test' } },
  'data.write.tags':       { method: 'POST', path: '/api/tags', body: { name: 'matrix-test' } },
  'data.write.categories': { method: 'POST', path: '/api/categories', body: { name: 'matrix-test' } },
  'data.write.risk':       { method: 'PUT',  path: '/api/risk-scores/identity/1/override', body: { decision: 'accept' } },
  'data.write.identity':   { method: 'PUT',  path: '/api/identities/00000000-0000-0000-0000-000000000000/members/00000000-0000-0000-0000-000000000000/override', body: { action: 'confirmed' } },
  'admin.crawlers':        { method: 'GET',  path: '/api/admin/crawlers' },
  'admin.systems':         { method: 'PUT',  path: '/api/systems/1', body: {} },
  'admin.llm':             { method: 'GET',  path: '/api/admin/llm/config' },
  'admin.context-plugins': { method: 'GET',  path: '/api/context-plugins' },
  'admin.csv-import':      { method: 'GET',  path: '/api/admin/crawler-configs/1/csv-files' },
  'admin.read-tokens':     { method: 'GET',  path: '/api/admin/read-tokens' },
  'admin.feature-flags':   { method: 'POST', path: '/api/admin/features/toggle', body: { key: 'RISK_SCORING', enabled: false } },
  'admin.auth':            { method: 'GET',  path: '/api/admin/roles' },
};

// ── Implicit permissions ────────────────────────────────────────────────────
// Not enforced by a requirePermission() gate but by a different mechanism.
// `data.read` is the "can sign in at all" permission: enforced as
// authentication-required (any signed-in user can read), and read-only API
// tokens (fgr_) are granted it implicitly in middleware/auth.js. The matrix
// test verifies it by confirming an UNauthenticated request is rejected (401).
export const IMPLICIT_PERMISSIONS = {
  'data.read': {
    reason: 'Authentication-required: any signed-in user can read, and fgr_ read tokens are granted it implicitly. No requirePermission gate.',
    probe: { method: 'GET', path: '/api/permissions' },
  },
};

// ── Reserved permissions ────────────────────────────────────────────────────
// In the catalog (and shown as a checkbox in the Admin → Roles matrix) but not
// yet wired to any endpoint. If you add an endpoint that should enforce one of
// these, MOVE it to GATED_ENDPOINTS with a representative route so the matrix
// test starts covering it.
export const RESERVED_PERMISSIONS = {
  'data.write.certifications':
    'No interactive certification-decision endpoint exists yet — decisions are ingested via the crawler ' +
    '(POST /api/ingest/governance/certifications, crawler-auth). When an approve/revoke endpoint is added, ' +
    'gate it with data.write.certifications and move this entry to GATED_ENDPOINTS.',
};
