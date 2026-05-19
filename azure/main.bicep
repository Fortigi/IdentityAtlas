// Identity Atlas — Azure Simple deployment.
//
// Click the "Deploy to Azure" button in README.md or run:
//   az group create --name <rg> --location <region>
//   az deployment group create --resource-group <rg> --template-file main.bicep
//
// What this deploys:
//   - App Service Plan (Linux) + App Service for Containers (web)
//   - Postgres Flexible Server (public endpoint + firewall rule)
//   - Key Vault (public endpoint, RBAC-only; holds master key + DB password)
//   - Storage Account + Azure Files share (for /data/uploads)
//   - 2 user-assigned managed identities (web, deployment-script)
//   - One-shot deployment script: generates master key + DB password into KV
//   - Container Apps Environment (Consumption profile, no VNet)
//   - Container App: worker (always-on, no ingress; runs scheduler.ps1)
//   - Optional: Log Analytics workspace (or BYO via parameter)
//
// No VNet. No private endpoints. No load balancer or public IP you have to
// approve with the customer's CCoE. The Architecture doc has more.

targetScope = 'resourceGroup'

// ─── Parameters ──────────────────────────────────────────────────────────

@description('Resource name prefix. Becomes part of every resource name. 3-15 chars, lowercase letters + digits + hyphens.')
@minLength(3)
@maxLength(15)
param namePrefix string = 'identityatlas'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Web image source. Default: the latest "edge" tag.')
param webImage string = 'ghcr.io/fortigi/identity-atlas:latest'

@description('Worker image source. Default: the latest "edge" tag.')
param workerImage string = 'ghcr.io/fortigi/identity-atlas-worker:latest'

@description('Sizing profile. xs ≈ €45/mo (demo). s ≈ €79/mo (small production, default). m ≈ €113/mo (mid + staging slot). l ≈ €244/mo (large + GP Postgres). xl ≈ €469/mo (enterprise).')
@allowed(['xs', 's', 'm', 'l', 'xl'])
param sizeProfile string = 's'

@description('Optional: existing Log Analytics workspace resource ID. Leave empty to create a new one (~€3/mo). Deployer needs Log Analytics Reader on the workspace.')
param existingLogAnalyticsWorkspaceId string = ''

@description('Optional: existing Log Analytics customer ID (GUID). Provide as a fallback when the deployer cannot read the workspace.')
param existingLogAnalyticsCustomerId string = ''

@description('Optional: existing Log Analytics shared key. Required if customer ID is provided.')
@secure()
param existingLogAnalyticsSharedKey string = ''

@description('Optional IP CIDR allow-list for the web ingress. Empty = open to internet (relies on Entra/app-level auth).')
param webAllowedIpCidrs array = []

@description('Force re-run of the bootstrap deployment script on each deploy.')
param bootstrapForceTag string = utcNow()

// ─── Size profile → SKUs ─────────────────────────────────────────────────

var sizeMap = {
  xs: {
    appServiceSku: 'B1'
    postgresSku: 'Standard_B1ms'
    postgresTier: 'Burstable'
    postgresStorageGb: 32
    workerCpu: '0.25'
    workerMemory: '0.5Gi'
  }
  s: {
    appServiceSku: 'B2'
    postgresSku: 'Standard_B2s'
    postgresTier: 'Burstable'
    postgresStorageGb: 32
    workerCpu: '0.25'
    workerMemory: '0.5Gi'
  }
  m: {
    appServiceSku: 'S1'
    postgresSku: 'Standard_B2s'
    postgresTier: 'Burstable'
    postgresStorageGb: 64
    workerCpu: '0.25'
    workerMemory: '0.5Gi'
  }
  l: {
    appServiceSku: 'P1v3'
    postgresSku: 'Standard_D2ds_v5'
    postgresTier: 'GeneralPurpose'
    postgresStorageGb: 128
    workerCpu: '0.5'
    workerMemory: '1Gi'
  }
  xl: {
    appServiceSku: 'P2v3'
    postgresSku: 'Standard_D4ds_v5'
    postgresTier: 'GeneralPurpose'
    postgresStorageGb: 256
    workerCpu: '0.5'
    workerMemory: '1Gi'
  }
}
var profile = sizeMap[sizeProfile]

// ─── Foundation ──────────────────────────────────────────────────────────

