// Two user-assigned managed identities:
//   - webIdentity:         attached to the web App Service. Reads secrets
//                          from Key Vault (master key + DB password) via
//                          the App Service's "Key Vault references" feature.
//   - deployScriptIdentity: attached to the one-shot deployment script that
//                          writes the master key + DB password into KV.
//
// The worker (ACA App) doesn't need its own identity — it pulls the worker
// API key from the shared Azure Files mount, doesn't talk to KV directly.

@description('Resource name prefix')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-mi-web'
  location: location
}

resource deployScriptIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-mi-deployscript'
  location: location
}

output webIdentityId string = webIdentity.id
output webIdentityPrincipalId string = webIdentity.properties.principalId
output webIdentityClientId string = webIdentity.properties.clientId

output deployScriptIdentityId string = deployScriptIdentity.id
output deployScriptIdentityPrincipalId string = deployScriptIdentity.properties.principalId
