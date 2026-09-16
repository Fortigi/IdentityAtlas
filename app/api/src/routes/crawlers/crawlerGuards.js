// Guards for the admin crawler-management endpoints (SEC-2026-09 M-06).
//
// - Crawler permissions an admin may grant are a fixed whitelist. `admin` —
//   the worker-class permission that can claim jobs and receive vaulted
//   connector credentials — is granted only by bootstrap to the built-in
//   worker, never through the API.
// - The built-in worker row (Crawlers."isBuiltIn") cannot be renamed, disabled,
//   deleted, re-scoped or re-permissioned through the API; only its
//   description and rate limit are editable.

export const ASSIGNABLE_CRAWLER_PERMISSIONS = ['ingest', 'refreshViews'];
const MAX_PERMISSION_ENTRIES = 10;

// Validate a caller-supplied permissions value. Returns { permissions } with a
// de-duplicated array (undefined when the caller did not send the field), or
// { error } with a 400 message. Pure.
export function validateCrawlerPermissions(permissions) {
  if (permissions === undefined) return { permissions: undefined };
  const valid = Array.isArray(permissions)
    && permissions.length > 0
    && permissions.length <= MAX_PERMISSION_ENTRIES
    && permissions.every(p => ASSIGNABLE_CRAWLER_PERMISSIONS.includes(p));
  if (!valid) {
    return { error: `permissions must be a non-empty array of: ${ASSIGNABLE_CRAWLER_PERMISSIONS.join(', ')}` };
  }
  return { permissions: [...new Set(permissions)] };
}

const BUILTIN_EDITABLE_FIELDS = new Set(['description', 'rateLimit']);
const CRAWLER_PATCH_FIELDS = ['displayName', 'description', 'enabled', 'systemIds', 'permissions', 'expiresAt', 'rateLimit'];

// True when a PATCH body touches a field the built-in worker row protects. Pure.
export function touchesProtectedBuiltinField(body) {
  return CRAWLER_PATCH_FIELDS.some(f => body?.[f] !== undefined && !BUILTIN_EDITABLE_FIELDS.has(f));
}

export const BUILTIN_PROTECTED_ERROR =
  'The built-in worker crawler is managed by Identity Atlas: it cannot be renamed, disabled, deleted, re-scoped or given different permissions.';

// After a guarded statement matched no row: 403 when the id is the built-in
// worker, else 404.
export async function respondBuiltinOrNotFound(pool, id, res) {
  const r = await pool.query(`SELECT "isBuiltIn" FROM "Crawlers" WHERE id = $1`, [id]);
  if (r.rows[0]?.isBuiltIn) return res.status(403).json({ error: BUILTIN_PROTECTED_ERROR });
  return res.status(404).json({ error: 'Crawler not found' });
}
