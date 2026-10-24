// The identity the web app, the worker and the report generator pull their
// images with, when the images come from the customer's own Azure Container
// Registry instead of public ghcr.io (containerRegistryResourceId in main.bicep).
//
// Its own identity, holding nothing but AcrPull on that one registry: the worker
// and the report generator otherwise run with no identity at all, and the web
// app's identity can read Key Vault secrets — neither should be widened just to
// pull an image. Only deployed when a registry is configured.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-mi-acrpull'
  location: location
}

output identityId string = pullIdentity.id
output principalId string = pullIdentity.properties.principalId
output clientId string = pullIdentity.properties.clientId
