// Two user-assigned managed identities — one per Container App.
//
// User-assigned (not system-assigned) so that future workloads can adopt
// the same identity without redoing RBAC. Each identity gets least-
// privilege roles assigned in the other modules:
//   - Web identity:    AcrPull, Key Vault Secrets User
//   - Worker identity: AcrPull
//
// The deployment-script identity (which writes secrets + imports images)
// is created here too because it needs Owner-like roles narrowly scoped.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-mi-web'
  location: location
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-mi-worker'
  location: location
}

resource deployScriptIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-mi-deployscript'
  location: location
}

output webIdentityId string = webIdentity.id
output webIdentityPrincipalId string = webIdentity.properties.principalId
output webIdentityClientId string = webIdentity.properties.clientId

output workerIdentityId string = workerIdentity.id
output workerIdentityPrincipalId string = workerIdentity.properties.principalId
output workerIdentityClientId string = workerIdentity.properties.clientId

output deployScriptIdentityId string = deployScriptIdentity.id
output deployScriptIdentityPrincipalId string = deployScriptIdentity.properties.principalId
