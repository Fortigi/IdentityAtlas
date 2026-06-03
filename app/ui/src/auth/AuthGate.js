import { createContext, useContext } from 'react';

export const AuthContext = createContext({
  authFetch: () => Promise.reject(new Error('AuthContext not initialized')),
  account: null,
  logout: () => {},
  authEnabled: true,
  // Permission state — populated by AuthGateProvider after sign-in by calling
  // /api/auth-me. See auth/usePermissions.js for the hooks that consume this.
  permissions: null,      // Set<string> — without the '*' sentinel
  roles: [],              // string[] — JWT roles claim
  hasWildcard: true,      // backwards-compat: pre-load + auth-disabled both
                          // return hasWildcard=true so the UI renders normally.
  permissionsLoaded: false, // false until /api/auth-me responds
  refreshPermissions: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}
