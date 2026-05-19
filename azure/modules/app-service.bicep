// App Service for Linux Containers — runs the Identity Atlas web image
// pulled directly from ghcr.io. Public HTTPS endpoint with Microsoft-
// managed TLS cert. Always On so users never hit a cold start.
//
// Two storage mounts: the persistent Azure Files share for /data/uploads,
// shared with the worker ACA App.
//
// Secrets (DATABASE_URL, master key) are App Service Key Vault references —
// the value lives in KV, App Service reads it at startup via the
// user-assigned managed identity. Values are visible to the app as plain
// env vars but never appear in the deployment template or ARM history.

@description('Resource name prefix')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('App Service Plan SKU (B1, B2, S1, P1v3, P2v3, ...)')
param sku string

@description('Web App image reference, e.g. ghcr.io/fortigi/identity-atlas:latest')
param image string

@description('Managed identity resource ID for KV references + future Azure RBAC')
param identityId string

@description('Key Vault URI (https://<name>.vault.azure.net/)')
param keyVaultUri string

@description('Postgres FQDN')
param pgFqdn string

@description('Postgres admin username')
param pgUsername string

@description('Postgres database name')
param pgDatabaseName string

@description('Storage account name backing /data/uploads')
param storageAccountName string

@description('Storage account key (used for the Azure Files mount)')
@secure()
param storageAccountKey string

@description('Uploads share name')
param uploadsShareName string

@description('Optional: existing Log Analytics workspace ID to forward diagnostic logs to. Empty = no diagnostic settings (still see stdout via the App Service Log Stream).')
param logAnalyticsWorkspaceId string = ''

@description('Allowed IP CIDR list for ingress. Empty array = open to the internet.')
param allowedIpCidrs array = []

// Strip the digest/tag part because the DOCKER_CUSTOM_IMAGE_NAME app setting
// expects the full image path. We pass the full image including tag, so no
// stripping needed — variable kept for clarity.
var linuxFxVersion = 'DOCKER|${image}'

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${namePrefix}-plan'
  location: location
  kind: 'linux'
  sku: { name: sku }
  properties: {
    reserved: true  // required for Linux
  }
}

resource web 'Microsoft.Web/sites@2024-04-01' = {
  name: '${namePrefix}-web'
  location: location
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: identityId
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      alwaysOn: true
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      healthCheckPath: '/api/health'
      acrUseManagedIdentityCreds: false  // we pull from public ghcr.io, no creds
      ipSecurityRestrictionsDefaultAction: empty(allowedIpCidrs) ? 'Allow' : 'Deny'
      ipSecurityRestrictions: [for (cidr, i) in allowedIpCidrs: {
        name: 'allow-${i}'
        action: 'Allow'
        priority: 100 + i
        ipAddress: cidr
      }]
      appSettings: [
        // Container source
        { name: 'DOCKER_REGISTRY_SERVER_URL', value: 'https://ghcr.io' }
        { name: 'WEBSITES_PORT', value: '3001' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
        // App config
        { name: 'NODE_ENV', value: 'production' }
        { name: 'USE_SQL', value: 'true' }
        { name: 'PORT', value: '3001' }
        { name: 'BEHIND_TLS', value: 'true' }
        { name: 'AUTH_ENABLED', value: 'false' }
        // KV references — resolved at startup via the managed identity.
        // App Service reads the literal secret value from KV and exposes
        // it to the app as the named env var.
        {
          name: 'IDENTITY_ATLAS_MASTER_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/identityatlas-master-key/)'
        }
        {
          name: 'POSTGRES_ADMIN_PASSWORD'
          value: '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/postgres-admin-password/)'
        }
        // DATABASE_URL is composed at startup from the components. We use
        // an App Service expression that interpolates POSTGRES_ADMIN_PASSWORD
        // (also a KV reference) so the raw password never appears in the
        // template, the deployment history, or ARM.
        // App Service supports referencing OTHER app settings inside an
        // app setting value using the %SETTING_NAME% syntax... but DOCKER
        // containers can't use that. So we set DATABASE_URL in JS startup
        // instead — see the small JS shim, or read POSTGRES_* directly.
        // For now: pass the parts; the app's connection.js already supports
        // POSTGRES_* env vars as a fallback to DATABASE_URL.
        { name: 'POSTGRES_HOST', value: pgFqdn }
        { name: 'POSTGRES_PORT', value: '5432' }
        { name: 'POSTGRES_DB', value: pgDatabaseName }
        { name: 'POSTGRES_USER', value: pgUsername }
        // Postgres needs SSL. The Node pg library auto-detects via the
        // PGSSLMODE env var.
        { name: 'PGSSLMODE', value: 'require' }
        // Azure-specific
        { name: 'AZURE_KEY_VAULT_URI', value: keyVaultUri }
      ]
      azureStorageAccounts: {
        uploads: {
          type: 'AzureFiles'
          accountName: storageAccountName
          shareName: uploadsShareName
          mountPath: '/data/uploads'
          accessKey: storageAccountKey
        }
      }
    }
  }
}

// Optional: forward App Service logs to Log Analytics (created or BYO).
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  scope: web
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'AppServiceConsoleLogs',  enabled: true }
      { category: 'AppServiceHTTPLogs',     enabled: true }
      { category: 'AppServiceAppLogs',      enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output appId string = web.id
output appName string = web.name
output appHostname string = web.properties.defaultHostName
output appUrl string = 'https://${web.properties.defaultHostName}'
