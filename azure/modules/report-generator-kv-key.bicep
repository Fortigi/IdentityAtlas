// The report generator, with its API key read from Key Vault via getSecret().
//
// The key used to be a template parameter defaulting to newGuid(), so EVERY
// deployment generated a new one: both containers restarted onto it, and a
// redeploy that changed nothing still produced new revisions. Now the bootstrap
// script generates it once into Key Vault (like the Postgres password) and every
// deployment reads the same value back.
//
// A wrapper for the same reason as postgres-kv-password.bicep: the vault name is a
// parameter main.bicep fills from the key-vault module's OUTPUT, so ARM resolves
// the reference when this deployment runs, not at preflight — before the vault
// exists on a fresh install (KeyVaultParameterReferenceNotFound).

@description('Key Vault holding the report-generator-api-key secret. Pass a module output, never a static name (see above).')
param keyVaultName string

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Container Apps Environment ID')
param envId string

@description('Storage name registered on the CAE for the prompt cache share')
param promptCacheStorageName string

@description('Container image')
param image string

@description('Registry host the image is pulled from. Only used with pullIdentityId.')
param registryServer string = ''

@description('Image-pull identity (resource ID) for a private Azure Container Registry. Empty = anonymous pull.')
param pullIdentityId string = ''

@description('Caller IPs allowed to reach the ingress. Empty = any IP, and the API key is the only control.')
param allowedCallerIps array = []

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

module app 'aca-app-report-generator.bicep' = {
  name: 'report-generator-app'
  params: {
    namePrefix: namePrefix
    location: location
    envId: envId
    promptCacheStorageName: promptCacheStorageName
    image: image
    apiKey: kv.getSecret('report-generator-api-key')
    registryServer: registryServer
    pullIdentityId: pullIdentityId
    allowedCallerIps: allowedCallerIps
  }
}

output appHostname string = app.outputs.appHostname
output appUrl string = app.outputs.appUrl
