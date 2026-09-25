// End-to-end permission-enforcement matrix.
//
// For EVERY gated permission in the catalog this drives the real Express app
// (via supertest) and asserts the representative endpoint:
//   - ALLOW: a caller holding that permission is NOT 403'd, and
//   - DENY : a caller holding every OTHER permission IS 403'd.
//
// Plus a completeness guard: every key in PERMISSIONS must be classified in
// permissionManifest.js (gated / implicit / reserved). Adding a permission to
// the catalog without classifying + testing it fails CI here.
//
// Auth is mocked at the boundary (no real Entra tokens, no DB): jwt.verify
// decodes a synthetic "roles:<r1,r2>" bearer into a roles claim; authConfig
// reports auth-enabled with a synthetic role→permission mapping (one dedicated
// role per catalog permission); the DB layer returns benign empties so allowed
// requests reach the handler and resolve to something other than 403.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { PERMISSIONS } from './permissions.js';
import { GATED_ENDPOINTS, IMPLICIT_PERMISSIONS, RESERVED_PERMISSIONS } from './permissionManifest.js';

// Feature-flagged routes 404 before their permission gate while the flag is off
// (featureFlags.js requireFeature). This test is about the permission gate, so
// the flags those representative endpoints sit behind start on.
process.env.FEATURE_MATRIX_SHARING = 'true';

const ALL_PERMS = Object.keys(PERMISSIONS);
const roleFor = (perm) => `role-${perm}`;
// Synthetic mapping: one role per permission, granting exactly that permission.
const TEST_MAPPING = Object.fromEntries(ALL_PERMS.map((p) => [roleFor(p), [p]]));

// ── Mocks (hoisted by vitest) ───────────────────────────────────────────────
vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: () => true,
  getJwksClient: () => ({}),
  getTenantId: () => 'test-tenant',
  getClientId: () => 'test-client',
  getRequiredRoles: () => null,
  getRolePermissions: () => TEST_MAPPING,
  hasCustomRolePermissions: () => false,
  setRolePermissions: async () => TEST_MAPPING,
  getAuthState: () => ({ enabled: true, tenantId: 'test-tenant', clientId: 'test-client' }),
  loadAuthConfig: async () => {},
  reloadAuthConfig: async () => {},
}));

// jwt.verify(token, keyResolver, options, callback) — decode our synthetic token.
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: (token, _key, _opts, cb) => {
      const roles =
        typeof token === 'string' && token.startsWith('roles:')
          ? token.slice('roles:'.length).split(',').filter(Boolean)
          : [];
      cb(null, { roles, tid: 'test-tenant' });
    },
  },
}));

// A read token that the store accepts, so a request the path guard lets
// through reaches routing instead of stopping at the token lookup.
vi.mock('./readTokens.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findActiveByPlaintext: async () => ({ id: 1, name: 'matrix-test' }),
}));

// Never touch a real Postgres. Deny happens before the handler; allow may query.
vi.mock('../db/connection.js', () => {
  const empty = { rows: [], rowCount: 0 };
  // Native pg pool double — handlers query through pool.query / db.query (#663).
  const pool = { query: async () => empty };
  return {
    query: async () => empty,
    queryOne: async () => null,
    tx: async (fn) => fn(pool),
    getPool: async () => pool,
    closePool: async () => {},
  };
});

const { createApp } = await import('../app.js');
const app = createApp();

// Bearer header for a token that resolves to exactly `perms`.
const bearer = (perms) => `Bearer roles:${perms.map(roleFor).join(',')}`;

function call(app, { method, path, body }, authHeader) {
  let req = request(app)[method.toLowerCase()](path);
  if (authHeader) req = req.set('Authorization', authHeader);
  if (body !== undefined) req = req.send(body);
  return req;
}

