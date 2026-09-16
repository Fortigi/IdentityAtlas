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
//   - Postgres Flexible Server (firewall limited to the web app's outbound IPs)
//   - Key Vault (access policies; holds master key + DB password)
//   - Storage Account + Azure Files share (for /data/uploads)
//   - 2 user-assigned managed identities (web, deployment-script)
//   - One-shot deployment script: generates master key + DB password into KV
//   - Container Apps Environment (Consumption profile)
//   - Container App: worker (always-on, no ingress)
//   - Optional: Log Analytics workspace (or BYO via parameter)
//
// networkMode = 'public' (default): no VNet, no private endpoints.
// networkMode = 'private' (NEW deployments only): a VNet with private endpoints
// for Key Vault, Storage and Postgres; the web app uses VNet integration and the
// worker environment runs in the VNet. See docs/architecture/azure-deployment.md.

targetScope = 'resourceGroup'

// ─── Parameters (the deploy form) ────────────────────────────────────────
//
// Kept intentionally short — every extra field is friction for a first-time
// deployer. Advanced knobs (custom images, IP allowlist, BYO LA inline keys,
// explicit Postgres password, required Entra roles) are settable by editing
// the Bicep directly. See the README for the full list.

// Resource name prefix — auto-derived from the RG ID so it's deterministic
// per RG and globally unique. Not a parameter: customizing it adds more
// confusion than value (Azure App Service hostnames are *.azurewebsites.net
// regardless; for a vanity domain use a CNAME). Same expression in
// main-auth.bicep so Step 2b finds Step 1's App Service automatically.
var namePrefix = 'idatlas-${take(uniqueString(resourceGroup().id), 7)}'

@description('Sizing profile. xs ≈ €45/mo (demo). s ≈ €79/mo (small production, default). m ≈ €113/mo (mid + staging slot). l ≈ €244/mo (large + GP Postgres). xl ≈ €469/mo (enterprise).')
@allowed(['xs', 's', 'm', 'l', 'xl'])
param sizeProfile string = 's'

@description('Release channel. **stable** = the last cut release tag (recommended for production). **edge** = the latest main-branch build — includes newer fixes and features but less testing.')
@allowed(['stable', 'edge'])
param imageChannel string = 'stable'

@description('Optional: FULL ARM resource ID of an existing Log Analytics workspace to forward logs to. Leave empty to create a new workspace (~€3/mo). Must look like /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<name> — copy it from the workspace\'s Overview → JSON View, NOT the parent resource group. The deployer needs Log Analytics Reader on the workspace.')
param existingLogAnalyticsWorkspaceId string = ''

@description('Network shape. **public** (default) = public endpoints; Postgres accepts only the web app\'s outbound IPs. **private** = VNet + private endpoints for Key Vault, Storage and Postgres (about EUR 25/mo extra). Choose private only when creating a NEW deployment: an existing Container Apps environment cannot be moved into a VNet.')
@allowed(['public', 'private'])
param networkMode string = 'public'

@description('Web app access restriction for requests that match no allow rule. **Allow** (default) = reachable from the internet (sign-in is enforced by the app). **Deny** = only webAllowedIpCidrs (and, in private mode, the worker subnet). In public mode the worker calls the web app\'s public URL, so add its outbound IP to webAllowedIpCidrs before choosing Deny.')
@allowed(['Allow', 'Deny'])
param webAccessDefaultAction string = 'Allow'

@description('Optional: IPv4 CIDRs allowed to reach the web app, e.g. ["203.0.113.0/24"]. A non-empty list implies Deny for everything else.')
param webAllowedIpCidrs array = []

@description('Replace the Postgres admin password with a new random value during this deployment. Leave false for normal redeploys. Set true once on deployments created before random passwords were introduced; the web app restarts onto the new password.')
param rotatePostgresPassword bool = false

