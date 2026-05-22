// Identity Atlas — Azure deployment, STEP 2 of 2.
//
// Layers Entra ID single sign-on onto an existing Step-1 deployment.
// Does NOT touch Postgres, Key Vault, storage, Container Apps, or any other
// resource — just adds three app settings to the App Service and lets the
// platform restart it. Takes about a minute to apply.
//
// Why a deployment-script instead of a `Microsoft.Web/sites/config` Bicep
// resource: the natural Bicep pattern — `existing` site + list() current
// appsettings + write the config resource — fails template validation with
// a circular-dependency error. ARM's analyzer sees the list() and the
// config write as targeting the same resource ID and flags it as a cycle,
// even though the operations are read-then-write. `az webapp config
// appsettings set` does a real merge (adds/updates only the named keys),
// so the script doesn't need to read the existing settings at all.
//
// Required before running this:
//   1. Step 1 (main.bicep) deployed to the SAME RG you're running this
//      against. Step 1's bootstrap identity is reused here.
//   2. An Entra App Registration whose SPA redirect URI matches the Step-1
//      hostname, with an `access` scope exposed at Application ID URI
//      `api://<client-id>`.
//
// To turn auth OFF: re-run Step 1 against the same RG. Step 1 declares
// AUTH_ENABLED=false in its appsettings (a full replace), which wipes
// AUTH_TENANT_ID and AUTH_CLIENT_ID too.

targetScope = 'resourceGroup'

@description('Entra ID tenant (directory) GUID. Find it under Entra ID → Overview → Tenant ID.')
param entraTenantId string

@description('Entra ID App Registration (client) GUID. Find it on the registered app\'s Overview page. For an SPA app this is the only Entra ID you need — there is no client secret.')
param entraClientId string

var location = resourceGroup().location

// Same derivation as Step 1 — deploying both templates to the same RG
// gives the same prefix, so this template finds Step 1's App Service
// automatically. Not a parameter, so the deploy form doesn't ask.
var namePrefix = 'idatlas-${take(uniqueString(resourceGroup().id), 7)}'
var webAppName = '${namePrefix}-web'

// Reference Step-1's deployScript identity (the bootstrap one). Reusing it
// instead of creating a new identity keeps the role-assignment surface
// scoped to one principal.
resource scriptIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${namePrefix}-mi-deployscript'
}

// Reference Step-1's App Service.
resource existingApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: webAppName
}

// Grant the script identity the Website Contributor built-in role on the
// App Service. That role includes Microsoft.Web/sites/config/Write, which
// is what `az webapp config appsettings set` needs. Scoped to this one
// app, nothing broader.
//
// 'de139f84-1756-47ae-9be6-808fbbe84772' is the Website Contributor role
// definition ID — a global Azure built-in role, available in every tenant.
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: existingApp
  name: guid(existingApp.id, scriptIdentity.id, 'WebsiteContributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'de139f84-1756-47ae-9be6-808fbbe84772')
    principalId: scriptIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Dispatch the patching to a module so its `forceUpdateTag = utcNow()`
// default lives at the module's param level — that keeps it OUT of this
// template's deploy form (otherwise it would render as a "Force Update Tag"
// field with a visible formula).
module patch './modules/patch-auth-script.bicep' = {
  name: 'patch-auth-script'
  params: {
    identityId: scriptIdentity.id
    webAppName: webAppName
    entraTenantId: entraTenantId
    entraClientId: entraClientId
    location: location
    scriptName: '${namePrefix}-patch-auth'
  }
  dependsOn: [
    roleAssignment
  ]
}

@description('Public URL of the Identity Atlas web app — same as Step 1.')
output appUrl string = 'https://${existingApp.properties.defaultHostName}'

@description('Hostname (without https://) — useful if you need to confirm the SPA redirect URI registered in Entra matches.')
output appHostname string = existingApp.properties.defaultHostName

@description('True. Always — this template only runs when you want auth on.')
output authEnabled bool = true
