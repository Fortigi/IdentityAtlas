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

@description('Log Analytics customer ID (GUID)')
param workspaceCustomerId string

@description('Log Analytics workspace resource ID — used to read its shared key locally via listKeys(). The key is NOT passed in: module outputs persist in ARM deployment history (audit finding H-1).')
param workspaceId string

@description('Storage account name backing the uploads share')
param storageAccountName string

@description('File share name')
param uploadsShareName string

// Reference the LA workspace + storage account so we can read their secrets
// locally via listKeys(), instead of receiving them as params/outputs (outputs
// persist in ARM deployment history — audit H-1). Same deploy principal as the
// producing modules, which already called listKeys() on these, so no extra
// permissions are required. The workspace may be BYO in another RG, so its
// name + scope are parsed out of the full resource ID.
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: last(split(workspaceId, '/'))
  scope: resourceGroup(split(workspaceId, '/')[2], split(workspaceId, '/')[4])
}

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
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspaceCustomerId
        sharedKey: law.listKeys().primarySharedKey
      }
    }
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

output envId string = env.id
output envName string = env.name
output uploadsStorageName string = uploadsStorage.name
output defaultDomain string = env.properties.defaultDomain