module logs 'modules/log-analytics.bicep' = {
  name: 'log-analytics'
  params: {
    namePrefix: namePrefix
    location: location
    existingWorkspaceId: existingLogAnalyticsWorkspaceId
    existingCustomerId: existingLogAnalyticsCustomerId
    existingSharedKey: existingLogAnalyticsSharedKey
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    namePrefix: namePrefix
    location: location
  }
}

module identities 'modules/identities.bicep' = {
  name: 'identities'
  params: {
    namePrefix: namePrefix
    location: location
  }
}

// Compute the KV name HERE (not inside the module) so the `existing`
// reference below can use the same static value. Bicep can't take
// dependencies on names produced by `module.outputs.*` (BCP433).
var kvName = take('${namePrefix}-kv-${uniqueString(resourceGroup().id)}', 24)

module kv 'modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    location: location
    kvName: kvName
    webIdentityPrincipalId: identities.outputs.webIdentityPrincipalId
    deployScriptPrincipalId: identities.outputs.deployScriptIdentityPrincipalId
  }
}

// ─── Bootstrap: generate master key + DB password into KV ───────────────

module bootstrap 'modules/bootstrap.bicep' = {
  name: 'bootstrap'
  params: {
    namePrefix: namePrefix
    location: location
    identityId: identities.outputs.deployScriptIdentityId
    keyVaultName: kv.outputs.kvName
    forceUpdateTag: bootstrapForceTag
  }
}

// Pull the freshly-written secrets back via `existing` + getSecret(). This
// is the documented Bicep pattern for passing a KV secret as a @secure()
// module parameter at deploy time.
resource kvForSecrets 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: kvName
}

// ─── Postgres ───────────────────────────────────────────────────────────

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    namePrefix: namePrefix
    location: location
    adminPassword: kvForSecrets.getSecret('postgres-admin-password')
    skuName: profile.postgresSku
    skuTier: profile.postgresTier
    storageGb: profile.postgresStorageGb
  }
  dependsOn: [bootstrap]
}

// ─── App Service (web) ──────────────────────────────────────────────────

module web 'modules/app-service.bicep' = {
  name: 'app-service'
  params: {
    namePrefix: namePrefix
    location: location
    sku: profile.appServiceSku
    image: webImage
    identityId: identities.outputs.webIdentityId
    keyVaultUri: kv.outputs.kvUri
    pgFqdn: postgres.outputs.pgFqdn
    pgUsername: postgres.outputs.adminUsername
    pgDatabaseName: postgres.outputs.databaseName
    storageAccountName: storage.outputs.storageAccountName
    storageAccountKey: storage.outputs.storageAccountKey
    uploadsShareName: storage.outputs.uploadsShareName
    logAnalyticsWorkspaceId: logs.outputs.workspaceId
    allowedIpCidrs: webAllowedIpCidrs
  }
  dependsOn: [bootstrap]
}

// ─── Container Apps Environment (for the worker) ─────────────────────────

module cae 'modules/aca-env.bicep' = {
  name: 'aca-env'
  params: {
    namePrefix: namePrefix
    location: location
    workspaceCustomerId: logs.outputs.customerId
    workspaceSharedKey: logs.outputs.sharedKey
    storageAccountName: storage.outputs.storageAccountName
    storageAccountKey: storage.outputs.storageAccountKey
    uploadsShareName: storage.outputs.uploadsShareName
  }
}

// ─── Worker Container App ───────────────────────────────────────────────

module worker 'modules/aca-app-worker.bicep' = {
  name: 'aca-app-worker'
  params: {
    namePrefix: namePrefix
    location: location
    envId: cae.outputs.envId
    uploadsStorageName: cae.outputs.uploadsStorageName
    image: workerImage
    webAppHostname: web.outputs.appHostname
    cpu: profile.workerCpu
    memory: profile.workerMemory
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────

@description('Public URL of the Identity Atlas web app.')
output appUrl string = web.outputs.appUrl

@description('Web app hostname.')
output appHostname string = web.outputs.appHostname

@description('Key Vault URI.')
output keyVaultUri string = kv.outputs.kvUri

@description('Postgres FQDN.')
output postgresFqdn string = postgres.outputs.pgFqdn

@description('Sizing profile in use.')
output sizeProfileApplied string = sizeProfile

@description('True if a new Log Analytics workspace was created; false if BYO was used.')
output logAnalyticsCreated bool = logs.outputs.createdNew
