import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthGate';

function CopyableCommand({ command }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative my-2">
      <pre className="px-3 py-2 pr-16 bg-gray-900 text-gray-100 rounded text-xs font-mono overflow-x-auto whitespace-pre">{command}</pre>
      <button
        onClick={handleCopy}
        className="absolute top-1.5 right-1.5 px-2 py-0.5 text-xs bg-gray-700 text-gray-100 rounded hover:bg-gray-600"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function AuthSettingsPage() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [state, setState] = useState(null);

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/auth-settings');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setState(await r.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [authFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !state) {
    return <div className="text-sm text-gray-500 dark:text-gray-400 p-6">Loading authentication settings...</div>;
  }

  const enabled = state?.enabled === true;
  const tenantId = state?.tenantId || '';
  const clientId = state?.clientId || '';
  const requiredRoles = state?.requiredRoles || [];

  const exampleTenant = tenantId || '<tenant-guid>';
  const exampleClient = clientId || '<client-guid>';
  const enableCmd = `docker compose exec web node /app/backend/src/cli/auth-config.js \\
    enable --tenant ${exampleTenant} \\
           --client ${exampleClient}`;
  const enableWithRolesCmd = `docker compose exec web node /app/backend/src/cli/auth-config.js \\
    enable --tenant ${exampleTenant} \\
           --client ${exampleClient} \\
           --roles IdentityAtlas.Read,IdentityAtlas.Admin`;
  const disableCmd  = `docker compose exec web node /app/backend/src/cli/auth-config.js disable`;
  const statusCmd   = `docker compose exec web node /app/backend/src/cli/auth-config.js status`;
  const restartCmd  = `docker compose restart web`;

  return (
    <div className="space-y-6">
      {/* ─── Current state card ─────────────────────────────── */}
      <div className={`rounded-lg border p-5 ${enabled
        ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700'
        : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700'}`}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Authentication</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {enabled
                ? 'Entra ID SSO is enabled. Users must sign in with their Microsoft account to access the application.'
                : 'Authentication is disabled. Anyone with the URL can access this application.'}
            </p>
          </div>
          <span className={`px-3 py-1 rounded-full text-xs font-semibold ${enabled
            ? 'bg-green-200 dark:bg-green-800 text-green-900 dark:text-green-200'
            : 'bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-200'}`}>
            {enabled ? 'ENABLED' : 'DISABLED'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm bg-white/60 dark:bg-gray-800/60 rounded p-3 border border-gray-200 dark:border-gray-600">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Tenant ID</div>
            <div className="font-mono text-xs mt-0.5 break-all dark:text-gray-200">{tenantId || <span className="text-gray-400 dark:text-gray-500">— not set —</span>}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Client ID</div>
            <div className="font-mono text-xs mt-0.5 break-all dark:text-gray-200">{clientId || <span className="text-gray-400 dark:text-gray-500">— not set —</span>}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Required roles</div>
            <div className="text-xs mt-0.5 dark:text-gray-200">{requiredRoles.length ? requiredRoles.join(', ') : <span className="text-gray-400 dark:text-gray-500">— any signed-in user —</span>}</div>
          </div>
        </div>

        {error && <div className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</div>}
        <button onClick={refresh} className="mt-3 text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300">↻ Refresh</button>
      </div>

      {/* ─── How to change it ──────────────────────────────── */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-3">Changing authentication settings</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          Auth config is intentionally not editable from this page. Allowing it would require leaving an unauthenticated
          mutation endpoint open whenever auth was off — exactly the kind of hole that defeats the point of having auth
          in the first place. Configuration is done via a CLI tool inside the web container, which only the host running
          Docker can reach.
        </p>

        <h4 className="text-sm font-semibold text-gray-900 dark:text-white mt-4 mb-1">Check current settings</h4>
        <CopyableCommand command={statusCmd} />

        <h4 className="text-sm font-semibold text-gray-900 dark:text-white mt-4 mb-1">Enable authentication</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Run this on the host where Docker is running:</p>
        <CopyableCommand command={enableCmd} />
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1 mt-2">Or with required app roles (only users with one of these roles can sign in):</p>
        <CopyableCommand command={enableWithRolesCmd} />

        <h4 className="text-sm font-semibold text-gray-900 dark:text-white mt-4 mb-1">Disable authentication (recovery)</h4>
        <CopyableCommand command={disableCmd} />

        <h4 className="text-sm font-semibold text-gray-900 dark:text-white mt-4 mb-1">Apply changes</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">After any change, restart the web container so the API picks up the new state:</p>
        <CopyableCommand command={restartCmd} />
      </div>

      {/* ─── Setup walkthrough ──────────────────────────────── */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-3">Entra ID app registration walkthrough</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Before running the enable command, register Identity Atlas as an application in your Entra ID tenant.
          You only need to do this once per tenant.
        </p>

        <ol className="space-y-3 text-sm">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-semibold flex items-center justify-center text-xs">1</span>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">Create an App Registration</div>
              <div className="text-gray-600 dark:text-gray-400">
                Go to <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer" className="text-indigo-600 dark:text-indigo-400 underline">Entra ID → App registrations → New registration</a>.
                Name it <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">Identity Atlas</code> (or whatever you prefer).
                Account types: <strong>Accounts in this organizational directory only</strong>.
                Leave the redirect URI empty for now.
              </div>
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-semibold flex items-center justify-center text-xs">2</span>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">Add a Single-Page Application redirect URI</div>
              <div className="text-gray-600 dark:text-gray-400">
                In the new app, go to <strong>Authentication → Add a platform → Single-page application</strong>.
                Add this URI:
              </div>
              <div className="mt-1 flex items-center gap-2">
                <code className="px-2 py-1 bg-gray-100 dark:bg-gray-700 dark:text-gray-200 rounded text-xs font-mono">{currentOrigin}</code>
                <button
                  onClick={() => navigator.clipboard.writeText(currentOrigin)}
                  className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300"
                >Copy</button>
              </div>
              <div className="text-gray-500 dark:text-gray-400 text-xs mt-1">
                If you also access Identity Atlas from another URL (production domain, reverse proxy, etc.),
                add each one as a separate redirect URI in the same Entra app.
              </div>
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-semibold flex items-center justify-center text-xs">3</span>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">Expose an API scope</div>
              <div className="text-gray-600 dark:text-gray-400">
                Go to <strong>Expose an API → Add a scope</strong>. Accept the default Application ID URI
                (<code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded text-xs">api://&lt;client-id&gt;</code>),
                then create a scope named <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">access</code>.
              </div>
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-semibold flex items-center justify-center text-xs">4</span>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">(Optional) Define App roles</div>
              <div className="text-gray-600 dark:text-gray-400">
                If you want to restrict access to specific groups of users, define App roles under <strong>App roles → Create app role</strong>
                {' '}(e.g. <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">IdentityAtlas.Read</code>, <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">IdentityAtlas.Admin</code>),
                then assign them to users via <strong>Enterprise applications → &lt;your app&gt; → Users and groups</strong>.
                Pass the role names to the CLI's <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 px-1 rounded">--roles</code> flag.
              </div>
            </div>
          </li>

          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-semibold flex items-center justify-center text-xs">5</span>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">Run the enable CLI command</div>
              <div className="text-gray-600 dark:text-gray-400">
                Grab the <em>Directory (tenant) ID</em> and <em>Application (client) ID</em> from the app's Overview page,
                then run the enable command above. Restart web. You'll be redirected to Entra at the next page load.
              </div>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}
