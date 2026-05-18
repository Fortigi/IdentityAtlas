// Container Apps Environment, VNet-integrated, connected to the Log
// Analytics workspace and the Azure Files share that backs /data/uploads.
//
// "VNet integration" means the environment's data plane lives inside our
// apps subnet. Both Container Apps (web + worker) will inherit this
// network posture.
//
// The `storages` child resource registers the Azure Files share so
// individual Container Apps can reference it by storage name.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Apps subnet ID (delegated to Microsoft.App/environments)')
param appsSubnetId string

@description('Log Analytics workspace customer ID')
param workspaceCustomerId string

@description('Log Analytics shared key')
@secure()
param workspaceSharedKey string

@description('Storage account name backing the uploads share')
param storageAccountName string

@description('Storage account key')
@secure()
param storageAccountKey string

@description('File share name for uploads')
param uploadsShareName string

@description('If true, the environment is internal-only (no public ingress at all).')
param internalOnly bool = false

resource env 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: '${namePrefix}-cae'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspaceCustomerId
        sharedKey: workspaceSharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: appsSubnetId
      internal: internalOnly
    }
    zoneRedundant: false
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource uploadsStorage 'Microsoft.App/managedEnvironments/storages@2024-10-02-preview' = {
  parent: env
  name: 'uploads'
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: storageAccountKey
      shareName: uploadsShareName
      accessMode: 'ReadWrite'
    }
  }
}

output envId string = env.id
output envName string = env.name
output uploadsStorageName string = uploadsStorage.name
output defaultDomain string = env.properties.defaultDomain
