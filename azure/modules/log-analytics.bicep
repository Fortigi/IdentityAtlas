// Log Analytics workspace — either created here or referenced as BYO.
//
// Two modes:
//   1. Empty input              → create a new workspace in this RG (~€3/mo).
//   2. existingWorkspaceId set  → use an existing workspace, derive its
//                                  customerId + sharedKey via `existing`
//                                  lookup. Deployer needs Log Analytics
//                                  Reader on the workspace.
//
// Outputs:
//   workspaceId  — full ARM resource ID (for App Service diag settings)
//   customerId   — GUID (for ACA Environment log destination)
//   sharedKey    — secret (for ACA Environment log destination)

@description('Resource name prefix (used only when creating a new workspace)')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('Existing Log Analytics workspace resource ID. Leave empty to create one.')
param existingWorkspaceId string = ''

var createNew = empty(existingWorkspaceId)

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
resource lookedUp 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = if (!createNew) {
  name: last(split(existingWorkspaceId, '/'))
  scope: resourceGroup(split(existingWorkspaceId, '/')[2], split(existingWorkspaceId, '/')[4])
}

// `?.` safe-access on the conditional resources keeps the linter happy
// (it can't statically prove which branch runs). At runtime exactly one
// branch is "live"; the ternary below picks the right one.

output workspaceId string = createNew ? newWorkspace!.id : lookedUp!.id
output customerId string = createNew ? newWorkspace!.properties.customerId : lookedUp!.properties.customerId

// The workspace shared key is deliberately NOT emitted as an output — outputs
// persist in ARM deployment history (audit finding H-1). The ACA Environment
// module references the workspace via `existing` (using the workspaceId output
// above) and calls listKeys() itself.

output createdNew bool = createNew