@description('Restore the legacy Postgres firewall rule that admits all Azure services (any tenant). Not recommended; public network mode only.')
param postgresAllowAllAzureServices bool = false

// Entra ID auth is NOT configured by this template. It deploys the app in
// OPEN mode (anyone with the URL can reach it). To turn auth on, run
// `main-auth.bicep` (Step 2) against the resulting RG once you've registered
// an App Reg in Entra with the deployed hostname as a SPA redirect URI.

// ─── Size profile → SKUs ─────────────────────────────────────────────────

// Worker memory note: PowerShell crawlers use ForEach-Object -Parallel,
// which spawns one runspace per parallel task. Each runspace duplicates the
// session state, so memory pressure scales fast on real tenants. ACA's
// Consumption profile pins the CPU:memory ratio at 0.25 CPU per 0.5 Gi —
// 1 CPU = 2 Gi, 2 CPU = 4 Gi. We size the worker generously per tier; the
// marginal cost is small compared with the cost of debugging an OOM crash
// halfway through a customer's first sync.
//
// Real-world data points (Novastream Financial, May 2026):
//   4,500 users + 9,900 groups + 3,600 SPs OOM'd at 0.5 CPU / 1 Gi.
//   Same tenant ran clean at 2 CPU / 4 Gi.
var sizeMap = {
  xs: {
    appServiceSku: 'B1'
    postgresSku: 'Standard_B1ms'
    postgresTier: 'Burstable'
    postgresStorageGb: 32
    workerCpu: '0.5'
    workerMemory: '1Gi'
  }
  s: {
    appServiceSku: 'B2'
    postgresSku: 'Standard_B2s'
    postgresTier: 'Burstable'
    postgresStorageGb: 32
    workerCpu: '1'
    workerMemory: '2Gi'
  }
  m: {
    appServiceSku: 'S1'
    postgresSku: 'Standard_B2s'
    postgresTier: 'Burstable'
    postgresStorageGb: 64
    workerCpu: '1'
    workerMemory: '2Gi'
  }
  l: {
    appServiceSku: 'P1v3'
    postgresSku: 'Standard_D2ds_v5'
    postgresTier: 'GeneralPurpose'
    postgresStorageGb: 128
    workerCpu: '2'
    workerMemory: '4Gi'
  }
  xl: {
    appServiceSku: 'P2v3'
    postgresSku: 'Standard_D4ds_v5'
    postgresTier: 'GeneralPurpose'
    postgresStorageGb: 256
    workerCpu: '2'
    workerMemory: '4Gi'
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

// Postgres admin password: generated randomly by the bootstrap script and kept
// in Key Vault (SEC-2026-09 H-06). It used to be derived here with
// uniqueString(), a deterministic hash of the subscription ID and resource group
// name. Existing deployments keep their current password until an operator sets
// rotatePostgresPassword=true (see modules/bootstrap.bicep).

var privateNetworking = networkMode == 'private'

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

module network 'modules/network.bicep' = if (privateNetworking) {
  name: 'network'
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

// Same vault, referenced by its static name so the Postgres password can be
// passed with getSecret(): ARM resolves it at deployment time and the value
// never appears in the template, the parameters or the deployment history.
resource kvRef 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: kvName
}

// ─── Bootstrap: generate master key + DB password into KV ───────────────

module bootstrap 'modules/bootstrap.bicep' = {
  name: 'bootstrap'
  params: {
    namePrefix: namePrefix
    location: location
    identityId: identities.outputs.deployScriptIdentityId
    keyVaultName: kv.outputs.kvName
    rotatePostgresPassword: rotatePostgresPassword
    existingLogAnalyticsWorkspaceId: existingLogAnalyticsWorkspaceId
  }
}

// ─── Postgres ───────────────────────────────────────────────────────────

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    namePrefix: namePrefix
    location: location
    adminPassword: kvRef.getSecret('postgres-admin-password')
    skuName: profile.postgresSku
    skuTier: profile.postgresTier
    storageGb: profile.postgresStorageGb
    publicNetworkAccess: privateNetworking ? 'Disabled' : 'Enabled'
  }
  // The secret is created (or rotated) by the bootstrap script.
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
    uploadsShareName: storage.outputs.uploadsShareName
    logAnalyticsWorkspaceId: logs.outputs.workspaceId
    pgPasswordSecretUri: bootstrap.outputs.pgPasswordSecretUri
    ipSecurityRestrictionsDefaultAction: webAccessDefaultAction
    allowedIpCidrs: webAllowedIpCidrs
    vnetIntegrationSubnetId: privateNetworking ? network!.outputs.webSubnetId : ''
    workerSubnetId: privateNetworking ? network!.outputs.acaSubnetId : ''
  }
}

