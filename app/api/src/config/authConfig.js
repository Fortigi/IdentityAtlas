// Auth configuration loader.
//
// Identity Atlas's Entra ID SSO settings (AUTH_ENABLED, AUTH_TENANT_ID,
// AUTH_CLIENT_ID, AUTH_REQUIRED_ROLES) live in "WorkerConfig" so they survive
// container restarts and can be inspected without rebuilding the image. They
// are written *only* via the CLI tool at cli/auth-config.js, run from the host
// via `docker compose exec web node ...`, followed by `docker compose restart web`.
//
// Why CLI + restart instead of an in-app save endpoint:
//   - An in-app PUT would have to be reachable when auth is currently *off*
//     (otherwise nobody could ever turn auth on for the first time). Exposing
//     an unauthenticated mutation surface that controls authentication itself
//     is the kind of thing that ends up in a CVE.
//   - The host running docker is already trusted for everything else
//     (deployments, secrets, db access). Gating auth config behind shell access
//     matches an existing trust boundary instead of inventing a new one.
//   - The recovery path (locked out → flip auth back off) requires shell
//     access anyway. Consolidating both directions in one tool is consistent.
//
// Resolution order at startup (first hit wins per key):
//   1. WorkerConfig row in SQL (canonical, written by the CLI)
//   2. Process environment variable (legacy fallback for stacks that haven't
//      run the CLI yet — keeps existing deployments working unchanged)
//   3. Hardcoded default (auth disabled)
//
// reloadAuthConfig() is exposed but called only at startup.
//
// Exception: AUTH_ROLE_PERMISSIONS (the role→permission mapping) IS
// hot-updatable via setRolePermissions() because the Admin UI edits it.
// See the rationale block on setRolePermissions() below for why this is
// a different risk profile from tenant/client config.

import jwksClient from 'jwks-rsa';
import * as db from '../db/connection.js';
import { SEED_ROLE_PERMISSIONS, isKnownPermission } from '../auth/permissions.js';

const useSql = process.env.USE_SQL === 'true';

// Module-level state — a snapshot of the current auth configuration. Read by
// authMiddleware and the /api/auth-config route. Mutated by load()/reload()
// AND by setRolePermissions() (the latter is a runtime update from the Admin
// UI — see comment block below for why role mapping is hot-updatable while
// tenant/client are CLI-only).
let _state = {
  enabled: false,
  tenantId: '',
  clientId: '',
  requiredRoles: null,   // null = no role check; otherwise array of strings
  rolePermissions: null, // null = use SEED_ROLE_PERMISSIONS; otherwise the customer's saved mapping
  jwksClient: null,      // built when enabled === true && tenantId is set
  loaded: false,
};

function buildJwksClient(tenantId) {
  if (!tenantId) return null;
  return jwksClient({
    jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    cache: true,
    cacheMaxAge: 86400000,  // 24h — same as the previous middleware
  });
}

function parseBoolean(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  return String(v).toLowerCase() === 'true';
}

function parseRoles(v) {
  if (!v) return null;
  const arr = String(v).split(',').map(r => r.trim()).filter(Boolean);
  return arr.length > 0 ? arr : null;
}

