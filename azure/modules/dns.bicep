// Two Private DNS Zones + VNet links. These let the VNet resolve
// `<server>.privatelink.postgres.database.azure.com` and
// `<vault>.privatelink.vaultcore.azure.net` to their private endpoint IPs.
//
// The zone names are fixed by Azure — do not change.
//
// In some tenants these zones are managed centrally (a hub VNet pattern).
// In that case you'd skip this module and pass existing zone IDs to the
// keyvault + postgres modules. Default here is the simple/self-contained
// path: deploy everything in the resource group.

@description('VNet ID to link to both zones')
param vnetId string

var pgZoneName = 'privatelink.postgres.database.azure.com'
var kvZoneName = 'privatelink.vaultcore.azure.net'

resource pgZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: pgZoneName
  location: 'global'
}

resource kvZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: kvZoneName
  location: 'global'
}

resource pgLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: pgZone
  name: 'vnet-link'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnetId }
    registrationEnabled: false
  }
}

resource kvLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: kvZone
  name: 'vnet-link'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnetId }
    registrationEnabled: false
  }
}

output pgZoneId string = pgZone.id
output kvZoneId string = kvZone.id
