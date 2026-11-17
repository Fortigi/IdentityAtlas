// Key Vault — Azure RBAC permission model (not vault access policies, which
// Microsoft is retiring). Public endpoint in the public network mode; the
// private network mode adds a private endpoint and a Deny default.
//
// "Public endpoint" doesn't mean "public read access" — secrets are only
// accessible to identities holding a data-plane role on this vault:
//   - web app identity       → Key Vault Secrets User    (read)
//   - bootstrap identity     → Key Vault Secrets Officer (read + write)
// Anonymous and unauthorized callers get 403.
//
// The role assignments are created here, so the deploying principal needs
// Microsoft.Authorization/roleAssignments/write on the resource group: Owner,
// User Access Administrator or Role Based Access Control Administrator.
// Contributor alone is not enough.

@description('Azure region')
param location string

@description('Pre-computed KV name (passed in by main.bicep so any `existing` lookups can use the same static value).')
param kvName string

@description('Principal ID of the Web App Service identity (gets read access to secrets).')
param webIdentityPrincipalId string

@description('Principal ID of the deployment-script identity (gets read+write access to secrets so it can populate them).')
param deployScriptPrincipalId string

// Network ACL default action (SEC-2026-09 L-19). 'Allow' in the public network
// mode: the one-shot bootstrap deployment script runs in a Microsoft-hosted
// container with no fixed IP and must reach the vault, and App Service Key
// Vault references come from the platform, not a VNet. The private network
// mode calls this module a second time with 'Deny' once bootstrap has run; the
// app then reaches the vault through its private endpoint. 'AzureServices'
// bypass keeps ARM template deployment (getSecret) working in both cases.
@description('Network ACL default action for the vault.')
@allowed(['Allow', 'Deny'])
param networkDefaultAction string = 'Allow'

// Built-in data-plane roles.
var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var secretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  properties: {
    // Switching an existing vault from access policies to RBAC is done in place:
    // the secrets stay, the old policies stop being evaluated (and are cleared
    // below), and the role assignments further down take over.
    enableRbacAuthorization: true
    accessPolicies: []
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    // main.bicep passes the Postgres admin password to the Postgres resource with
    // kv.getSecret(), which ARM resolves only for vaults enabled for template
    // deployment. The secret never appears in the template or deployment history.
    enabledForTemplateDeployment: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: networkDefaultAction
      bypass: 'AzureServices'
    }
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
  }
}

// Deterministic names, so a redeploy (and the private-mode lockdown pass, which
// applies this module a second time) updates the same assignments.
resource webSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, webIdentityPrincipalId, secretsUserRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
    principalId: webIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource deployScriptSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, deployScriptPrincipalId, secretsOfficerRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficerRoleId)
    principalId: deployScriptPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output kvId string = kv.id
output kvName string = kv.name
output kvUri string = kv.properties.vaultUri
