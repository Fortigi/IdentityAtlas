import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { PublicClientApplication } from '@azure/msal-browser';

const AuthContext = createContext({
  authFetch: (url, options) => fetch(url, options),
  account: null,
  logout: () => {},
  authEnabled: true,
});

export function useAuth() {
  return useContext(AuthContext);
}

export default function AuthGate({ children }) {
  const [state, setState] = useState({ phase: 'loading', error: null });
  const msalRef = useRef(null);
  const configRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const res = await fetch('/api/auth-config');
        const config = await res.json();
        configRef.current = config;

        if (!config.enabled) {
          if (!cancelled) setState({ phase: 'ready', error: null });
          return;
        }

        const pca = new PublicClientApplication({
          auth: {
            clientId: config.clientId,
            authority: `https://login.microsoftonline.com/${config.tenantId}`,
            redirectUri: window.location.origin,
          },
          cache: { cacheLocation: 'sessionStorage' },
        });

        await pca.initialize();
        msalRef.current = pca;

        // Handle redirect return (user coming back from Entra ID login)
        const response = await pca.handleRedirectPromise();
        if (response) {
          pca.setActiveAccount(response.account);
        }

        const accounts = pca.getAllAccounts();
        if (accounts.length === 0) {
          // Not signed in - redirect to Entra ID
          await pca.loginRedirect({
            scopes: [`api://${config.clientId}/access`],
          });
          return; // Page will redirect
        }

        pca.setActiveAccount(accounts[0]);
        if (!cancelled) setState({ phase: 'ready', error: null });
      } catch (err) {
        if (!cancelled) setState({ phase: 'error', error: err.message });
      }
    }

    init();
    return () => { cancelled = true; };
  }, []);

  const getToken = useCallback(async () => {
    const pca = msalRef.current;
    const config = configRef.current;
    if (!config?.enabled || !pca) return null;

    try {
      const result = await pca.acquireTokenSilent({
        scopes: [`api://${config.clientId}/access`],
        account: pca.getActiveAccount(),
      });
      return result.accessToken;
    } catch {
      // Silent token acquisition failed - need interactive
      await pca.acquireTokenRedirect({
        scopes: [`api://${config.clientId}/access`],
      });
      return null;
    }
  }, []);

  const authFetch = useCallback(async (url, options = {}) => {
    const token = await getToken();
    const headers = { ...options.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { ...options, headers });
  }, [getToken]);

  const logout = useCallback(async () => {
    const pca = msalRef.current;
    if (pca) {
      await pca.logoutRedirect();
    }
  }, []);

  if (state.phase === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">Initializing...</div>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md">
          <h2 className="text-red-800 font-semibold text-lg">Authentication Error</h2>
          <p className="text-red-600 mt-2 text-sm">{state.error}</p>
        </div>
      </div>
    );
  }

  const account = msalRef.current?.getActiveAccount() || null;
  const authEnabled = configRef.current?.enabled !== false;

  return (
    <AuthContext.Provider value={{ authFetch, account, logout, authEnabled }}>
      {!authEnabled && (
        <div className="bg-amber-400 text-amber-900 text-sm font-medium px-4 py-2 flex items-center gap-2 sticky top-0 z-50">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          Authentication is disabled — anyone with the URL can access this application
        </div>
      )}
      {children}
    </AuthContext.Provider>
  );
}
