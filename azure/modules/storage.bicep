// Storage Account + Azure Files share for /data/uploads.
//
// Mounted by BOTH the web App Service AND the worker ACA App. Holds the
// built-in worker API key file (the bridge between the two), CSV uploads,
// and any other persistent state under /data/uploads.

@description('Resource name prefix')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('File share quota in GiB')
@minValue(5)
@maxValue(1024)
param shareQuotaGb int = 10

// Network ACL default action (SEC-2026-09 L-19). 'Allow' in the public network
// mode: App Service and a Container Apps environment without a VNet can only
// mount Azure Files over the public endpoint. The private network mode calls
// this module a second time with 'Deny' after the web app (VNet integration)
// and the worker environment (VNet) are in place and mount the share through
// its private endpoint.
@description('Network ACL default action for the storage account.')
@allowed(['Allow', 'Deny'])
param networkDefaultAction string = 'Allow'

// Storage account names: 3-24 chars, lowercase alphanumeric, globally unique.
var stName = take(toLower(replace('${namePrefix}st${uniqueString(resourceGroup().id)}', '-', '')), 24)

resource st 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  // namePrefix is enforced ≥3 above; the linter can't prove the take()
  // output length is ≥3 statically.
  #disable-next-line BCP334
  name: stName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: networkDefaultAction
      bypass: 'AzureServices'
    }
  }
}

resource fileSvc 'Microsoft.Storage/storageAccounts/fileServices@2024-01-01' = {
  parent: st
  name: 'default'
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

// The storage account key is deliberately NOT emitted as an output. Module
// outputs persist in ARM deployment history and are readable by any principal
// with deployment/RG-reader access (audit finding H-1). Consumers (App Service,
// ACA Env) reference this account via `existing` and call listKeys() themselves
// — same deploy principal, so no secret crosses a module boundary.
