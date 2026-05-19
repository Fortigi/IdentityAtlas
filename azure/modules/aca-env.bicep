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

@description('Log Analytics shared key')
@secure()
param workspaceSharedKey string

@description('Storage account name backing the uploads share')
param storageAccountName string

@description('Storage account key')
@secure()
param storageAccountKey string

@description('File share name')
param uploadsShareName string

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
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
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
