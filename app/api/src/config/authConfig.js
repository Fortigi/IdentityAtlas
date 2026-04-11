// Auth configuration loader.
//
// Identity Atlas's Entra ID SSO settings (AUTH_ENABLED, AUTH_TENANT_ID,
// AUTH_CLIENT_ID, AUTH_REQUIRED_ROLES) live in dbo.WorkerConfig so they survive
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
// reloadAuthConfig() is exposed but called only at startup. There is no
// runtime mutation API.

import jwksClient from 'jwks-rsa';
import * as db from '../db/connection.js';

const useSql = process.env.USE_SQL === 'true';

// Module-level state — a snapshot of the current auth configuration. Read by
// authMiddleware and the /api/auth-config route. Mutated only by load()/reload().
let _state = {
  enabled: false,
  tenantId: '',
  clientId: '',
  requiredRoles: null, // null = no role check; otherwise array of strings
  jwksClient: null,    // built when enabled === true && tenantId is set
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

// Read all four auth keys out of WorkerConfig in one query. Missing rows are
// just absent from the result — caller falls back to env vars.
async function readFromDb() {
  if (!useSql) return {};
  try {
    const r = await db.query(
      `SELECT "configKey", "configValue" FROM "WorkerConfig"
        WHERE "configKey" IN ('AUTH_ENABLED','AUTH_TENANT_ID','AUTH_CLIENT_ID','AUTH_REQUIRED_ROLES')`
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
  const enabled  = parseBoolean(resolve(dbVals.AUTH_ENABLED,        process.env.AUTH_ENABLED,        'false'));
  const tenantId = resolve(dbVals.AUTH_TENANT_ID,        process.env.AUTH_TENANT_ID,        '');
  const clientId = resolve(dbVals.AUTH_CLIENT_ID,        process.env.AUTH_CLIENT_ID,        '');
  const roles    = parseRoles(resolve(dbVals.AUTH_REQUIRED_ROLES,   process.env.AUTH_REQUIRED_ROLES,   ''));

  _state = {
    enabled,
    tenantId,
    clientId,
    requiredRoles: roles,
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
