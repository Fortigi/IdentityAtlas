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

// ─── Parameters (the deploy form) ────────────────────────────────────────
//
// Kept intentionally short — every extra field is friction for a first-time
// deployer. Advanced knobs (custom images, IP allowlist, BYO LA inline keys,
// explicit Postgres password, required Entra roles) are settable by editing
// the Bicep directly. See the README for the full list.

@description('Resource name prefix. Becomes part of every resource name. 3-15 chars, lowercase letters + digits + hyphens. The public hostname will be https://<namePrefix>-web.azurewebsites.net — must be globally unique.')
@minLength(3)
@maxLength(15)
param namePrefix string = 'identityatlas'

@description('Sizing profile. xs ≈ €45/mo (demo). s ≈ €79/mo (small production, default). m ≈ €113/mo (mid + staging slot). l ≈ €244/mo (large + GP Postgres). xl ≈ €469/mo (enterprise).')
@allowed(['xs', 's', 'm', 'l', 'xl'])
param sizeProfile string = 's'

@description('Release channel. **stable** = the last cut release tag (recommended for production). **edge** = the latest main-branch build — includes newer fixes and features but less testing.')
@allowed(['stable', 'edge'])
param imageChannel string = 'stable'

@description('Optional: existing Log Analytics workspace resource ID to forward logs to. Leave empty to create a new workspace (~€3/mo). The deployer needs Log Analytics Reader on the workspace.')
param existingLogAnalyticsWorkspaceId string = ''

// ─── Entra ID authentication ─────────────────────────────────────────────
// Auth state is derived from whether both IDs are filled in. There's no
// separate enable/disable toggle — you can't have auth "on" without these,
// and filling them in is the explicit signal that you want auth on.
//
// First-deploy pattern: leave both fields BLANK to claim the hostname in
// OPEN mode (no auth — the yellow banner shows). Once the hostname is
// confirmed, register the app in Entra with that hostname as the SPA
// redirect URI, then re-run the same deploy with the tenant + client IDs
// filled in to switch auth on.
//
// See docs/architecture/azure-deployment-walkthrough.md for the two-pass
// procedure.

@description('Entra ID tenant (directory) GUID. Leave BLANK for the first deploy (claims the hostname in OPEN mode). Fill it in on the second deploy to turn auth ON. Find it under Entra ID → Overview → Tenant ID.')
param entraTenantId string = ''

@description('Entra ID App Registration (client) GUID. Leave BLANK for the first deploy. Fill it in on the second deploy together with entraTenantId. Create the App Registration after the first deploy succeeds — its SPA redirect URI must be https://<namePrefix>-web.azurewebsites.net.')
param entraClientId string = ''

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

// Auth is ON when both IDs are filled in. Either both empty (Pass 1, OPEN
// mode) or both populated (Pass 2, auth ON) — the bootstrap script rejects
// the half-filled case.
var enableEntraAuth = !empty(entraTenantId) && !empty(entraClientId)

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
    enableEntraAuth: enableEntraAuth
    entraTenantId: entraTenantId
    entraClientId: entraClientId
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
