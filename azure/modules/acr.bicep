// Azure Container Registry — Basic SKU is fine for a single app deploy.
// Anonymous pull is disabled; both Container Apps pull via their
// user-assigned managed identity (AcrPull role granted here).
//
// Public network access stays Enabled because:
//   - The deployment script needs to push from ghcr.io
//   - Locking ACR behind a private endpoint adds €50/mo for premium SKU
//     and isn't required for a tenant where only Container Apps pull.
// If you need private ACR ingress, switch SKU to Premium and add a
// private endpoint module mirroring keyvault.bicep.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Principal IDs that should get AcrPull on this registry.')
param pullPrincipalIds array

@description('Principal IDs that should get AcrPush (used by the deployment script).')
param pushPrincipalIds array

// ACR names: alphanumeric only, 5-50 chars, globally unique.
// Use namePrefix with hyphens stripped + a short suffix for uniqueness.
var acrName = toLower(replace('${namePrefix}acr${uniqueString(resourceGroup().id)}', '-', ''))

resource acr 'Microsoft.ContainerRegistry/registries@2024-11-01-preview' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

// AcrPull role definition ID (built-in, well-known).
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
// AcrPush role definition ID (built-in, well-known).
var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'

resource pullAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in pullPrincipalIds: {
  name: guid(acr.id, principalId, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}]

resource pushAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in pushPrincipalIds: {
  name: guid(acr.id, principalId, acrPushRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPushRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}]

output acrId string = acr.id
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
