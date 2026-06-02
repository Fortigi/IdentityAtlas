import { createContext, useContext } from 'react';

export const AuthContext = createContext({
  authFetch: () => Promise.reject(new Error('AuthContext not initialized')),
  account: null,
  logout: () => {},
  authEnabled: true,
});

export function useAuth() {
  return useContext(AuthContext);
}
