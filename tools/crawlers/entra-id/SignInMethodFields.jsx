import { CLIENT_SECRET, MANAGED_IDENTITY, offersSignInChoice } from './signInMethod.js';

const HINT = 'text-xs text-gray-500 dark:text-gray-400';

// The sign-in method choice on step 1 of the Entra wizard, plus the explanation
// shown when a managed identity is chosen. Renders nothing in a deployment
// without a crawler identity, so the wizard looks exactly as it did there.
//
// managedIdentity — { available, clientId } from the discover endpoint, or null
//                   while that is still loading.
export default function SignInMethodFields({ authMethod, onChange, managedIdentity }) {
  if (!offersSignInChoice(managedIdentity, authMethod)) return null;
  const isManagedIdentity = authMethod === MANAGED_IDENTITY;

  return (
    <>
      <fieldset className="mb-4">
        <legend className="block text-sm font-medium mb-1 dark:text-gray-200">Sign-in method</legend>
        <label className="flex items-start gap-2 text-sm py-1 dark:text-gray-200">
          <input type="radio" name="entra-auth-method" className="mt-1" checked={!isManagedIdentity}
            onChange={() => onChange(CLIENT_SECRET)} />
          <span>App registration <span className={HINT}>— a client ID and a client secret you create and renew</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm py-1 dark:text-gray-200">
          <input type="radio" name="entra-auth-method" className="mt-1" checked={isManagedIdentity}
            onChange={() => onChange(MANAGED_IDENTITY)} />
          <span>Managed identity <span className={HINT}>— the identity of this Azure deployment; there is no secret to store, leak or renew</span></span>
        </label>
      </fieldset>
      {isManagedIdentity && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-900 dark:bg-blue-900/20 dark:border-blue-700 dark:text-blue-200">
          {managedIdentity?.available ? (
            <p>
              Identity Atlas signs in as the managed identity of this deployment
              (client ID <span className="font-mono text-xs">{managedIdentity.clientId}</span>) and reads the tenant the deployment runs in.
            </p>
          ) : (
            <p>This deployment has no managed identity for crawlers, so this crawler cannot sign in. Choose App registration, or run Identity Atlas in Azure with the crawler identity enabled.</p>
          )}
          <p className="mt-1 text-xs">
            The identity needs the same Microsoft Graph application permissions as an app registration. Permissions granted to a managed identity can take an hour or more to show up here, because Azure caches its token.
          </p>
        </div>
      )}
    </>
  );
}
