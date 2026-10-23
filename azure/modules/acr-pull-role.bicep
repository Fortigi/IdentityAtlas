// AcrPull for the image-pull identity, on the customer's own Azure Container
// Registry. Deployed at the REGISTRY's resource group (main.bicep sets the
// scope), which may differ from the deployment's — a registry is usually shared.
//
// The deploying principal needs the right to create role assignments on that
// registry (Owner, User Access Administrator or Role Based Access Control
// Administrator); without it this step fails and nothing is pulled.

@description('Name of the existing container registry, in this module\'s resource group.')
param registryName string

@description('Principal ID of the image-pull identity.')
param principalId string

// Built-in role: AcrPull.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

@description('Login server of the registry, e.g. contoso.azurecr.io.')
output loginServer string = registry.properties.loginServer
