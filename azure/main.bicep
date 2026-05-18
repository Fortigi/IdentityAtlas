// Identity Atlas — Azure production deployment.
//
// Click the "Deploy to Azure" button in README.md to launch this from the
// Portal. Or run:
//
//   az group create --name <rg> --location <region>
//   az deployment group create --resource-group <rg> --template-file main.bicep
//
// What this deploys:
//   - VNet (10.40.0.0/16) with 2 subnets: apps (delegated) + private endpoints
//   - Log Analytics workspace
//   - 3 user-assigned managed identities (web, worker, deployment script)
//   - Azure Container Registry (Basic)
//   - 2 Private DNS zones (Postgres + Key Vault) + VNet links
//   - Key Vault + private endpoint, RBAC-only access
//   - Postgres Flexible Server + private endpoint (B2s default; HA off)
//   - Storage Account + Azure Files share for /data/uploads
//   - Container Apps Environment (VNet-integrated, Log Analytics-connected)
//   - One-time deployment script: generates master key + DB password into
//     KV, imports the Identity Atlas image from ghcr.io into ACR
//   - Web Container App (public ingress, mounts uploads share, reads
//     secrets from KV via managed identity)
//   - Worker Container App (no ingress, mounts uploads share)
//
// Total cost (West Europe, no HA, ex VAT): ~€100-110/month.
//
// Post-deploy: open the appUrl output, go to Admin → Authentication to
// enable Entra ID sign-in (optional), then Admin → Crawlers to load
// demo data or connect Microsoft Graph.

targetScope = 'resourceGroup'

// ─── Parameters ──────────────────────────────────────────────────────────

@description('Resource name prefix. Becomes part of every resource name. 3-15 chars, lowercase letters + digits + hyphens.')
@minLength(3)
@maxLength(15)
param namePrefix string = 'identityatlas'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Web image source (Node API + React UI). Default: the public ghcr.io edge tag.')
param webSourceImage string = 'ghcr.io/fortigi/identity-atlas:edge'

@description('Worker image source (PowerShell crawler/scheduler). Separate from the web image.')
param workerSourceImage string = 'ghcr.io/fortigi/identity-atlas-worker:edge'

@description('Postgres compute size.')
@allowed(['Standard_B2s', 'Standard_B4ms', 'Standard_D2ds_v5', 'Standard_D4ds_v5'])
param postgresSku string = 'Standard_B2s'

@description('Postgres tier (must match SKU family).')
@allowed(['Burstable', 'GeneralPurpose'])
param postgresTier string = 'Burstable'

@description('Postgres storage in GB.')
@allowed([32, 64, 128, 256, 512, 1024])
param postgresStorageGb int = 32

@description('Web container CPU (cores).')
param webCpu string = '1'

@description('Web container memory.')
param webMemory string = '2Gi'

@description('Web container min replicas.')
@minValue(1)
param webMinReplicas int = 1

@description('Web container max replicas.')
@minValue(1)
param webMaxReplicas int = 3

@description('Optional IP CIDR allow-list on the web ingress. Empty = open to internet.')
param webAllowedIpCidrs array = []

@description('Force re-run of the bootstrap deployment script. Bump this string to import a new image without changing other params.')
param bootstrapForceTag string = utcNow()

// ─── Foundation: network, logs, identities, ACR, DNS ─────────────────────

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    namePrefix: namePrefix
    location: location
  }
}

module logs 'modules/log-analytics.bicep' = {
  name: 'log-analytics'
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

module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    namePrefix: namePrefix
    location: location
    pullPrincipalIds: [
      identities.outputs.webIdentityPrincipalId
      identities.outputs.workerIdentityPrincipalId
    ]
    pushPrincipalIds: [
      identities.outputs.deployScriptIdentityPrincipalId
    ]
  }
}

module dns 'modules/dns.bicep' = {
  name: 'dns'
  params: {
    vnetId: network.outputs.vnetId
  }
}

// ─── Secrets store + private endpoint ────────────────────────────────────

// Compute the KV name HERE (not inside the module) so the `existing`
// reference below can use the same static value. Bicep can't take
// dependencies on names produced by `module.outputs.*` (BCP433).
var kvName = take('${namePrefix}-kv-${uniqueString(resourceGroup().id)}', 24)

module kv 'modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    namePrefix: namePrefix
    location: location
    kvName: kvName
    peSubnetId: network.outputs.peSubnetId
    privateDnsZoneId: dns.outputs.kvZoneId
    webIdentityPrincipalId: identities.outputs.webIdentityPrincipalId
    deployScriptPrincipalId: identities.outputs.deployScriptIdentityPrincipalId
  }
}

