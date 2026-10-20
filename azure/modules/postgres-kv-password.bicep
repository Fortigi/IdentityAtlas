// Postgres, with its admin password read from Key Vault via getSecret().
//
// Why this wrapper exists: getSecret() compiles to an ARM Key Vault parameter
// reference on the nested deployment. When the vault ID in that reference can
// be computed before the deployment starts (a static name in main.bicep), ARM
// resolves it during PREFLIGHT VALIDATION — before the vault, or the secret the
// bootstrap script writes, exists. A fresh install then fails at once with
// KeyVaultParameterReferenceNotFound ("The specified KeyVault ... could not be
// found"), while a redeploy over an existing vault works (#1197 shipped that way
// in v6.0.0).
//
// Here the vault name is a parameter that main.bicep fills from the key-vault
// module's OUTPUT, a runtime value. Preflight cannot evaluate it, so the
// reference is resolved only when this deployment actually runs — after the
// vault exists and the bootstrap script has written the secret.

@description('Key Vault holding the postgres-admin-password secret. Pass a module output, never a static name (see above).')
param keyVaultName string

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('SKU name')
param skuName string

@description('SKU tier')
param skuTier string

@description('Storage size in GB')
param storageGb int

@description('Public network access. Disabled in the private network mode.')
param publicNetworkAccess string

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

module postgres 'postgres.bicep' = {
  name: 'postgres-server'
  params: {
    namePrefix: namePrefix
    location: location
    adminPassword: kv.getSecret('postgres-admin-password')
    skuName: skuName
    skuTier: skuTier
    storageGb: storageGb
    publicNetworkAccess: publicNetworkAccess
  }
}

output pgId string = postgres.outputs.pgId
output pgFqdn string = postgres.outputs.pgFqdn
output pgName string = postgres.outputs.pgName
output databaseName string = postgres.outputs.databaseName
output adminUsername string = postgres.outputs.adminUsername