// ─── Postgres network access ───────────────────────────────────────────────

// Public mode: only the web app's outbound addresses may connect.
module postgresFirewall 'modules/postgres-firewall.bicep' = if (!privateNetworking) {
  name: 'postgres-firewall'
  params: {
    pgName: postgres.outputs.pgName
    appOutboundIpAddresses: web.outputs.possibleOutboundIpAddresses
    allowAllAzureServices: postgresAllowAllAzureServices
  }
}

// Private mode: private endpoints for Key Vault, Storage and Postgres.
module privateEndpoints 'modules/private-endpoints.bicep' = if (privateNetworking) {
  name: 'private-endpoints'
  params: {
    namePrefix: namePrefix
    location: location
    subnetId: network!.outputs.privateEndpointSubnetId
    keyVaultId: kv.outputs.kvId
    storageAccountId: storage.outputs.storageAccountId
    postgresId: postgres.outputs.pgId
    keyVaultZoneId: network!.outputs.keyVaultZoneId
    fileZoneId: network!.outputs.fileZoneId
    postgresZoneId: network!.outputs.postgresZoneId
  }
}

// ─── Container Apps Environment (for the worker) ─────────────────────────

module cae 'modules/aca-env.bicep' = {
  name: 'aca-env'
  params: {
    namePrefix: namePrefix
    location: location
    workspaceCustomerId: logs.outputs.customerId
    workspaceId: logs.outputs.workspaceId
    storageAccountName: storage.outputs.storageAccountName
    uploadsShareName: storage.outputs.uploadsShareName
    infrastructureSubnetId: privateNetworking ? network!.outputs.acaSubnetId : ''
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

// ─── Private mode: close the public paths ────────────────────────────────
//
// Key Vault and Storage stay open while the deployment runs: the bootstrap
// script reaches the vault from a Microsoft-hosted container, and the web app
// and worker need their private endpoints before the share is closed. Once
// everything above has succeeded, the same modules are applied again with a
// Deny default. A failed step (for example trying to move an existing
// deployment's worker environment into the VNet) stops the deployment before
// this point, so nothing still in use is closed. A redeploy re-opens both for
// its duration and closes them again at the end.

module kvLockdown 'modules/key-vault.bicep' = if (privateNetworking) {
  name: 'key-vault-lockdown'
  params: {
    location: location
    kvName: kvName
    webIdentityPrincipalId: identities.outputs.webIdentityPrincipalId
    deployScriptPrincipalId: identities.outputs.deployScriptIdentityPrincipalId
    networkDefaultAction: 'Deny'
  }
  dependsOn: [bootstrap, postgres, web, worker, privateEndpoints]
}

module storageLockdown 'modules/storage.bicep' = if (privateNetworking) {
  name: 'storage-lockdown'
  params: {
    namePrefix: namePrefix
    location: location
    networkDefaultAction: 'Deny'
  }
  dependsOn: [web, cae, worker, privateEndpoints]
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

@description('Network shape in use (public or private).')
output networkModeApplied string = networkMode

@description('True if a new Log Analytics workspace was created; false if BYO was used.')
output logAnalyticsCreated bool = logs.outputs.createdNew