// ─── Bootstrap: generate secrets + import the image ──────────────────────

module bootstrap 'modules/deployment-script.bicep' = {
  name: 'bootstrap'
  params: {
    namePrefix: namePrefix
    location: location
    identityId: identities.outputs.deployScriptIdentityId
    keyVaultName: kv.outputs.kvName
    acrName: acr.outputs.acrName
    webSourceImage: webSourceImage
    workerSourceImage: workerSourceImage
    forceUpdateTag: bootstrapForceTag
  }
}

// ─── Postgres (uses the password the bootstrap script wrote to KV) ──────

// Pull the freshly-written secrets back out of KV. `existing` + getSecret()
// is the documented Bicep pattern for "pass a KV secret as a @secure()
// module param at deploy time".
resource kvForSecrets 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: kvName
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    namePrefix: namePrefix
    location: location
    peSubnetId: network.outputs.peSubnetId
    privateDnsZoneId: dns.outputs.pgZoneId
    adminPassword: kvForSecrets.getSecret('postgres-admin-password')
    skuName: postgresSku
    skuTier: postgresTier
    storageGb: postgresStorageGb
  }
  dependsOn: [bootstrap]
}

// ─── Storage for /data/uploads ──────────────────────────────────────────

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    namePrefix: namePrefix
    location: location
  }
}

// ─── Container Apps Environment ──────────────────────────────────────────

module cae 'modules/containerapp-env.bicep' = {
  name: 'cae'
  params: {
    namePrefix: namePrefix
    location: location
    appsSubnetId: network.outputs.appsSubnetId
    workspaceCustomerId: logs.outputs.workspaceCustomerId
    workspaceSharedKey: logs.outputs.workspaceSharedKey
    storageAccountName: storage.outputs.storageAccountName
    storageAccountKey: storage.outputs.storageAccountKey
    uploadsShareName: storage.outputs.uploadsShareName
  }
}

// ─── Web + Worker Container Apps ────────────────────────────────────────

var webImageRef    = '${acr.outputs.acrLoginServer}/identity-atlas:latest'
var workerImageRef = '${acr.outputs.acrLoginServer}/identity-atlas-worker:latest'

// Wire the DATABASE_URL together at this layer. The password flows in via
// kvForSecrets.getSecret() (which masks it appropriately) — keeping the URL
// composition inside main.bicep avoids leaking the password through a module
// output.
module web 'modules/containerapp-web.bicep' = {
  name: 'containerapp-web'
  params: {
    namePrefix: namePrefix
    location: location
    caeId: cae.outputs.envId
    uploadsStorageName: cae.outputs.uploadsStorageName
    identityId: identities.outputs.webIdentityId
    identityClientId: identities.outputs.webIdentityClientId
    image: webImageRef
    acrLoginServer: acr.outputs.acrLoginServer
    keyVaultUri: kv.outputs.kvUri
    pgFqdn: postgres.outputs.pgFqdn
    pgUsername: postgres.outputs.adminUsername
    pgDatabaseName: postgres.outputs.databaseName
    pgPassword: kvForSecrets.getSecret('postgres-admin-password')
    masterKey: kvForSecrets.getSecret('identityatlas-master-key')
    cpu: webCpu
    memory: webMemory
    minReplicas: webMinReplicas
    maxReplicas: webMaxReplicas
    allowedIpCidrs: webAllowedIpCidrs
  }
}

module worker 'modules/containerapp-worker.bicep' = {
  name: 'containerapp-worker'
  params: {
    namePrefix: namePrefix
    location: location
    caeId: cae.outputs.envId
    caeDefaultDomain: cae.outputs.defaultDomain
    uploadsStorageName: cae.outputs.uploadsStorageName
    identityId: identities.outputs.workerIdentityId
    image: workerImageRef
    acrLoginServer: acr.outputs.acrLoginServer
    webAppName: web.outputs.appName
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────

@description('Public URL of the Identity Atlas web app.')
output appUrl string = web.outputs.appUrl

@description('Web app FQDN (e.g. for custom-domain mapping).')
output appFqdn string = web.outputs.appFqdn

@description('Container Registry login server.')
output acrLoginServer string = acr.outputs.acrLoginServer

@description('Key Vault URI.')
output keyVaultUri string = kv.outputs.kvUri

@description('Postgres FQDN.')
output postgresFqdn string = postgres.outputs.pgFqdn
