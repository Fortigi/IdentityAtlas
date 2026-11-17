// Three user-assigned managed identities:
//   - webIdentity:         attached to the web App Service. Reads secrets
//                          from Key Vault (master key + DB password) via
//                          the App Service's "Key Vault references" feature.
//   - deployScriptIdentity: attached to the one-shot deployment script that
//                          writes the master key + DB password into KV.
//   - crawlerIdentity:     attached to the worker (which runs the crawlers) and
//                          to the web app (which runs the crawler wizard's
//                          connection test). An Entra ID crawler can sign in to
//                          Microsoft Graph as this identity instead of with an
//                          app registration's client secret. It holds NO
//                          permissions until an administrator grants it the
//                          Graph read permissions
//                          (azure/Grant-CrawlerIdentityGraphPermissions.ps1),
//                          and it is never given access to Key Vault.
//
// Apart from that the worker (ACA App) needs no identity — it pulls the worker
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

resource crawlerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-mi-crawler'
  location: location
}

output webIdentityId string = webIdentity.id
output webIdentityPrincipalId string = webIdentity.properties.principalId
output webIdentityClientId string = webIdentity.properties.clientId

output deployScriptIdentityId string = deployScriptIdentity.id
output deployScriptIdentityPrincipalId string = deployScriptIdentity.properties.principalId

output crawlerIdentityId string = crawlerIdentity.id
output crawlerIdentityPrincipalId string = crawlerIdentity.properties.principalId
output crawlerIdentityClientId string = crawlerIdentity.properties.clientId
output crawlerIdentityName string = crawlerIdentity.name