describe('permission enforcement matrix — each gated permission gates ONLY its own endpoint', () => {
  for (const [perm, ep] of Object.entries(GATED_ENDPOINTS)) {
    const label = `${ep.method} ${ep.path}`;

    it(`${perm}: DENY (403) when the caller has every permission EXCEPT ${perm}`, async () => {
      const others = ALL_PERMS.filter((p) => p !== perm);
      const res = await call(app, ep, bearer(others));
      expect(res.status, `${label} must 403 without ${perm}`).toBe(403);
      // And the 403 must be the permission gate, not an auth error.
      expect(res.body?.required, `${label} 403 should report the missing permission`).toContain(perm);
    });

    it(`${perm}: ALLOW (not 403) when the caller holds ${perm}`, async () => {
      const res = await call(app, ep, bearer([perm]));
      expect(res.status, `${label} must NOT 403 with ${perm} (got ${res.status})`).not.toBe(403);
    });
  }
});

describe('data.read is enforced as authentication-required (implicit, not a requirePermission gate)', () => {
  const probe = IMPLICIT_PERMISSIONS['data.read'].probe;
  it('401 for an unauthenticated request', async () => {
    const res = await call(app, probe, undefined);
    expect(res.status).toBe(401);
  });
  it('reachable (not 401/403) for a signed-in caller with data.read', async () => {
    const res = await call(app, probe, bearer(['data.read']));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('catalog completeness — every permission checkbox is classified and covered', () => {
  const classified = [
    ...Object.keys(GATED_ENDPOINTS),
    ...Object.keys(IMPLICIT_PERMISSIONS),
    ...Object.keys(RESERVED_PERMISSIONS),
  ];
  const classifiedSet = new Set(classified);

  for (const perm of ALL_PERMS) {
    it(`${perm} is classified (gated, implicit, or reserved)`, () => {
      expect(
        classifiedSet.has(perm),
        `Permission "${perm}" is in the catalog but missing from permissionManifest.js. ` +
          'Add it to GATED_ENDPOINTS (with a representative route + test), IMPLICIT_PERMISSIONS, or RESERVED_PERMISSIONS.'
      ).toBe(true);
    });
  }

  it('the manifest references no unknown permissions', () => {
    for (const perm of classified) {
      expect(PERMISSIONS, `manifest references unknown permission "${perm}"`).toHaveProperty(perm);
    }
  });

  it('each permission is classified in exactly one bucket', () => {
    const counts = {};
    for (const p of classified) counts[p] = (counts[p] || 0) + 1;
    for (const [p, n] of Object.entries(counts)) {
      expect(n, `permission "${p}" appears in more than one manifest bucket`).toBe(1);
    }
  });
});

describe('wildcard semantics & fail-closed default (security finding C-01)', () => {
  it('FAILS CLOSED: a signed-in user whose roles map to NO permissions is denied (403), not granted admin', async () => {
    // No recognised roles → resolvePermissions() is empty → DENY. There is no
    // "no roles -> '*'" fallback any more (C-01 fix). A roleless token must not
    // reach an admin endpoint.
    const res = await call(app, GATED_ENDPOINTS['admin.auth'], 'Bearer roles:totally-unmapped-role');
    expect(res.status).toBe(403);
  });

  it('a roleless token is denied on EVERY gated endpoint', async () => {
    for (const ep of Object.values(GATED_ENDPOINTS)) {
      const res = await call(app, ep, 'Bearer roles:totally-unmapped-role');
      expect(res.status, `${ep.method} ${ep.path} must 403 for a roleless caller`).toBe(403);
    }
  });

  it('a role mapped to "*" passes every gate', async () => {
    // Build a token whose (synthetic) role grants '*' by reusing the real
    // resolver: a role that maps to '*' is expanded to all permissions.
    // We simulate it via a caller holding every catalog permission, which is
    // the non-wildcard equivalent the gates accept.
    for (const ep of Object.values(GATED_ENDPOINTS)) {
      const res = await call(app, ep, bearer(ALL_PERMS));
      expect(res.status, `${ep.method} ${ep.path} should pass for an all-permissions caller`).not.toBe(403);
    }
  });
});

// ── Route inventory: no authentication-only /admin/* route (SEC-2026-09 M-01) ──
// Walks the real app's router tree. A route is "gated" when a permissionGate
// (the function requirePermission returns) sits in its own handler chain, or
// earlier in an enclosing router's stack (router.use(gate)).
function collectRoutes(stack, inheritedGate = false, out = []) {
  let gated = inheritedGate;
  for (const layer of stack) {
    if (layer.route) {
      const own = layer.route.stack.some((h) => h.name === 'permissionGate');
      for (const m of Object.keys(layer.route.methods)) {
        out.push({ method: m.toUpperCase(), path: String(layer.route.path), gated: gated || own });
      }
    } else if (layer.handle?.stack) {
      collectRoutes(layer.handle.stack, gated, out);
    } else if (layer.name === 'permissionGate') {
      gated = true;
    }
  }
  return out;
}

describe('route inventory — every /admin/* route carries a permission gate', () => {
  const routes = collectRoutes(app.router.stack);

  it('finds the admin routes (the walker sees the real router tree)', () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /admin/dashboard-stats');
    expect(paths).toContain('GET /admin/roles');
  });

  it('no /admin/* route is authentication-only', () => {
    const ungated = routes
      .filter((r) => r.path.toLowerCase().startsWith('/admin/') && !r.gated)
      .map((r) => `${r.method} ${r.path}`);
    expect(ungated).toEqual([]);
  });
});

// ── Read tokens and path casing (SEC-2026-09 M-01) ──────────────────────────
const READ_TOKEN = 'Bearer fgr_matrixtestmatrixtestmatrixtest';

describe('read tokens are refused on /api/admin/* whatever the path casing', () => {
  for (const path of [
    '/api/admin/dashboard-stats',
    '/api/ADMIN/dashboard-stats',
    '/api/Admin/dashboard-stats',
    '/api/aDmIn/updates/log',
    '/api/Admin/roles?x=1',
  ]) {
    it(`GET ${path} → 403 from the read-token admin guard`, async () => {
      const res = await call(app, { method: 'GET', path }, READ_TOKEN);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Read API keys cannot access admin endpoints');
    });
  }

  it('a read token is refused on the performance request log (SEC-2026-09 L-02)', async () => {
    for (const path of ['/api/perf', '/api/perf/recent', '/api/perf/slow', '/api/perf/export']) {
      const res = await call(app, { method: 'GET', path }, READ_TOKEN);
      expect(res.status, path).toBe(403);
      expect(res.body.error, path).toBe('Read API keys cannot access this endpoint');
    }
  });

  it('a read token still reaches a non-admin run-history read (not 401/403)', async () => {
    const res = await call(app, { method: 'GET', path: '/api/risk-scoring/runs' }, READ_TOKEN);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('a crawler key is still refused on an admin path in any casing', async () => {
    const res = await call(app, { method: 'GET', path: '/api/Admin/dashboard-stats' }, 'Bearer fgc_matrixtest');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Crawler API keys are not valid for this endpoint');
  });

  it('a crawler key on a crawler path in another casing is handed on to crawler auth', async () => {
    const res = await call(app, { method: 'GET', path: '/api/Crawlers/whoami' }, 'Bearer fgc_matrixtest');
    expect(res.body.error).not.toBe('Crawler API keys are not valid for this endpoint');
  });
});

// Reads that used to be authentication-only. Each row: the route, a permission
// set that must be let through (the audience of the screen that renders it),
// and one that must be refused.
const NEWLY_GATED_READS = [
  { path: '/api/admin/dashboard-stats',      allow: ['admin.crawlers'],        deny: null },
  { path: '/api/admin/dashboard-timeseries', allow: ['data.read'],             deny: null },
  { path: '/api/admin/risk-profile',         allow: ['admin.crawlers'],        deny: ['data.read', 'admin.systems'] },
  { path: '/api/admin/classifiers',          allow: ['admin.llm'],             deny: ['data.read', 'admin.systems'] },
  { path: '/api/admin/history-retention',    allow: ['admin.systems'],         deny: ['data.read', 'admin.crawlers'] },
  { path: '/api/admin/updates/status',       allow: ['admin.systems'],         deny: ['data.read', 'admin.crawlers'] },
  { path: '/api/admin/updates/log',          allow: ['admin.systems'],         deny: ['data.read', 'admin.crawlers'] },
  { path: '/api/updates/intent',             allow: ['data.read'],             deny: null },
  { path: '/api/risk-scoring/runs',          allow: ['data.read'],             deny: null },
  { path: '/api/risk-scoring/runs/1',        allow: ['admin.llm'],             deny: null },
  { path: '/api/context-plugins/runs',       allow: ['data.read'],             deny: null },
  { path: '/api/context-plugins/runs/00000000-0000-0000-0000-000000000000', allow: ['data.write.tags'], deny: null },
  { path: '/api/account-linking/runs',       allow: ['data.read'],             deny: null },
  { path: '/api/account-linking/runs/1',     allow: ['data.read'],             deny: null },
  { path: '/api/account-linking/config',     allow: ['admin.crawlers'],        deny: ['data.read', 'admin.systems'] },
  // SEC-2026-09 L-02 — the Performance tab's request log.
  { path: '/api/perf',                       allow: ['data.read'],             deny: null },
  { path: '/api/perf/recent',                allow: ['admin.llm'],             deny: null },
  { path: '/api/perf/slow',                  allow: ['data.read'],             deny: null },
  { path: '/api/perf/export',                allow: ['data.share'],            deny: null },
];

describe('formerly authentication-only reads now carry a permission gate', () => {
  for (const { path, allow, deny } of NEWLY_GATED_READS) {
    it(`GET ${path}: a signed-in user whose roles map to nothing is refused (403)`, async () => {
      const res = await call(app, { method: 'GET', path }, 'Bearer roles:totally-unmapped-role');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient permissions');
    });

    it(`GET ${path}: allowed for [${allow}]`, async () => {
      const res = await call(app, { method: 'GET', path }, bearer(allow));
      expect(res.status).not.toBe(403);
    });

    if (deny) {
      it(`GET ${path}: refused for [${deny}]`, async () => {
        const res = await call(app, { method: 'GET', path }, bearer(deny));
        expect(res.status).toBe(403);
      });
    }
  }

  it('the gate follows Express\'s case-insensitive routing (zero-role on /api/ADMIN/…)', async () => {
    const res = await call(app, { method: 'GET', path: '/api/ADMIN/updates/status' }, 'Bearer roles:totally-unmapped-role');
    expect(res.status).toBe(403);
  });
});

describe('asking a question and building a report are separate rights', () => {
  // The whole point of data.read.reports existing alongside data.write.reports:
  // a pilot manager should be able to ask the model a question without also
  // being able to create and delete the saved reports every analyst sees. The
  // matrix above proves each permission gates its ONE representative route;
  // this proves the split holds across the routes the Ask page actually calls.
  process.env.FEATURE_CUSTOM_REPORTS = 'true';

  const ASKING = [
    { method: 'POST', path: '/api/nl-reports/interpret', body: { question: 'who owns Finance?' } },
    { method: 'POST', path: '/api/nl-reports/run', body: { spec: { entity: 'group', conditions: [] } } },
    { method: 'GET', path: '/api/nl-reports/status' },
  ];
  const BUILDING = [
    { method: 'POST', path: '/api/nl-reports/saved', body: { name: 'x' } },
    { method: 'DELETE', path: '/api/nl-reports/saved/00000000-0000-0000-0000-000000000000' },
  ];

  for (const ep of ASKING) {
    it(`${ep.method} ${ep.path} is allowed by asking alone`, async () => {
      const res = await call(app, ep, bearer(['data.read.reports']));
      expect(res.status).not.toBe(403);
    });

    it(`${ep.method} ${ep.path} is refused to someone who may only BUILD`, async () => {
      // The discriminating half. Building does not imply asking — if it did,
      // the read permission would be decorative.
      const res = await call(app, ep, bearer(['data.write.reports']));
      expect(res.status).toBe(403);
    });
  }

  for (const ep of BUILDING) {
    it(`${ep.method} ${ep.path} is still refused to someone who may only ASK`, async () => {
      // The other direction, which is the one that protects the saved reports.
      const res = await call(app, ep, bearer(['data.read.reports']));
      expect(res.status).toBe(403);
    });
  }

  it('warming the model stays with the analysts who were already allowed to spend it', async () => {
    // One model server, one slot, shared by everyone. Warming it is a
    // resource action, so it did not move with the read routes.
    expect((await call(app, { method: 'POST', path: '/api/nl-reports/warm' }, bearer(['data.read.reports']))).status).toBe(403);
    expect((await call(app, { method: 'POST', path: '/api/nl-reports/warm' }, bearer(['data.write.reports']))).status).not.toBe(403);
  });
});
