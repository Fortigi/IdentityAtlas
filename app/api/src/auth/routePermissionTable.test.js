// The committed route → permission table (test-utils/routePermissions.js) is
// complete and exact.
//
// Complete: every route the live router serves has exactly one entry — in the
// table, or among the public / never-data routes pinned in routeSweep.js — and
// the table names no route the app no longer serves. A new route without an
// entry fails here.
//
// Exact, per route, against the real app:
//   - gated  → a caller holding every permission EXCEPT the listed ones is
//     refused 403, and the gate names exactly the listed permissions as
//     required; a caller holding just one listed permission gets in, for each.
//   - ANY    → a caller holding a single permission that grants almost nothing
//     by itself (data.write.certifications: only a business role's composition
//     sign-off) gets in.
//   - CRAWLER_KEY → a user token with every permission is refused 401.
// So the table cannot be wider or narrower than the gate: an extra permission
// fails its allow call, a missing one fails the "required" comparison.

import { describe, it, expect, vi, afterAll } from 'vitest';

vi.mock('../config/authConfig.js', async (o) => (await import('../../test-utils/roleSweep.js')).authConfigDouble(await o()));
vi.mock('jsonwebtoken', async () => (await import('../../test-utils/roleSweep.js')).rolesTokenDouble);
vi.mock('../db/connection.js');
vi.mock('../middleware/crawlerAuthFailureLimiter.js', async () => (await import('../../test-utils/roleSweep.js')).openFailureLimiterDouble);

const { bootSweepApp, stageEmptyDb, asPerms, ALL_PERMS } = await import('../../test-utils/roleSweep.js');
stageEmptyDb(await import('../db/connection.js'));
const { listRoutes, callRoute, PUBLIC_ROUTES, NEVER_DATA, OWN_AUTH } = await import('../../test-utils/routeSweep.js');
const { ROUTE_PERMISSIONS, ANY, CRAWLER_KEY } = await import('../../test-utils/routePermissions.js');

const { app, server, close } = await bootSweepApp();
afterAll(close);

const ROUTES = listRoutes(app);
const SWEPT = ROUTES.filter((r) => !PUBLIC_ROUTES.has(r.key) && !NEVER_DATA.has(r.key));
const refused = (res) => [401, 403].includes(res.status);
// A permission that gates one narrow write only, so holding it alone shows what
// "any permission" reaches.
const INERT = 'data.write.certifications';

describe('the route → permission table is complete', () => {
  const keys = new Set(ROUTES.map((r) => r.key));

  it('every swept route has an entry', () => {
    const missing = SWEPT.filter((r) => !(r.key in ROUTE_PERMISSIONS)).map((r) => r.key);
    expect(missing, 'add these to test-utils/routePermissions.js with the permission they need').toEqual([]);
  });

  it('no entry is stale', () => {
    expect(Object.keys(ROUTE_PERMISSIONS).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('public and never-data routes are not listed twice', () => {
    expect(Object.keys(ROUTE_PERMISSIONS).filter((k) => PUBLIC_ROUTES.has(k) || NEVER_DATA.has(k))).toEqual([]);
  });

  it('every value is a sentinel or a non-empty list of catalog permissions', () => {
    const bad = Object.entries(ROUTE_PERMISSIONS).filter(([, v]) => v !== ANY && v !== CRAWLER_KEY
      && !(Array.isArray(v) && v.length > 0 && v.every((p) => ALL_PERMS.includes(p))));
    expect(bad).toEqual([]);
  });

  it('the probe permission gates nothing but the composition sign-off', () => {
    const gatedOn = Object.entries(ROUTE_PERMISSIONS).filter(([, v]) => Array.isArray(v) && v.includes(INERT)).map(([k]) => k);
    expect(gatedOn).toEqual(['POST /access-package/:id/composition-reviews']);
  });
});

describe('the table is exact — each route opens for its permissions and nothing else', () => {
  it('gated routes: refused without the listed permissions, open with each of them', async () => {
    const wrong = [];
    for (const r of SWEPT) {
      const required = ROUTE_PERMISSIONS[r.key];
      if (!Array.isArray(required)) continue;
      const deny = await callRoute(server, r, asPerms(ALL_PERMS.filter((p) => !required.includes(p))));
      if (OWN_AUTH.has(r.key)) {
        if (!refused(deny)) wrong.push(`${r.key}: open without [${required}] (${deny.status})`);
      } else if (deny.status !== 403) {
        wrong.push(`${r.key}: open without [${required}] (${deny.status})`);
      } else if ([...(deny.body.required || [])].sort().join() !== [...required].sort().join()) {
        wrong.push(`${r.key}: gate requires [${deny.body.required}], table says [${required}]`);
      }
      for (const p of required) {
        const allow = await callRoute(server, r, asPerms([p]));
        if (refused(allow)) wrong.push(`${r.key}: refused with ${p} (${allow.status})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it(`ANY routes: open to a caller whose only permission is ${INERT}`, async () => {
    const wrong = [];
    for (const r of SWEPT.filter((x) => ROUTE_PERMISSIONS[x.key] === ANY)) {
      const res = await callRoute(server, r, asPerms([INERT]));
      if (refused(res)) wrong.push(`${r.key}: ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('crawler-only routes: a user token with every permission is refused 401', async () => {
    const wrong = [];
    const crawlerOnly = SWEPT.filter((x) => ROUTE_PERMISSIONS[x.key] === CRAWLER_KEY);
    expect(crawlerOnly.length).toBeGreaterThan(30);
    for (const r of crawlerOnly) {
      const res = await callRoute(server, r, asPerms(ALL_PERMS));
      if (res.status !== 401) wrong.push(`${r.key}: ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });
});
