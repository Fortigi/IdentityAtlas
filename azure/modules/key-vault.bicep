// Key Vault behind a Private Endpoint.
//
// Holds:
//   - identityatlas-master-key     (32-byte base64; populated by deployment script)
//   - postgres-admin-password      (random; populated by deployment script)
//   - database-url                 (Postgres connection string; populated after Postgres is up)
//
// Container Apps reference these via `secretRef` + the web/worker managed
// identities. RBAC: web MI gets "Key Vault Secrets User", worker MI does
// not need KV access today (only the web container reads master key /
// DB password — worker talks via HTTP to web).
//
// Public network access is DISABLED. The deployment script identity
// needs "Key Vault Secrets Officer" to write the initial secrets, and
// runs inside a deployment-script container that gets access via the
// MI — Azure routes deployment-script traffic through the private
// endpoint when the script runs in the same VNet (we don't VNet-inject
// the script for simplicity, so we briefly enable public access during
// deployment and lock it back down at the end).

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Private endpoint subnet ID')
param peSubnetId string

@description('Private DNS zone ID for vaultcore.azure.net')
param privateDnsZoneId string

@description('Principal ID of the Web Container App managed identity (gets Secrets User)')
param webIdentityPrincipalId string

@description('Principal ID of the deployment-script identity (gets Secrets Officer to populate)')
param deployScriptPrincipalId string

@description('Pre-computed KV name (passed in by main.bicep so an `existing` reference can use the same static value).')
param kvName string

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  properties: {
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
  }
}

// RBAC: built-in role IDs. Built-in role definitions live at tenant scope
// (`/providers/Microsoft.Authorization/roleDefinitions/<id>`), not subscription
// scope. Using a tenant-scoped path is the canonical form for built-ins
// and avoids "RoleDefinitionDoesNotExist" errors seen in some tenants
// when subscriptionResourceId() is used.
var kvSecretsUserRoleId    = '4633458b-17de-4321-b757-c00f7be9e9a3'
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource webSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, webIdentityPrincipalId, kvSecretsUserRoleId)
  scope: kv
  properties: {
    roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/${kvSecretsUserRoleId}'
    principalId: webIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource deployScriptSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, deployScriptPrincipalId, kvSecretsOfficerRoleId)
  scope: kv
  properties: {
    roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/${kvSecretsOfficerRoleId}'
    principalId: deployScriptPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${namePrefix}-pe-kv'
  location: location
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'kv'
        properties: {
          privateLinkServiceId: kv.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource peDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: { privateDnsZoneId: privateDnsZoneId }
      }
    ]
  }
}

output kvId string = kv.id
output kvName string = kv.name
output kvUri string = kv.properties.vaultUri
