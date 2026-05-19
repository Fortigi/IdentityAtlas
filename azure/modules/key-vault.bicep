// Key Vault — public endpoint, RBAC-only access. No private endpoint in the
// Simple shape; the customer's CCoE owns networking and we don't provision
// any. Future "Isolated" template will add a private endpoint.
//
// "Public endpoint" doesn't mean "public read access" — secrets are only
// accessible to identities with `Key Vault Secrets User` (read) or
// `Key Vault Secrets Officer` (read+write). Anonymous access returns 403.

@description('Azure region')
param location string

@description('Pre-computed KV name (passed in by main.bicep so `existing` lookups can use the same static value).')
param kvName string

@description('Principal ID of the Web App Service identity (gets Secrets User)')
param webIdentityPrincipalId string

@description('Principal ID of the deployment-script identity (gets Secrets Officer to populate)')
param deployScriptPrincipalId string

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  properties: {
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
  }
}

// Built-in role IDs. Tenant-scoped path is the canonical form for built-ins.
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

output kvId string = kv.id
output kvName string = kv.name
output kvUri string = kv.properties.vaultUri