// Parse the role->permission JSON blob from WorkerConfig. Defensive: unknown
// permission strings are dropped silently (so older clients can't keep a
// removed permission alive); we never throw on a malformed value — that would
// brick auth on the next startup. Bad input falls back to null (= seed).
function parseRolePermissions(raw) {
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Role names are user-supplied (via the admin role-mapping API). Build the
  // result with Object.fromEntries over a filtered entry list instead of
  // assigning to a computed property — and drop prototype-polluting keys
  // (__proto__/constructor/prototype) so a hostile mapping can't reach
  // Object.prototype.
  const entries = Object.entries(parsed)
    .filter(([role, perms]) =>
      typeof role === 'string' && role &&
      role !== '__proto__' && role !== 'constructor' && role !== 'prototype' &&
      Array.isArray(perms))
    .map(([role, perms]) => [role, perms.filter(p => typeof p === 'string' && isKnownPermission(p))]);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

// Read all auth keys out of WorkerConfig in one query. Missing rows are
// just absent from the result — caller falls back to env vars.
async function readFromDb() {
  if (!useSql) return {};
  try {
    const r = await db.query(
      `SELECT "configKey", "configValue" FROM "WorkerConfig"
        WHERE "configKey" IN ('AUTH_ENABLED','AUTH_TENANT_ID','AUTH_CLIENT_ID','AUTH_REQUIRED_ROLES','AUTH_ROLE_PERMISSIONS')`
    );
    const out = {};
    for (const row of r.rows) out[row.configKey] = row.configValue;
    return out;
  } catch (err) {
    // Table might not exist yet on a fresh stack — fail silent and rely on env vars.
    console.warn('authConfig: failed to read WorkerConfig, falling back to env vars:', err.message);
    return {};
  }
}

// Resolve a single config value: DB → env → default.
function resolve(dbValue, envValue, defaultValue) {
  if (dbValue != null && dbValue !== '') return dbValue;
  if (envValue != null && envValue !== '') return envValue;
  return defaultValue;
}

export async function loadAuthConfig() {
  const dbVals = await readFromDb();
  const enabled         = parseBoolean(resolve(dbVals.AUTH_ENABLED,      process.env.AUTH_ENABLED,      'false'));
  const tenantId        = resolve(dbVals.AUTH_TENANT_ID,    process.env.AUTH_TENANT_ID,    '');
  const clientId        = resolve(dbVals.AUTH_CLIENT_ID,    process.env.AUTH_CLIENT_ID,    '');
  const roles           = parseRoles(resolve(dbVals.AUTH_REQUIRED_ROLES, process.env.AUTH_REQUIRED_ROLES, ''));
  const rolePermissions = parseRolePermissions(dbVals.AUTH_ROLE_PERMISSIONS);

  _state = {
    enabled,
    tenantId,
    clientId,
    requiredRoles: roles,
    rolePermissions,
    jwksClient: enabled && tenantId ? buildJwksClient(tenantId) : null,
    loaded: true,
  };

  if (enabled && (!tenantId || !clientId)) {
    console.warn('authConfig: AUTH_ENABLED is true but tenantId or clientId is missing — auth will reject all requests');
  }

  return _state;
}

// Re-read from DB and rebuild module state. Called only at process startup —
// runtime auth changes happen via the CLI tool (cli/auth-config.js) plus a
// container restart, so there's no in-process write surface to maintain.
export async function reloadAuthConfig() {
  return loadAuthConfig();
}

// Read-only accessors used by the middleware and the /api/auth-config route.
// Keeping these as functions (not exported state) avoids stale references.
export function getAuthState()   { return _state; }
export function isAuthEnabled()  { return _state.enabled; }
export function getJwksClient()  { return _state.jwksClient; }
export function getTenantId()    { return _state.tenantId; }
export function getClientId()    { return _state.clientId; }
export function getRequiredRoles() { return _state.requiredRoles; }

// Role -> permission mapping. Returns the customer's saved mapping if present,
// otherwise the built-in seed. Always returns a plain object (never null) so
// downstream resolvePermissions() always has something to iterate.
export function getRolePermissions() {
  return _state.rolePermissions || SEED_ROLE_PERMISSIONS;
}

// True iff the customer has saved a mapping. The Admin UI uses this to show
// "you're using the default seed mapping" vs "you've customised it."
export function hasCustomRolePermissions() {
  return _state.rolePermissions !== null;
}

// In-process update used by the Admin → Roles & Permissions page. Persists to
// WorkerConfig AND updates module state immediately — no restart needed.
//
// Why this is hot-updatable while tenant/client are CLI-only:
//   - Tenant/client mistakes can lock everyone out (wrong tenant → no token
//     ever validates). Recovery requires shell access anyway, so CLI is the
//     natural surface.
//   - Role mapping mistakes are bounded — worst case a role grants too few
//     permissions, and 'admin.auth' is protected by the self-lockout guard
//     in the route handler. The Admin user editing the mapping already has
//     'admin.auth' so a real-time save is no worse than the existing route
//     mutations they're allowed to perform.
//
// Pass `null` to clear the customer mapping and revert to the seed.
export async function setRolePermissions(mapping) {
  // Re-validate and re-normalize (drop unknown perms, strip junk) so the DB
  // never contains a value that wouldn't survive loadAuthConfig().
  const normalized = mapping === null ? null : parseRolePermissions(JSON.stringify(mapping));

  if (useSql) {
    if (normalized === null) {
      await db.query(`DELETE FROM "WorkerConfig" WHERE "configKey" = 'AUTH_ROLE_PERMISSIONS'`);
    } else {
      const json = JSON.stringify(normalized);
      await db.query(
        `INSERT INTO "WorkerConfig" ("configKey", "configValue")
              VALUES ('AUTH_ROLE_PERMISSIONS', $1)
         ON CONFLICT ("configKey") DO UPDATE
            SET "configValue" = EXCLUDED."configValue",
                "updatedAt"   = (now() AT TIME ZONE 'utc')`,
        [json]
      );
    }
  }

  _state = { ..._state, rolePermissions: normalized };
  return getRolePermissions();
}
