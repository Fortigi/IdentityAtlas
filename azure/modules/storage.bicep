// Storage Account + Azure Files share for /data/uploads.
//
// Both Container Apps (web + worker) mount this share so they share the
// built-in worker API key file, CSV uploads, etc. Standard_LRS is fine for
// dev/single-tenant; switch to ZRS for production resilience.
//
// Network access stays public for simplicity — file shares accessed via
// Container Apps Environment are inside the VNet, but Azure Files mount
// in Container Apps uses the storage account's public endpoint (Azure
// service-to-service path, not internet). If you must private-endpoint
// the share, add a third private endpoint mirroring keyvault.bicep.

@description('Resource name prefix')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('Storage account replication type')
@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS'])
param sku string = 'Standard_LRS'

@description('File share quota in GiB')
@minValue(5)
@maxValue(102400)
param shareQuotaGb int = 5

// Storage account names: 3-24 chars, lowercase alphanumeric, globally unique.
var stName = take(toLower(replace('${namePrefix}st${uniqueString(resourceGroup().id)}', '-', '')), 24)

resource st 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  // The linter can't prove `stName` is ≥3 chars (it's the output of
  // take+replace+lowercase), but namePrefix is enforced ≥3 above so the
  // shortest possible result is 6 chars.
  #disable-next-line BCP334
  name: stName
  location: location
  sku: { name: sku }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource fileSvc 'Microsoft.Storage/storageAccounts/fileServices@2024-01-01' = {
  parent: st
  name: 'default'
  properties: {}
}

resource uploadsShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  parent: fileSvc
  name: 'uploads'
  properties: {
    shareQuota: shareQuotaGb
    enabledProtocols: 'SMB'
  }
}

output storageAccountId string = st.id
output storageAccountName string = st.name
output uploadsShareName string = uploadsShare.name
#disable-next-line outputs-should-not-contain-secrets // consumed by Container Apps Environment storage config
output storageAccountKey string = st.listKeys().keys[0].value
