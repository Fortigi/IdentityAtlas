// Every route × every built-in role, against the committed table.
//
// For each role the app ships with (SEED_ROLE_PERMISSIONS — Admin's wildcard
// included) this calls every route of the real app as a signed-in member of
// that role and compares the answer with what test-utils/routePermissions.js
// says the route requires:
//   - allowed  → anything but 401/403 (the handler was reached; with an empty
//     database that can be a 200, 400, 404, …),
//   - refused  → 403 from the permission gate, or 401 for a crawler-only route.
// The expectation comes from the table, never from the middleware under test,
// so a gate that drifts — a route that loses its gate, or gains the wrong one —
// shows up as a mismatch for the role it wrongly opens or closes.
//
// That the seed itself is what it should be is pinned in permissions.test.js;
// that the table is complete and exact per permission is
// routePermissionTable.test.js.

import { describe, it, expect, vi, afterAll } from 'vitest';
import { SEED_ROLE_PERMISSIONS } from './permissions.js';

vi.mock('../config/authConfig.js', async (o) => (await import('../../test-utils/roleSweep.js')).authConfigDouble(await o()));
vi.mock('jsonwebtoken', async () => (await import('../../test-utils/roleSweep.js')).rolesTokenDouble);
vi.mock('../db/connection.js');
vi.mock('../middleware/crawlerAuthFailureLimiter.js', async () => (await import('../../test-utils/roleSweep.js')).openFailureLimiterDouble);

const { bootSweepApp, stageEmptyDb, asRoles } = await import('../../test-utils/roleSweep.js');
stageEmptyDb(await import('../db/connection.js'));
const { listRoutes, callRoute, PUBLIC_ROUTES, NEVER_DATA } = await import('../../test-utils/routeSweep.js');
const { ROUTE_PERMISSIONS, ANY, CRAWLER_KEY } = await import('../../test-utils/routePermissions.js');

const { app, server, close } = await bootSweepApp();
afterAll(close);

// What the table says a caller holding `perms` gets on a route.
function expectedFor(required, perms) {
  if (required === CRAWLER_KEY) return 'refused';
  if (perms.has('*')) return 'allowed';
  if (required === ANY) return perms.size > 0 ? 'allowed' : 'refused';
  return required.some((p) => perms.has(p)) ? 'allowed' : 'refused';
}

function observed(res) {
  return [401, 403].includes(res.status) ? 'refused' : 'allowed';
}

// The refusal must be the right one: a crawler-only route turns a user token
// away at crawler auth (401); every other route at a permission gate (403).
function rightRefusal(required, res) {
  return required === CRAWLER_KEY ? res.status === 401 : res.status === 403;
}

const SWEPT = listRoutes(app).filter((r) => !PUBLIC_ROUTES.has(r.key) && !NEVER_DATA.has(r.key));

async function sweepRole(roleName) {
  const perms = new Set(SEED_ROLE_PERMISSIONS[roleName]);
  const mismatches = [];
  const tally = { allowed: 0, refused: 0 };
  for (const r of SWEPT) {
    const required = ROUTE_PERMISSIONS[r.key];
    // Missing entries are reported by routePermissionTable.test.js.
    if (required === undefined) continue;
    const want = expectedFor(required, perms);
    const res = await callRoute(server, r, asRoles([roleName]));
    const got = observed(res);
    tally[got]++;
    if (got !== want || (want === 'refused' && !rightRefusal(required, res))) {
      mismatches.push(`${r.key}: expected ${want}, got ${res.status}`);
    }
  }
  return { mismatches, tally };
}

describe('the expectation rule', () => {
  // The rule the sweep is judged by, on inputs where each branch decides.
  it('a crawler-only route refuses everyone, the wildcard too', () => {
    expect(expectedFor(CRAWLER_KEY, new Set(['*']))).toBe('refused');
  });
  it('the wildcard opens a gated route it does not name', () => {
    expect(expectedFor(['admin.auth'], new Set(['*']))).toBe('allowed');
  });
  it('an any-permission route opens for one unrelated permission and refuses none', () => {
    expect(expectedFor(ANY, new Set(['data.write.certifications']))).toBe('allowed');
    expect(expectedFor(ANY, new Set())).toBe('refused');
  });
  it('a gated route opens for any one of its permissions, and only those', () => {
    expect(expectedFor(['admin.crawlers', 'admin.llm'], new Set(['data.read', 'admin.llm']))).toBe('allowed');
    expect(expectedFor(['admin.crawlers', 'admin.llm'], new Set(['data.read', 'admin.systems']))).toBe('refused');
  });
});

describe('route × built-in role — every route answers each shipped role as the table says', () => {
  it('the sweep covers the whole app', () => {
    expect(SWEPT.length).toBeGreaterThan(300);
  });

  it('Admin (wildcard) reaches every route except the crawler-only ones', async () => {
    const { mismatches, tally } = await sweepRole('Admin');
    expect(mismatches).toEqual([]);
    const crawlerOnly = Object.values(ROUTE_PERMISSIONS).filter((v) => v === CRAWLER_KEY).length;
    expect(tally.refused).toBe(crawlerOnly);
  });

  it('RoleMiner reaches exactly the routes its permissions open', async () => {
    const { mismatches, tally } = await sweepRole('RoleMiner');
    expect(mismatches).toEqual([]);
    // Discriminating: it is refused admin routes and still opens gated ones.
    expect(tally.refused).toBeGreaterThan(Object.values(ROUTE_PERMISSIONS).filter((v) => v === CRAWLER_KEY).length);
  });

  it('Servicedesk (read only) reaches the read surface and nothing it is not given', async () => {
    const { mismatches, tally } = await sweepRole('Servicedesk');
    expect(mismatches).toEqual([]);
    expect(tally.allowed).toBeGreaterThan(100);
    expect(tally.refused).toBeGreaterThan(100);
  });

  it('every shipped role is swept — a new seed role needs a line above', () => {
    expect(Object.keys(SEED_ROLE_PERMISSIONS).sort()).toEqual(['Admin', 'RoleMiner', 'Servicedesk']);
  });

  it('Servicedesk and RoleMiner differ where their permissions differ', async () => {
    // A route only RoleMiner may use (sharing) and one neither may (crawler admin).
    const share = SWEPT.find((r) => r.key === 'GET /matrix/shares');
    const crawlers = SWEPT.find((r) => r.key === 'GET /admin/crawlers');
    expect((await callRoute(server, share, asRoles(['RoleMiner']))).status).not.toBe(403);
    expect((await callRoute(server, share, asRoles(['Servicedesk']))).status).toBe(403);
    expect((await callRoute(server, crawlers, asRoles(['RoleMiner']))).status).toBe(403);
  });
});
