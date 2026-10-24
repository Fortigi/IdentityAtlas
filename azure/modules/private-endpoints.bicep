// Private endpoints for the private network mode (SEC-2026-09 H-06 / L-19):
// Key Vault (vault), Storage (Azure Files) and Postgres Flexible Server, each
// registered in the matching private DNS zone from network.bicep.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Subnet for the private endpoints')
param subnetId string

@description('Key Vault resource ID')
param keyVaultId string

@description('Storage account resource ID')
param storageAccountId string

@description('Postgres Flexible Server resource ID')
param postgresId string

@description('privatelink.vaultcore.azure.net zone ID')
param keyVaultZoneId string

@description('privatelink.file.<storage suffix> zone ID')
param fileZoneId string

@description('privatelink.postgres.database.azure.com zone ID')
param postgresZoneId string

var endpoints = [
  { name: 'kv', target: keyVaultId, groupId: 'vault', zoneId: keyVaultZoneId }
  { name: 'file', target: storageAccountId, groupId: 'file', zoneId: fileZoneId }
  { name: 'pg', target: postgresId, groupId: 'postgresqlServer', zoneId: postgresZoneId }
]

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = [for ep in endpoints: {
  name: '${namePrefix}-pe-${ep.name}'
  location: location
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: '${namePrefix}-pe-${ep.name}'
        properties: {
          privateLinkServiceId: ep.target
          groupIds: [ep.groupId]
        }
      }
    ]
  }
}]

resource dnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (ep, i) in endpoints: {
  parent: pe[i]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: ep.name, properties: { privateDnsZoneId: ep.zoneId } }
    ]
  }
}]
