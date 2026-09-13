// Azure Database for PostgreSQL Flexible Server.
//
// Network (SEC-2026-09 H-06):
//   public mode  — public endpoint; firewall rules (postgres-firewall.bicep)
//                  allow only the web App Service's outbound IP addresses.
//   private mode — public network access disabled; the web app reaches the
//                  server through a private endpoint (private-endpoints.bicep).
// Both use the server's "public access" networking model, so an existing
// server can move between them. (VNet injection is not used: that networking
// model can only be chosen when a server is created.)

@description('Resource name prefix')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('Postgres admin username')
param adminUsername string = 'identityatlas'

@description('Postgres admin password (passed in from Key Vault).')
@secure()
param adminPassword string

@description('Database name to create')
param databaseName string = 'identity_atlas'

@description('SKU name (Standard_B1ms, Standard_B2s, Standard_D2ds_v5, Standard_D4ds_v5).')
param skuName string

@description('SKU tier')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string

@description('Storage size in GB')
@allowed([32, 64, 128, 256, 512, 1024])
param storageGb int = 32

@description('Public network access. Disabled in the private network mode.')
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

@description('Postgres version')
@allowed(['14', '15', '16', '17'])
param postgresVersion string = '16'

// Postgres Flex names: 3-63 chars, alphanumeric + hyphens, globally unique.
var pgName = take('${namePrefix}-pg-${uniqueString(resourceGroup().id)}', 63)

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-11-01-preview' = {
  name: pgName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: adminUsername
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: storageGb
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: {
      publicNetworkAccess: publicNetworkAccess
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-11-01-preview' = {
  parent: pg
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow-list extensions our migrations use. Azure Postgres Flex blocks
// CREATE EXTENSION for everything not in this list — migration 013 fails
// with "extension pg_trgm is not allow-listed" without this.
// Add more (comma-separated, uppercase) if future migrations install more.
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-11-01-preview' = {
  parent: pg
  name: 'azure.extensions'
  properties: {
    value: 'PG_TRGM'
    source: 'user-override'
  }
}

output pgId string = pg.id
output pgFqdn string = pg.properties.fullyQualifiedDomainName
output pgName string = pg.name
output databaseName string = databaseName
output adminUsername string = adminUsername
