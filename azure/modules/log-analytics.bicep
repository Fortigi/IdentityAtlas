// Log Analytics workspace — either created here or referenced as BYO.
//
// Three modes:
//   1. Empty inputs               → create a new workspace in this RG (~€3/mo).
//   2. existingWorkspaceId only   → use an existing workspace, derive its
//                                    customerId + sharedKey via `existing`
//                                    lookup. Deployer needs Log Analytics
//                                    Reader on the workspace.
//   3. existingCustomerId+Key     → fallback for tenants where the deployer
//                                    can't read the workspace. Pass the
//                                    customerId + key directly. Optionally
//                                    also pass the workspaceId so App Service
//                                    diagnostic settings can target it.
//
// Outputs:
//   workspaceId        — full ARM resource ID (for App Service diag settings)
//   customerId         — GUID (for ACA Environment log destination)
//   sharedKey          — secret (for ACA Environment log destination)

@description('Resource name prefix (used only when creating a new workspace)')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('Existing Log Analytics workspace resource ID. Leave empty to create one.')
param existingWorkspaceId string = ''

@description('Existing workspace customer ID (GUID). Provide as a fallback if the deployer cannot read the workspace.')
param existingCustomerId string = ''

@description('Existing workspace shared key (primary or secondary).')
@secure()
param existingSharedKey string = ''

// Decide which mode we're in.
var hasInline = !empty(existingCustomerId) && !empty(existingSharedKey)
var hasLookup = !empty(existingWorkspaceId) && !hasInline
var createNew = !hasInline && !hasLookup

// MODE 1: create new.
resource newWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (createNew) {
  name: '${namePrefix}-law'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

// MODE 2: look up existing. Bicep's `existing` syntax needs the workspace's
// name + resourceGroup scope, which we parse out of the ARM ID.
//   /subscriptions/<sub>/resourceGroups/<rg>/providers/.../workspaces/<name>
//        index 0:1 ___ 1:subId           3:rgName             ^last
resource lookedUp 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = if (hasLookup) {
  name: last(split(existingWorkspaceId, '/'))
  scope: resourceGroup(split(existingWorkspaceId, '/')[2], split(existingWorkspaceId, '/')[4])
}

// `?.` safe-access on the conditional resources keeps the linter happy
// (it can't statically prove which branch runs). At runtime exactly one
// branch is "live"; the ternary below picks the right one.

#disable-next-line use-resource-id-functions
output workspaceId string = createNew
  ? newWorkspace!.id
  : (hasLookup ? lookedUp!.id : existingWorkspaceId)

output customerId string = createNew
  ? newWorkspace!.properties.customerId
  : (hasLookup ? lookedUp!.properties.customerId : existingCustomerId)

// sharedKey IS a secret by design — consumed by the ACA Environment's
// log destination config. Linter rule disabled on the output line.
// Resolved via a var so the suppression applies to a single-line output.
var resolvedSharedKey = createNew
  ? newWorkspace!.listKeys().primarySharedKey
  : (hasLookup ? lookedUp!.listKeys().primarySharedKey : existingSharedKey)
#disable-next-line outputs-should-not-contain-secrets
output sharedKey string = resolvedSharedKey

output createdNew bool = createNew
