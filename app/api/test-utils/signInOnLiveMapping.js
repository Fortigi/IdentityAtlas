// Sign-in ON for an HTTP integration test, with the REAL role → permission
// mapping.
//
// authConfigMock.js's signInOnConfig() pins getRolePermissions() to a fixed
// map, which is right for a suite about scopes but makes the Admin → Roles &
// Permissions save invisible: the route writes the mapping, the middleware never
// reads it. This variant replaces only what the token check needs (sign-in on,
// tenant, client, a non-null JWKS client, no AUTH_REQUIRED_ROLES) and leaves
// getRolePermissions / setRolePermissions / loadAuthConfig real, so a saved
// mapping is what the next request is judged by. With nothing saved, the
// mapping is the built-in seed (Admin = '*', RoleMiner, Servicedesk = data.read).
//
//   vi.mock('../src/config/authConfig.js', async (importOriginal) =>
//     (await import('../test-utils/signInOnLiveMapping.js')).signInOnLiveMapping(await importOriginal()));
//   vi.mock('jsonwebtoken', async () =>
//     (await import('../test-utils/signInOnLiveMapping.js')).claimsAsTokenJwt());

import { randomUUID } from 'crypto';

export const TEST_TENANT = 'test-tenant';

export function signInOnLiveMapping(original) {
  return {
    ...original,
    isAuthEnabled: () => true,
    getTenantId: () => TEST_TENANT,
    getClientId: () => 'test-client',
    getJwksClient: () => ({}),
    getRequiredRoles: () => null,
  };
}

// A jsonwebtoken stand-in where the bearer token IS the claims, base64url JSON.
// Signature checking is covered by middleware/jwtValidation.test.js; a token
// that is not such JSON fails verification, as a forged one would.
export function claimsAsTokenJwt() {
  return {
    default: {
      verify: (token, _key, _opts, cb) => {
        try { cb(null, JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))); } catch (e) { cb(e); }
      },
    },
  };
}

// The Authorization header of a signed-in user holding `roles`. A fresh oid per
// call unless one is given, so per-user rate limiters never pool test requests.
export function bearerFor(roles, { oid = randomUUID(), username = 'tester@live-mapping.test' } = {}) {
  const claims = { oid, roles, tid: TEST_TENANT, preferred_username: username, scp: 'access' };
  return `Bearer ${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
}
