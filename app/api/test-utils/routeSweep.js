// Call every route of the real app as one caller — the deny-by-default sweep.
//
// Used by auth/permissionMatrix.test.js (a signed-in caller with no permission)
// and middleware/contextOwnerMode.test.js (context owners and strangers with
// the owner switch on and off). Walking the live router tree means a route
// added tomorrow is swept too; nobody has to remember to list it.

import request from 'supertest';

// Routes that answer any caller, with or without a role. Each describes the app
// itself or the caller, never the crawled data. Pinned exactly: making another
// route public means adding it here, on purpose.
export const PUBLIC_ROUTES = new Map([
  ['GET /api/health', 'liveness probe'],
  ['GET /api/version', 'build version for the dashboard card'],
  ['GET /api/features', 'which features are switched on'],
  ['GET /api/auth-config', 'tenant + client id the sign-in page needs'],
  ['GET /api/openapi.json', 'the published API description'],
  ['GET /api/auth-me', 'describes the caller, so the app can explain "no role"'],
  ['GET /.well-known/oauth-protected-resource,/.well-known/oauth-protected-resource/mcp',
    'OAuth discovery for MCP clients; public by the MCP spec'],
]);

// Routes that never answer with data, whoever asks.
export const NEVER_DATA = new Set([
  'GET *path', // SPA fallback: 404 for an /api path
  'GET /mcp',  // MCP is POST only (405)
]);

// MCP checks its own tokens (mcp/auth.js, tested in mcp/). A caller without a
// permission is refused there with MCP's own error body.
export const OWN_AUTH = new Set(['POST /mcp']);

// Every route of the app as { method, path, key }, in router order. `_all`
// routes are swept as GET.
export function listRoutes(app) {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          const method = m === '_all' ? 'GET' : m.toUpperCase();
          const path = String(layer.route.path);
          out.push({ method, path, key: `${method} ${path}` });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(app.router.stack);
  return out;
}

// A concrete URL for a route pattern: parameters become an all-zero uuid,
// optional segments are dropped, wildcards become one segment, and a path
// mounted under /api gets its prefix back.
export function sweepPath(routePath) {
  const p = String(routePath).split(',')[0]
    .replace(/\{[^}]*\}/g, '')
    .replace(/\*[A-Za-z]+/g, 'x')
    .replace(/:[A-Za-z_]+/g, '00000000-0000-0000-0000-000000000000');
  return /^\/(api|mcp|\.well-known)/.test(p) ? p : `/api${p}`;
}

// Call every route except `skip` with `headers` and return the ones `refused`
// does not accept, as "<status> <METHOD> <pattern>" — an empty list means every
// route refused the caller.
export async function sweepRoutes(app, { headers, skip = new Set(), refused }) {
  const leaked = [];
  for (const r of listRoutes(app)) {
    if (skip.has(r.key)) continue;
    let req = request(app)[r.method.toLowerCase()](sweepPath(r.path)).set(headers);
    if (r.method !== 'GET') req = req.send({});
    const res = await req;
    if (!refused(res, r)) leaked.push(`${res.status} ${r.key}`);
  }
  return leaked;
}
