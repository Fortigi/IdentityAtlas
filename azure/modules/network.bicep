// VNet with two subnets:
//   - appsSubnet:  delegated to Microsoft.App/environments. Container Apps
//                  manage NICs/routing inside this subnet automatically.
//                  Must be /23 or larger per Container Apps requirement.
//   - peSubnet:    private endpoint subnet for Postgres + Key Vault.
//
// Each subnet has an NSG attached. Defaults are permissive for outbound +
// allow established inbound; lock down further per tenant policy if needed.

@description('Resource name prefix (e.g. identityatlas)')
param namePrefix string

@description('Azure region')
param location string

@description('VNet address space. Must contain both subnets.')
param vnetAddressPrefix string = '10.40.0.0/16'

@description('Apps subnet (delegated to Container Apps). Must be /23 or larger.')
param appsSubnetPrefix string = '10.40.0.0/23'

@description('Private endpoint subnet.')
param peSubnetPrefix string = '10.40.2.0/24'

var appsNsgName = '${namePrefix}-nsg-apps'
var peNsgName   = '${namePrefix}-nsg-pe'
var vnetName    = '${namePrefix}-vnet'

resource appsNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: appsNsgName
  location: location
  properties: {
    securityRules: [
      // Deny everything else by default — Azure rules already enforce that;
      // this is a placeholder for tenant-specific lockdown.
    ]
  }
}

resource peNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: peNsgName
  location: location
  properties: {
    securityRules: []
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: appsSubnetPrefix
          networkSecurityGroup: { id: appsNsg.id }
          delegations: [
            {
              name: 'containerapps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'pe'
        properties: {
          addressPrefix: peSubnetPrefix
          networkSecurityGroup: { id: peNsg.id }
          // Private endpoints require this disabled.
          privateEndpointNetworkPolicies: 'Disabled'
          privateLinkServiceNetworkPolicies: 'Enabled'
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output appsSubnetId string = '${vnet.id}/subnets/apps'
output peSubnetId string = '${vnet.id}/subnets/pe'
