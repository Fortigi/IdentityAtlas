// Azure Database for PostgreSQL Flexible Server — public endpoint, firewall
// restricted to "Allow Azure services". The simplest network posture; works
// for the customer-CCoE pattern because no VNet integration is needed.
//
// Future "Isolated" template adds delegatedSubnetResourceId for private
// endpoint mode. For Simple, public endpoint + firewall is fine.

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
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

// Firewall: allow any Azure service. The App Service comes from a Microsoft-
// owned IP range, so this is the easy + correct rule. Tighten per tenant
// policy if needed.
resource fwAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-11-01-preview' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'  // sentinel value = "all Azure services" per the public docs
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

output pgId string = pg.id
output pgFqdn string = pg.properties.fullyQualifiedDomainName
output pgName string = pg.name
output databaseName string = databaseName
output adminUsername string = adminUsername
