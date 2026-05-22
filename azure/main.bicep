// Identity Atlas — Azure deployment, STEP 1 of 2.
//
// This template deploys the application in OPEN mode (no Entra ID auth).
// The output URL is the hostname you'll register in the Entra App Reg.
//
// To turn auth ON, run STEP 2 (`main-auth.bicep`) against the SAME RG
// after registering an Entra App with this hostname as the SPA redirect URI.
//
// What this deploys:
//   - App Service Plan (Linux) + App Service for Containers (web)
//   - Postgres Flexible Server (public endpoint + firewall rule)
//   - Key Vault (public endpoint, access policies; holds master key + DB password)
//   - Storage Account + Azure Files share (for /data/uploads)
//   - 2 user-assigned managed identities (web, deployment-script)
//   - One-shot deployment script: generates master key + DB password into KV
//   - Container Apps Environment (Consumption profile, no VNet)
//   - Container App: worker (always-on, no ingress)
//   - Optional: Log Analytics workspace (or BYO via parameter)
//
// No VNet. No private endpoints. No public IP we provision.

targetScope = 'resourceGroup'

// ─── Parameters (the deploy form) ────────────────────────────────────────
//
// Kept intentionally short — every extra field is friction for a first-time
// deployer. Advanced knobs (custom images, IP allowlist, BYO LA inline keys,
// explicit Postgres password, required Entra roles) are settable by editing
// the Bicep directly. See the README for the full list.

@description('Advanced: customize the resource name prefix. Default = auto-generated, deterministic per resource group ("idatlas-" + 7-char hash of the RG ID) — globally unique. Override only if you need a specific hostname.')
@minLength(3)
@maxLength(15)
param namePrefix string = 'idatlas-${take(uniqueString(resourceGroup().id), 7)}'

@description('Sizing profile. xs ≈ €45/mo (demo). s ≈ €79/mo (small production, default). m ≈ €113/mo (mid + staging slot). l ≈ €244/mo (large + GP Postgres). xl ≈ €469/mo (enterprise).')
@allowed(['xs', 's', 'm', 'l', 'xl'])
param sizeProfile string = 's'

@description('Release channel. **stable** = the last cut release tag (recommended for production). **edge** = the latest main-branch build — includes newer fixes and features but less testing.')
@allowed(['stable', 'edge'])
param imageChannel string = 'stable'

@description('Optional: FULL ARM resource ID of an existing Log Analytics workspace to forward logs to. Leave empty to create a new workspace (~€3/mo). Must look like /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<name> — copy it from the workspace\'s Overview → JSON View, NOT the parent resource group. The deployer needs Log Analytics Reader on the workspace.')
param existingLogAnalyticsWorkspaceId string = ''

// Entra ID auth is NOT configured by this template. It deploys the app in
// OPEN mode (anyone with the URL can reach it). To turn auth on, run
// `main-auth.bicep` (Step 2) against the resulting RG once you've registered
// an App Reg in Entra with the deployed hostname as a SPA redirect URI.

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

// Region = the resource group's region. Customer picks region at RG-creation
// time; resources don't get a per-resource override.
var location = resourceGroup().location

// Resolve image references from the channel selector.
var _imageTag = imageChannel == 'stable' ? 'latest' : 'edge'
var webImage = 'ghcr.io/fortigi/identity-atlas:${_imageTag}'
var workerImage = 'ghcr.io/fortigi/identity-atlas-worker:${_imageTag}'

// Postgres admin password. Deterministic — same RG + name prefix always
// produces the same value, so re-deploys don't rotate the password. Meets
// Postgres complexity rules (upper + lower + digit + special).
//
// Security model: anyone with RG read access can derive this, but they also
// have admin rights to KV and Postgres firewall, so password unpredictability
// isn't the boundary. Real security = managed identity + KV access policies +
// firewall.
var pgPassword = '${uniqueString(resourceGroup().id, namePrefix, 'pg-base')}!Aa1${take(uniqueString(resourceGroup().id, namePrefix, 'pg-x'), 4)}'

// ─── Foundation ──────────────────────────────────────────────────────────

module logs 'modules/log-analytics.bicep' = {
  name: 'log-analytics'
  params: {
    namePrefix: namePrefix
    location: location
    existingWorkspaceId: existingLogAnalyticsWorkspaceId
  }
  // Wait for bootstrap so it can validate the LAW ID first. Means
  // log-analytics doesn't run until the validation script has checked
  // format + existence — a bad ID fails fast and visibly, instead of
  // surfacing as a half-built deploy with a cryptic ResourceNotFound.
  dependsOn: [bootstrap]
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
    existingLogAnalyticsWorkspaceId: existingLogAnalyticsWorkspaceId
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

@description('Public URL of the Identity Atlas web app. Use this as the SPA redirect URI when you register the Entra App in Step 2a.')
output appUrl string = web.outputs.appUrl

@description('Web app hostname (no scheme).')
output appHostname string = web.outputs.appHostname

@description('Resolved name prefix. Only useful if you need to manually wire something to a specific resource name in this RG. Step 2 derives the same prefix automatically when deployed to this RG.')
output namePrefixUsed string = namePrefix

@description('Key Vault URI.')
output keyVaultUri string = kv.outputs.kvUri

@description('Postgres FQDN.')
output postgresFqdn string = postgres.outputs.pgFqdn

@description('Sizing profile in use.')
output sizeProfileApplied string = sizeProfile

@description('True if a new Log Analytics workspace was created; false if BYO was used.')
output logAnalyticsCreated bool = logs.outputs.createdNew
