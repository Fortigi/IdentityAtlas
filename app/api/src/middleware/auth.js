// JWT validation middleware. Reads its configuration from authConfig.js (which
// is hot-reloadable from the Admin → Authentication page) instead of static
// process.env values, so flipping auth on/off doesn't require a container restart.
//
// When auth is disabled the middleware is a no-op (next() immediately).

import jwt from 'jsonwebtoken';
import {
  isAuthEnabled,
  getJwksClient,
  getTenantId,
  getClientId,
  getRequiredRoles,
  getRolePermissions,
} from '../config/authConfig.js';
import { isReadTokenFormat, findActiveByPlaintext } from '../auth/readTokens.js';
import { resolvePermissions } from '../auth/permissions.js';

// jwks-rsa's getSigningKey is callback-shaped. We need a stable function ref
// that resolves the *current* client at call time so a hot reload picks up the
// new tenant on the next request.
function makeKeyResolver() {
  return function getKey(header, callback) {
    const client = getJwksClient();
    if (!client) return callback(new Error('Auth is enabled but JWKS client is not initialized'));
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return callback(err);
      callback(null, key.getPublicKey());
    });
  };
}

const keyResolver = makeKeyResolver();

export function authMiddleware(req, res, next) {
  if (!isAuthEnabled()) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];

  // Crawler API keys (fgc_) are valid only on routes protected by
  // crawlerAuthMiddleware further down the Express chain — those mounts use
  // the prefixes /api/crawlers and /api/ingest (see index.js). For requests
  // on those prefixes, call next() so the request reaches crawlerAuthMiddleware
  // which performs the real key validation. For any other /api/* path
  // (admin, UI, etc.) reject — a bare fgc_-prefixed string must not pass
  // here unchecked, or it'd bypass admin auth entirely.
  if (token.startsWith('fgc_')) {
    // Use originalUrl because req.path inside an app.use('/api', ...) layer
    // reflects the mount-stripped path on some Express versions.
    const fullPath = req.originalUrl.split('?')[0];
    if (fullPath.startsWith('/api/crawlers/') || fullPath.startsWith('/api/ingest/')) {
      return next();
    }
    return res.status(401).json({ error: 'Crawler API keys are not valid for this endpoint' });
  }

  // Read-only API keys (`fgr_…`) are accepted on GET requests to non-admin
  // endpoints — that's all downstream tooling (Excel Power Query, BI imports)
  // needs and it keeps the blast radius of a leaked read token contained.
  // Anything mutating or admin-scoped MUST come from a real signed-in user.
  if (isReadTokenFormat(token)) {
    if (req.method !== 'GET') {
      return res.status(403).json({ error: 'Read API keys may only be used for GET requests' });
    }
    if (req.path.startsWith('/api/admin/')) {
      return res.status(403).json({ error: 'Read API keys cannot access admin endpoints' });
    }
    findActiveByPlaintext(token).then(row => {
      if (!row) return res.status(401).json({ error: 'Invalid, revoked, or expired read API key' });
      req.readToken = { id: row.id, name: row.name };
      next();
    }).catch(err => {
      console.error('Read token lookup failed:', err.message);
      res.status(500).json({ error: 'Authentication service error' });
    });
    return;
  }

  const tenantId = getTenantId();
  const clientId = getClientId();

  jwt.verify(token, keyResolver, {
    audience: [`api://${clientId}`, clientId],
    issuer: [
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
      `https://sts.windows.net/${tenantId}/`,
    ],
    algorithms: ['RS256'],
  }, (err, decoded) => {
    if (err) {
      console.error('Token validation failed:', err.message);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Defense-in-depth: token must come from the configured tenant
    if (decoded.tid && decoded.tid !== tenantId) {
      console.error(`Token tenant mismatch: expected ${tenantId}, got ${decoded.tid}`);
      return res.status(401).json({ error: 'Token issued by unexpected tenant' });
    }

    const tokenRoles = Array.isArray(decoded.roles) ? decoded.roles : [];

    // Optional app-role gate — coarse "must have one of these roles" check
    // configured via AUTH_REQUIRED_ROLES. Independent of the permission
    // model below; if both are set, both must pass.
    const requiredRoles = getRequiredRoles();
    if (requiredRoles && requiredRoles.length > 0) {
      if (!requiredRoles.some(r => tokenRoles.includes(r))) {
        console.error(`Token missing required role. Has: [${tokenRoles.join(', ')}], needs one of: [${requiredRoles.join(', ')}]`);
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
    }

    // Resolve roles -> permissions via the configured (or seed) mapping.
    //
    // Backwards-compat rule: a signed-in user with NO recognised roles gets
    // a sentinel '*' permission, same as the wildcard for Admin in the seed
    // mapping. This preserves existing behaviour for installs that have not
    // yet assigned users to the Entra app roles. The moment the customer
    // assigns at least one role that's in the mapping, that role's explicit
    // permissions apply and the wildcard fallback no longer kicks in for
    // that user.
    const mapping = getRolePermissions();
    let permissions = resolvePermissions(tokenRoles, mapping);
    if (permissions.size === 0) {
      permissions = new Set(['*']);
    }

    req.user = decoded;
    req.user.roles = tokenRoles;
    req.user.permissions = permissions;
    next();
  });
}

// Per-route permission gate. Use at the mount line (most routers) or as a
// per-handler middleware (mixed routers with read GETs + admin POSTs).
//
//   app.use('/api', authMiddleware, requirePermission('admin.crawlers'), adminCrawlersRouter);
//   router.post('/categories', requirePermission('data.write.categories'), handler);
//
// Accepts one or more permission strings — having ANY one of them is enough.
// When auth is disabled the gate is a no-op (open mode bypass).
export function requirePermission(...required) {
  if (required.length === 0) {
    throw new Error('requirePermission() requires at least one permission name');
  }
  return function permissionGate(req, res, next) {
    if (!isAuthEnabled()) return next();

    // fgr_ read tokens get data.read implicitly. They're already restricted to
    // GET + non-admin endpoints by the upstream middleware, so the only
    // permission gate they ever encounter is data.read.
    if (req.readToken) {
      if (required.includes('data.read')) return next();
      return res.status(403).json({ error: 'Read API keys cannot access this endpoint', required });
    }

    const perms = req.user?.permissions;
    if (!perms) {
      // Should not happen — authMiddleware always sets this on a valid JWT.
      // Treat as misconfiguration, deny rather than crash.
      return res.status(403).json({ error: 'No permissions resolved for user', required });
    }
    if (perms.has('*')) return next();
    if (required.some(p => perms.has(p))) return next();

    return res.status(403).json({
      error: 'Insufficient permissions',
      required,
      have: Array.from(perms).filter(p => p !== '*'),
    });
  };
}
