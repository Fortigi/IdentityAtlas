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
  // The signed-in user mapped onto the crawled data — see api/auth/resolveMe.js.
  // { principal, identity, matchedOn, photo } or null when auth is off, nothing
  // matched, or no crawl has run yet. Consumers must treat null as normal.
  me: null,
  refreshPermissions: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}
