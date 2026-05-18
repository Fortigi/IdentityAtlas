// Log Analytics workspace. Required by the Container Apps Environment.
// Sized for low volume (~30-day retention, PerGB pricing). Bump
// `dailyQuotaGb` if you want a hard ceiling on cost.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Retention in days. Default 30. Container Apps logs are usually low-value past 30 days.')
@minValue(7)
@maxValue(730)
param retentionInDays int = 30

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-law'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
#disable-next-line outputs-should-not-contain-secrets // shared key is consumed by Container Apps Env config
output workspaceSharedKey string = workspace.listKeys().primarySharedKey
