// Postgres firewall for the public network mode (SEC-2026-09 H-06).
//
// Earlier templates allowed "all Azure services" (the 0.0.0.0 rule), which
// admits connections from any Azure customer's resources, not just this
// deployment. Only the web App Service talks to Postgres (the worker goes
// through the API), so the firewall now allows exactly the App Service's
// possible outbound IP addresses. That list covers every address the app can
// use on its scale unit; it changes only when the plan moves to a different
// pricing tier, and a redeploy (e.g. to change sizeProfile) refreshes it.
//
// ARM deployments are incremental and never delete a resource that a template
// stops declaring, so the legacy rule is kept by name and narrowed to one of
// the app's outbound addresses instead of being dropped (a dropped rule would
// stay at 0.0.0.0 on every existing server).
//
// A separate module because the rule loop is driven by a runtime value (the
// App Service's outbound addresses), which ARM resolves before a module starts.

@description('Postgres Flexible Server name')
param pgName string

@description('Comma-separated outbound IPv4 addresses of the web App Service (possibleOutboundIpAddresses).')
param appOutboundIpAddresses string

@description('Restore the legacy "allow all Azure services" rule. Not recommended — any Azure resource, in any tenant, can then reach the server.')
param allowAllAzureServices bool = false

var outboundIps = union(filter(split(appOutboundIpAddresses, ','), ip => !empty(trim(ip))), [])

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-11-01-preview' existing = {
  name: pgName
}

resource legacyAzureServicesRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-11-01-preview' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: allowAllAzureServices ? '0.0.0.0' : trim(outboundIps[0])
    endIpAddress: allowAllAzureServices ? '0.0.0.0' : trim(outboundIps[0])
  }
}

// Firewall rule writes on one server are serialised by the platform; batchSize
// avoids "another operation is in progress" conflicts.
@batchSize(1)
resource appOutboundRules 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-11-01-preview' = [for (ip, i) in outboundIps: {
  parent: pg
  name: 'web-app-outbound-${i}'
  properties: {
    startIpAddress: trim(ip)
    endIpAddress: trim(ip)
  }
  dependsOn: [legacyAzureServicesRule]
}]

output allowedIpCount int = length(outboundIps)
