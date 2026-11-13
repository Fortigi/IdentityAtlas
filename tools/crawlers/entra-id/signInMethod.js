// How an Entra crawler signs in to Microsoft Graph, as far as the wizard is
// concerned: with an app registration (client ID + secret) or, in the Azure
// deployment, with the managed identity attached to the deployment — which has
// no secret at all. Pure functions, so each rule is unit-tested without
// rendering anything.

export const CLIENT_SECRET = 'ClientSecret';
export const MANAGED_IDENTITY = 'ManagedIdentity';

// The credentials sent to the discover endpoint for the chosen method.
export function credentialConfig({ authMethod, tenantId, clientId, clientSecret }) {
  if (authMethod === MANAGED_IDENTITY) return { authMethod: MANAGED_IDENTITY };
  return { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

// Whether step 1 holds enough to continue. In edit mode a blank secret means
// "keep the stored one".
export function canSubmitCredentials({ authMethod, crawlerName, tenantId, clientId, clientSecret, isEdit }) {
  if (!crawlerName.trim()) return false;
  if (authMethod === MANAGED_IDENTITY) return true;
  return Boolean(tenantId.trim() && clientId.trim() && (isEdit || clientSecret.trim()));
}

// Editing an app-registration crawler without re-entering its secret leaves the
// browser nothing to validate with. A managed identity can always be checked live.
export function usesStoredCredentials({ authMethod, isEdit, clientSecret }) {
  return authMethod !== MANAGED_IDENTITY && Boolean(isEdit) && !clientSecret.trim();
}

// The sign-in part of the config a save sends. authMethod is always included: a
// save merges into the stored config, so leaving it out would keep whatever
// method the crawler had before. An empty secret in edit mode means "keep the
// stored one"; a managed identity has none.
export function signInConfig({ authMethod, tenantId, clientId, clientSecret }) {
  if (authMethod === MANAGED_IDENTITY) {
    return { authMethod: MANAGED_IDENTITY, tenantId: tenantId.trim() };
  }
  const config = { authMethod: CLIENT_SECRET, tenantId: tenantId.trim(), clientId: clientId.trim() };
  if (clientSecret.trim()) config.clientSecret = clientSecret.trim();
  return config;
}

// Whether the wizard offers the choice at all: only where the deployment has a
// crawler identity, or when the crawler being edited already uses one.
export function offersSignInChoice(managedIdentity, authMethod) {
  return Boolean(managedIdentity?.available) || authMethod === MANAGED_IDENTITY;
}
