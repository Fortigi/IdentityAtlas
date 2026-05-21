// Identity Atlas — Azure deployment, STEP 2 of 2.
//
// Layers Entra ID single sign-on onto an existing Step-1 deployment.
// Does NOT touch Postgres, Key Vault, storage, Container Apps, or any other
// resource — just updates three app settings on the App Service and lets
// the platform restart it. Takes about a minute to apply.
//
// Required before running this:
//   1. Run Step 1 (main.bicep) to deploy the app stack. You'll get a
//      hostname like https://<namePrefix>-web.azurewebsites.net.
//   2. In Entra ID, register an App Registration whose SPA redirect URI
//      matches that hostname. Expose an API scope named `access` with the
//      default Application ID URI `api://<client-id>`.
//   3. Run this template against the SAME resource group, passing the
//      `namePrefix` you used in Step 1 plus the new tenant + client IDs.
//
// To turn auth OFF: re-run Step 1 against the same RG with the same
// namePrefix — that resets AUTH_ENABLED back to false.

targetScope = 'resourceGroup'

@description('The same namePrefix you used for Step 1. Used to find the App Service that Step 1 created in this resource group (its name is "<namePrefix>-web").')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Entra ID tenant (directory) GUID. Find it under Entra ID → Overview → Tenant ID.')
param entraTenantId string

@description('Entra ID App Registration (client) GUID. Find it on the registered app\'s Overview page. For an SPA app this is the only Entra ID you need — there is no client secret.')
param entraClientId string

// ─── Reference the existing App Service ──────────────────────────────────

resource existingApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: '${namePrefix}-web'
}

// Read the current appsettings so we can preserve everything (POSTGRES_*,
// IDENTITY_ATLAS_MASTER_KEY, etc.) while ADDING the auth settings. The PUT
// on `Microsoft.Web/sites/config/appsettings` is a full replace, so we have
// to include all existing keys explicitly.
//
// list() returns the secret values (KV references show up as their literal
// `@Microsoft.KeyVault(...)` strings, which is what we want to write back).
var existingSettings = list('${existingApp.id}/config/appsettings', '2024-04-01').properties

// Auth settings to add / overwrite.
var authSettings = {
  AUTH_ENABLED: 'true'
  AUTH_TENANT_ID: entraTenantId
  AUTH_CLIENT_ID: entraClientId
}

// Merge: existing wins on shared keys EXCEPT the AUTH_* ones, which we
// force to the new values. union() prefers the second arg for shared keys.
resource patchedSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: existingApp
  name: 'appsettings'
  properties: union(existingSettings, authSettings)
}

@description('Public URL of the Identity Atlas web app — same as Step 1.')
output appUrl string = 'https://${existingApp.properties.defaultHostName}'

@description('Hostname (without https://) — useful if you need to confirm the SPA redirect URI registered in Entra matches.')
output appHostname string = existingApp.properties.defaultHostName

@description('True. Always — this template only runs when you want auth on.')
output authEnabled bool = true
