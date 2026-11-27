// Private endpoint for the web app: the internal network mode only
// (main.bicep's networkMode = 'internal').
//
// With this endpoint and publicNetworkAccess = 'Disabled' on the site, the web
// app (and its SCM/Kudu site) is reachable only from the VNet and from networks
// connected to it. The endpoint is registered in privatelink.azurewebsites.net,
// which network.bicep links to the VNet, so the worker resolves the web app's
// own hostname to the private address.
//
// Separate from private-endpoints.bicep on purpose: that module must not wait
// for the web app, which needs the Key Vault endpoint it creates.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Subnet for the private endpoint')
param subnetId string

@description('Web app (Microsoft.Web/sites) resource ID')
param webAppId string

@description('privatelink.azurewebsites.net zone ID')
param webZoneId string

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${namePrefix}-pe-web'
  location: location
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: '${namePrefix}-pe-web'
        properties: {
          privateLinkServiceId: webAppId
          groupIds: ['sites']
        }
      }
    ]
  }
}

resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'web', properties: { privateDnsZoneId: webZoneId } }
    ]
  }
}

@description('Private IPv4 address of the web app inside the VNet: what the web app hostname must resolve to on the networks that use it.')
output privateIpAddress string = pe.properties.customDnsConfigs[0].ipAddresses[0]
