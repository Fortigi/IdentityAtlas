// Virtual network for the private network mode (SEC-2026-09 H-06 / L-19).
// Deployed only when main.bicep's networkMode = 'private'.
//
//   snet-web   /26  App Service regional VNet integration (delegated)
//   snet-pe    /26  private endpoints: Key Vault, Storage (file), Postgres
//   snet-aca   /23  Container Apps environment (Consumption-only needs a /23)
//
// Private DNS zones are linked to the VNet so the web app and the worker
// resolve the Key Vault, Storage and Postgres names to their private endpoints.
//
// defaultOutboundAccess stays on for the two workload subnets: the web app
// routes all outbound traffic through the VNet (needed to use the private
// endpoints) and still has to reach ghcr.io, Entra ID and configured LLM
// providers; newly created subnets otherwise default to no outbound access.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('VNet address space (/16). Change it only if it overlaps a network you peer with.')
param addressPrefix string = '10.42.0.0/16'

var octets = split(split(addressPrefix, '/')[0], '.')
var base = '${octets[0]}.${octets[1]}'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'snet-web'
        properties: {
          addressPrefix: '${base}.0.0/26'
          defaultOutboundAccess: true
          delegations: [
            { name: 'web', properties: { serviceName: 'Microsoft.Web/serverFarms' } }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '${base}.0.64/26'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'snet-aca'
        properties: {
          addressPrefix: '${base}.2.0/23'
          defaultOutboundAccess: true
          // Lets an App Service access restriction allow the worker by subnet.
          serviceEndpoints: [
            { service: 'Microsoft.Web' }
          ]
        }
      }
    ]
  }
}

var zoneNames = [
  'privatelink.vaultcore.azure.net'
  'privatelink.file.${environment().suffixes.storage}'
  'privatelink.postgres.database.azure.com'
]

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in zoneNames: {
  name: zone
  location: 'global'
}]

resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, i) in zoneNames: {
  parent: zones[i]
  name: '${namePrefix}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}]

output vnetId string = vnet.id
output webSubnetId string = '${vnet.id}/subnets/snet-web'
output privateEndpointSubnetId string = '${vnet.id}/subnets/snet-pe'
output acaSubnetId string = '${vnet.id}/subnets/snet-aca'
output keyVaultZoneId string = zones[0].id
output fileZoneId string = zones[1].id
output postgresZoneId string = zones[2].id
