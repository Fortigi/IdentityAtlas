import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { PublicClientApplication } from '@azure/msal-browser';

const AuthContext = createContext({
  authFetch: () => Promise.reject(new Error('AuthContext not initialized')),
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

        // Auth is enabled but the Entra app hasn't been wired up yet — show
        // a friendly setup-required page instead of trying to sign in with
        // empty credentials. This is the post-Step-1 state on Azure.
        if (config.configured === false) {
          if (!cancelled) setState({ phase: 'setup-required', error: null, config });
          return;
        }

        // Validate tenant ID before embedding in the authority URL — prevents
        // open-redirect/SSRF if the server were to return an unexpected value.
        const TENANT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-z0-9][a-z0-9-]*\.[a-z]{2,}$/i;
        if (!config.tenantId || !TENANT_RE.test(config.tenantId)) {
          throw new Error('Invalid tenant configuration received from server');
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
          <p className="text-red-700 mt-2 text-sm">{state.error}</p>
        </div>
      </div>
    );
  }

  if (state.phase === 'setup-required') {
    return <AuthSetupRequired platform={state.config.platform} />;
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

// Rendered after Step 1 of the Azure walkthrough when the deployment has
// AUTH_ENABLED=true but the Entra tenant + client IDs are still empty. We
// deliberately don't fall back to "open mode" here — the goal is a state
// that can't be used without the customer completing setup.
function AuthSetupRequired({ platform }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const isAzure = platform === 'azure-app-service';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-10 px-4">
      <div className="max-w-3xl mx-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm">
        <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-start gap-3">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Entra ID setup required</h1>
            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
              This Identity Atlas deployment is configured to require Entra ID sign-in but the App Registration hasn't been linked yet.
              Complete the steps below to enable sign-in.
            </p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-6 text-sm">
          <section>
            <h2 className="font-semibold text-gray-900 dark:text-white mb-2">Step 1 — Register an App in Entra ID</h2>
            <ol className="space-y-2 text-gray-700 dark:text-gray-300 list-decimal list-inside">
              <li>Open the Azure portal → search <strong>Entra ID</strong> → <strong>App registrations</strong> → <strong>+ New registration</strong>.</li>
              <li>
                Name it <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">Identity Atlas</code>,
                pick <strong>Accounts in this organizational directory only (Single tenant)</strong>.
              </li>
              <li>
                Under <strong>Redirect URI</strong>, pick <strong>Single-page application (SPA)</strong> and paste:
                <div className="mt-1 flex items-center gap-2">
                  <code className="px-2 py-1 bg-gray-100 dark:bg-gray-700 dark:text-gray-200 rounded text-xs font-mono break-all">{origin}</code>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(origin)}
                    className="text-xs text-indigo-700 dark:text-indigo-400 hover:underline shrink-0"
                  >
                    Copy
                  </button>
                </div>
              </li>
              <li>Click <strong>Register</strong>.</li>
            </ol>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 dark:text-white mb-2">Step 2 — Expose the API scope</h2>
            <ol className="space-y-2 text-gray-700 dark:text-gray-300 list-decimal list-inside">
              <li>On the new app, click <strong>Expose an API</strong> → next to <strong>Application ID URI</strong>, click <strong>Add</strong> → accept the default <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded text-xs">api://&lt;client-id&gt;</code> → <strong>Save</strong>.</li>
              <li>
                Click <strong>+ Add a scope</strong> with these values:
                <ul className="ml-5 mt-1 list-disc list-inside text-xs">
                  <li>Scope name: <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">access</code></li>
                  <li>Who can consent: <strong>Admins and users</strong></li>
                  <li>Admin/User consent display name: <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">Access Identity Atlas</code></li>
                  <li>State: <strong>Enabled</strong></li>
                </ul>
              </li>
            </ol>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 dark:text-white mb-2">Step 3 — Copy the IDs</h2>
            <p className="text-gray-700 dark:text-gray-300">
              Go to the app's <strong>Overview</strong> page and copy both:
            </p>
            <ul className="ml-5 mt-1 list-disc list-inside text-gray-700 dark:text-gray-300">
              <li><strong>Directory (tenant) ID</strong></li>
              <li><strong>Application (client) ID</strong></li>
            </ul>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 dark:text-white mb-2">
              Step 4 — {isAzure ? 'Add the IDs to this Web App' : 'Add the IDs to your environment'}
            </h2>
            {isAzure ? (
              <ol className="space-y-2 text-gray-700 dark:text-gray-300 list-decimal list-inside">
                <li>Open the Azure portal → this Web App's <strong>Environment variables</strong> page (under <strong>Settings</strong>).</li>
                <li>
                  Set the existing variables (don't create new ones — they're already there, just empty):
                  <ul className="ml-5 mt-1 list-disc list-inside text-xs">
                    <li><code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">AUTH_TENANT_ID</code> = your tenant ID</li>
                    <li><code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">AUTH_CLIENT_ID</code> = your client ID</li>
                  </ul>
                </li>
                <li>Click <strong>Apply</strong>. The Web App restarts automatically (~30 seconds).</li>
                <li>Once restarted, click <strong>Reload</strong> below — you'll be redirected to Entra to sign in.</li>
              </ol>
            ) : (
              <ol className="space-y-2 text-gray-700 dark:text-gray-300 list-decimal list-inside">
                <li>
                  In your environment (Docker compose <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">.env</code> file
                  or the host's process env), set <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">AUTH_TENANT_ID</code> and{' '}
                  <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">AUTH_CLIENT_ID</code>.
                </li>
                <li>Restart the web container so it picks up the new values.</li>
                <li>Once restarted, click <strong>Reload</strong> below.</li>
              </ol>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600"
            >
              Reload
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
