// The auth configuration an HTTP integration test runs under: sign-in ON, a
// fixed tenant and client, no AUTH_REQUIRED_ROLES, and the role → permission
// mapping the test passes. Every other export stays the real one, so nothing is
// accidentally undefined.
//
//   vi.mock('../src/config/authConfig.js', async (importOriginal) =>
//     (await import('../test-utils/authConfigMock.js')).signInOnConfig(await importOriginal(), { 'role-admin': ['*'] }));

export function signInOnConfig(original, rolePermissions) {
  return {
    ...original,
    isAuthEnabled: () => true,
    getTenantId: () => 'test-tenant',
    getClientId: () => 'test-client',
    getJwksClient: () => ({}),
    getRequiredRoles: () => null,
    getRolePermissions: () => rolePermissions,
  };
}
