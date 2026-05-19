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

@description('Release channel to deploy. **stable** = the last cut release tag (recommended for production). **edge** = the latest main-branch build — includes newer fixes and features but less testing. To pin to a specific version (e.g. 5.3.0), use webImageOverride / workerImageOverride below instead.')
@allowed(['stable', 'edge'])
param imageChannel string = 'stable'

@description('Advanced: override the web image with an explicit reference (e.g. ghcr.io/fortigi/identity-atlas:5.3.0). Leave blank to use the channel selection above.')
param webImageOverride string = ''

@description('Advanced: override the worker image with an explicit reference. Leave blank to use the channel selection above.')
param workerImageOverride string = ''

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

@description('Optional explicit Postgres admin password. Leave blank to derive one from the resource group identity (the default). The value also gets written to Key Vault.')
@secure()
param postgresAdminPassword string = ''

// ─── Entra ID authentication ─────────────────────────────────────────────
// Defaults to ON. The deployment is internet-exposed, so an open default
// would be unsafe. Set enableEntraAuth=false ONLY for short-lived demos or
// CI tests; never for anything that lives past a day.

@description('Turn on Entra ID single sign-on. Default = TRUE. When TRUE, entraTenantId and entraClientId must both be provided — the deployment fails otherwise. Set to FALSE only for short-lived demos.')
param enableEntraAuth bool = true

@description('Entra ID tenant (directory) GUID. Required when enableEntraAuth=true. Find it under Entra ID → Overview → Tenant ID.')
param entraTenantId string = ''

@description('Entra ID App Registration (client) GUID. Required when enableEntraAuth=true. Create the App Registration BEFORE deploying — add a Single-Page Application redirect URI of https://<namePrefix>-web.azurewebsites.net so users can sign in.')
param entraClientId string = ''

@description('Optional comma-separated list of App role names required to sign in (e.g. IdentityAtlas.Read,IdentityAtlas.Admin). Empty = any signed-in user in the tenant.')
param entraRequiredRoles string = ''

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

// Resolve image references. `imageChannel` picks the ghcr.io tag; the
// *Override params let advanced users pin to a specific image (e.g. for
// rollback or hotfix testing).
var _imageTag = imageChannel == 'stable' ? 'latest' : 'edge'
var webImage = empty(webImageOverride) ? 'ghcr.io/fortigi/identity-atlas:${_imageTag}' : webImageOverride
var workerImage = empty(workerImageOverride) ? 'ghcr.io/fortigi/identity-atlas-worker:${_imageTag}' : workerImageOverride

// Postgres admin password. Deterministic by default — same RG + name prefix
// always produces the same value, so re-deploys don't rotate the password.
// Meets Postgres complexity rules (upper + lower + digit + special).
//
// Security model: anyone with RG read access can derive this, but they also
// have admin rights to KV and Postgres firewall, so password unpredictability
// isn't the boundary. Real security = managed identity + KV RBAC + firewall.
// Override with the postgresAdminPassword parameter for an explicit value.
var pgPassword = empty(postgresAdminPassword)
  ? '${uniqueString(resourceGroup().id, namePrefix, 'pg-base')}!Aa1${take(uniqueString(resourceGroup().id, namePrefix, 'pg-x'), 4)}'
  : postgresAdminPassword

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
    pgPasswordToStore: pgPassword
    forceUpdateTag: bootstrapForceTag
    enableEntraAuth: enableEntraAuth
    entraTenantId: entraTenantId
    entraClientId: entraClientId
  }
}

// ─── Postgres ───────────────────────────────────────────────────────────

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    namePrefix: namePrefix
    location: location
    adminPassword: pgPassword
    skuName: profile.postgresSku
    skuTier: profile.postgresTier
    storageGb: profile.postgresStorageGb
  }
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
    enableEntraAuth: enableEntraAuth
    entraTenantId: entraTenantId
    entraClientId: entraClientId
    entraRequiredRoles: entraRequiredRoles
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
