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
} from '../config/authConfig.js';
import { isReadTokenFormat, findActiveByPlaintext } from '../auth/readTokens.js';

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

  // Crawler API keys start with 'fgc_'. Skip JWT validation and let the
  // request fall through to the crawler auth middleware which handles these.
  if (token.startsWith('fgc_')) {
    return next();
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

    // Optional app-role gate
    const requiredRoles = getRequiredRoles();
    if (requiredRoles && requiredRoles.length > 0) {
      const tokenRoles = decoded.roles || [];
      if (!requiredRoles.some(r => tokenRoles.includes(r))) {
        console.error(`Token missing required role. Has: [${tokenRoles.join(', ')}], needs one of: [${requiredRoles.join(', ')}]`);
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
    }

    req.user = decoded;
    next();
  });
}
