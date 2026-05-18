// Azure Database for PostgreSQL — Flexible Server, behind a Private
// Endpoint. Burstable B2s by default (~€34/mo). Bump to GP_Standard_D2ds_v5
// for production-grade compute (~€95/mo).
//
// HA off by default. Backups: 7-day retention (Azure default, included).
//
// Credentials: admin password is generated outside this module (in the
// deployment script) and passed in. Stored in Key Vault. The app reads it
// via the DATABASE_URL secret reference.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Private endpoint subnet ID')
param peSubnetId string

@description('Private DNS zone ID for privatelink.postgres.database.azure.com')
param privateDnsZoneId string

@description('Postgres admin username')
param adminUsername string = 'identityatlas'

@description('Postgres admin password (passed in from Key Vault)')
@secure()
param adminPassword string

@description('Database name to create')
param databaseName string = 'identity_atlas'

@description('SKU name (Burstable_B2s, GeneralPurpose_D2ds_v5, etc.)')
param skuName string = 'Standard_B2s'

@description('SKU tier')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string = 'Burstable'

@description('Storage size in GB')
@allowed([32, 64, 128, 256, 512, 1024])
param storageGb int = 32

@description('Postgres version')
@allowed(['14', '15', '16', '17'])
param postgresVersion string = '16'

// Postgres Flexible Server names: 3-63 chars, alphanumeric + hyphens, must
// be globally unique within Azure.
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
      publicNetworkAccess: 'Disabled'
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

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${namePrefix}-pe-pg'
  location: location
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'pg'
        properties: {
          privateLinkServiceId: pg.id
          groupIds: ['postgresqlServer']
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
        name: 'pg'
        properties: { privateDnsZoneId: privateDnsZoneId }
      }
    ]
  }
}

// Note: we deliberately don't export a `databaseUrl` output (would expose
// the password). Main.bicep constructs the URL by combining FQDN + username
// + the password it fetches via getSecret().
output pgId string = pg.id
output pgFqdn string = pg.properties.fullyQualifiedDomainName
output pgName string = pg.name
output databaseName string = databaseName
output adminUsername string = adminUsername
