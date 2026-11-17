// Diagnostic settings for the Key Vault and the PostgreSQL server, sending
// their logs and metrics to the Log Analytics workspace (created by the
// template or BYO). App Service and the Container Apps environment set up
// their own diagnostic setting in their modules.
//
// Separate from key-vault.bicep on purpose: the private network mode applies
// that module a second time to close the vault, and a diagnostic setting has
// no reason to be part of that pass.

@description('Name of the Key Vault in this resource group.')
param keyVaultName string

@description('Name of the PostgreSQL flexible server in this resource group.')
param postgresServerName string

@description('Log Analytics workspace resource ID (may be in another resource group).')
param workspaceId string

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-11-01-preview' existing = {
  name: postgresServerName
}

// AuditEvent: every data-plane operation on the vault (who read or wrote which
// secret, and refused attempts), in the AzureDiagnostics table.
resource kvDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: kv
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'AuditEvent', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// PostgreSQLLogs: the server log (connections, failed sign-ins, errors). The
// query-store and session categories are left off: they are verbose, cost
// ingestion, and are not needed for security or operations monitoring.
resource pgDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: pg
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'PostgreSQLLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}
