// Container Apps Environment in Consumption-only profile (no VNet).
// Hosts the worker ACA App. Registers the shared Azure Files share so
// the worker container can mount /data/uploads.
//
// No VNet integration in the Simple shape — Container Apps Consumption
// runs in Microsoft's shared infrastructure. No subnet, no load balancer,
// no public IP that we provision.

@description('Resource name prefix')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('Log Analytics workspace resource ID (created here or BYO, possibly in another resource group) — the destination of the environment\'s diagnostic setting.')
param workspaceId string

@description('Storage account name backing the uploads share')
param storageAccountName string

@description('File share name')
param uploadsShareName string

@description('File share holding the report generator prompt cache')
param promptCacheShareName string

@description('Private network mode: /23 subnet for the environment. Empty = no VNet (public mode). The VNet of an existing environment cannot be changed, so this is for new deployments only.')
param infrastructureSubnetId string = ''

@description('Internal network mode: create the environment without a public inbound address. Like the subnet, this cannot be changed on an existing environment.')
param internalOnly bool = false

// Reference the storage account so we can read its key locally via listKeys(),
// instead of receiving it as a param/output (outputs persist in ARM deployment
// history — audit H-1).
resource stg 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: storageAccountName
}

// IMPORTANT: do NOT set `workloadProfiles` here. Setting it (even to just
// the Consumption profile) flips the env into "Workload Profiles" plan
// mode, which requires a VNet — without one the env fails to create
// ("ManagedEnvironmentInCreateFailedState"). Omitting the property gives
// a pure Consumption-only environment, which is what the Simple shape
// wants (no VNet).
resource env 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: '${namePrefix}-cae'
  location: location
  // vnetConfiguration is added only in the private network mode, so the public
  // shape sends exactly the same properties as before.
  properties: union({
    // Logs go through Azure Monitor: the diagnostic setting below picks the
    // destination. The older 'log-analytics' destination (workspace ID plus
    // shared key) is being retired by Microsoft.
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
  }, empty(infrastructureSubnetId) ? {} : {
    // Consumption-only environment inside the given subnet; still has public
    // outbound access, and no ingress is exposed (the worker has none). In the
    // internal mode the environment also gets no public inbound address.
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      internal: internalOnly
    }
  })
}

// Worker console output and the environment's system events (image pulls,
// restarts, scaling) into the workspace, as the ContainerAppConsoleLogs and
// ContainerAppSystemLogs tables.
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: env
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'ContainerAppConsoleLogs', enabled: true }
      { category: 'ContainerAppSystemLogs',  enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

resource uploadsStorage 'Microsoft.App/managedEnvironments/storages@2024-10-02-preview' = {
  parent: env
  name: 'uploads'
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: stg.listKeys().keys[0].value
      shareName: uploadsShareName
      accessMode: 'ReadWrite'
    }
  }
}

resource promptCacheStorage 'Microsoft.App/managedEnvironments/storages@2024-10-02-preview' = {
  parent: env
  name: 'promptcache'
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: stg.listKeys().keys[0].value
      shareName: promptCacheShareName
      accessMode: 'ReadWrite'
    }
  }
}

output envId string = env.id
output envName string = env.name
output uploadsStorageName string = uploadsStorage.name
output promptCacheStorageName string = promptCacheStorage.name
output defaultDomain string = env.properties.defaultDomain
