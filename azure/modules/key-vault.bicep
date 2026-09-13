// Key Vault — public endpoint, RBAC-only access. No private endpoint in the
// Simple shape; the customer's CCoE owns networking and we don't provision
// any. Future "Isolated" template will add a private endpoint.
//
// "Public endpoint" doesn't mean "public read access" — secrets are only
// accessible to identities with `Key Vault Secrets User` (read) or
// `Key Vault Secrets Officer` (read+write). Anonymous access returns 403.

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

// Key Vault — public endpoint, access via access policies (NOT RBAC).
//
// We use access policies instead of RBAC because some tenants block
// role-definition lookups required by Microsoft.Authorization/roleAssignments
// (observed in IIDemos: "RoleDefinitionDoesNotExist" against the Key Vault
// Secrets User built-in). Access policies are the older model but they
// work in every tenant without depending on tenant-scope role catalog reads.
//
// Both models produce the same effective security: only identities with
// the right secrets permission can read/write. Anonymous and unauthorized
// callers still get 403.
resource kv 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  properties: {
    enableRbacAuthorization: false
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
    accessPolicies: [
      {
        tenantId: subscription().tenantId
        objectId: webIdentityPrincipalId
        permissions: {
          secrets: ['get', 'list']
        }
      }
      {
        tenantId: subscription().tenantId
        objectId: deployScriptPrincipalId
        permissions: {
          secrets: ['get', 'list', 'set']
        }
      }
    ]
  }
}

output kvId string = kv.id
output kvName string = kv.name
output kvUri string = kv.properties.vaultUri
