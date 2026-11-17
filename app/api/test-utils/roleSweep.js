// The app the route × role sweeps run against, and the test doubles they share
// (auth/routeRoleMatrix.test.js, auth/routePermissionTable.test.js).
//
// Sign-in is ON. A bearer token "roles:<r1>,<r2>" decodes to those app roles;
// the role mapping is the shipped seed (Admin / RoleMiner / Servicedesk) plus
// one role per catalog permission, "role-<permission>", granting exactly it.
// The database answers every query with nothing (stageEmptyDb), USE_SQL is on
// so handlers run their production branch, and every feature flag is on so no
// route 404s in front of its permission gate.
//
// Wire the doubles up in the test file (vi.mock is hoisted per file):
//   vi.mock('../config/authConfig.js', async (o) => (await import('../../test-utils/roleSweep.js')).authConfigDouble(await o()));
//   vi.mock('jsonwebtoken', async () => (await import('../../test-utils/roleSweep.js')).rolesTokenDouble);
//   vi.mock('../db/connection.js'); then stageEmptyDb(await import('../db/connection.js'));
//   vi.mock('../middleware/crawlerAuthFailureLimiter.js', async () => (await import('../../test-utils/roleSweep.js')).openFailureLimiterDouble);

import { SEED_ROLE_PERMISSIONS, PERMISSIONS } from '../src/auth/permissions.js';
import { FEATURE_FLAGS } from '../src/featureFlags.js';
import { signInOnConfig } from './authConfigMock.js';

export const ALL_PERMS = Object.keys(PERMISSIONS);
export const roleFor = (perm) => `role-${perm}`;

// Bearer header for a caller holding exactly these app roles.
export const asRoles = (roles) => ({ Authorization: `Bearer roles:${roles.join(',')}` });
// …and for a caller holding exactly these permissions.
export const asPerms = (perms) => asRoles(perms.map(roleFor));

export function authConfigDouble(original) {
  return signInOnConfig(original, {
    ...SEED_ROLE_PERMISSIONS,
    ...Object.fromEntries(ALL_PERMS.map((p) => [roleFor(p), [p]])),
  });
}

// jwt.verify for the synthetic token. Each distinct token is its own user (oid),
// so the per-user rate limiters never pool two callers into one bucket.
export const rolesTokenDouble = {
  default: {
    verify: (token, _key, _opts, cb) => {
      const roles = String(token).startsWith('roles:') ? token.slice('roles:'.length).split(',').filter(Boolean) : [];
      cb(null, { roles, tid: 'test-tenant', oid: `sweep:${token}`, scp: 'Mcp.Read' });
    },
  },
};

// With the manual db mock (src/db/__mocks__/connection.js, vi.mock with no
// factory), answer every query with nothing — a gate refuses before any query,
// and a handler that is let through finds an empty database.
export function stageEmptyDb({ query, queryOne }) {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  queryOne.mockResolvedValue(null);
}

// A sweep sends dozens of user tokens to the crawler routes from one address;
// the pre-hash failure limiter would start answering 429 instead of the 401
// under test. It has its own tests (middleware/crawlerAuthFailureLimiter.test.js).
export const openFailureLimiterDouble = {
  createFailureLimiter: () => ({ isBlocked: () => false, recordFailure: () => {}, size: () => 0 }),
};

const ENV = {
  USE_SQL: 'true',
  // MCP only runs with its public address configured (mcp/resource.js, F-08).
  PUBLIC_BASE_URL: 'https://atlas.example.com',
  // The local model server: a closed port answers at once, where the default
  // host name waits seconds for a lookup that never resolves.
  NL_REPORTS_LLM_URL: 'http://127.0.0.1:9',
  ...Object.fromEntries(Object.values(FEATURE_FLAGS).map((f) => [`FEATURE_${f.key}`, 'true'])),
};

// Set the environment, build the real app and listen on one ephemeral port
// (one server for the whole sweep instead of one per request). `close()` puts
// the environment back, since test files can share a worker.
export async function bootSweepApp() {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  const server = app.listen(0);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { app, server, close };
}
