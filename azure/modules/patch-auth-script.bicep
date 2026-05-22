// Deployment-script that calls `az webapp config appsettings set` to add
// AUTH_* keys to an existing App Service. Lives in its own module so the
// `forceUpdateTag` default (utcNow()) doesn't leak into main-auth.bicep's
// deploy form. The default is evaluated when main-auth.bicep dispatches
// this module, so every Step-2b deploy gets a fresh tag and the script
// re-runs.

@description('User-assigned managed identity resource ID. Must already have Website Contributor (or equivalent) on the target Web App.')
param identityId string

@description('App Service name to patch (Step 1 created it as <namePrefix>-web).')
param webAppName string

@description('Entra tenant GUID — becomes AUTH_TENANT_ID on the Web App.')
param entraTenantId string

@description('Entra App Registration client GUID — becomes AUTH_CLIENT_ID on the Web App.')
param entraClientId string

@description('Region for the deployment-script (ACI behind the scenes lives here).')
param location string

@description('Force re-execution of the script. Default = utcNow().')
param forceUpdateTag string = utcNow()

@description('Resource name for the deployment-script resource itself.')
param scriptName string

resource patchScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: scriptName
  location: location
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    azCliVersion: '2.65.0'
    timeout: 'PT5M'
    retentionInterval: 'PT1H'
    cleanupPreference: 'OnSuccess'
    forceUpdateTag: forceUpdateTag
    environmentVariables: [
      { name: 'WEB_APP_NAME', value: webAppName }
      { name: 'RG', value: resourceGroup().name }
      { name: 'TENANT_ID', value: entraTenantId }
      { name: 'CLIENT_ID', value: entraClientId }
    ]
    scriptContent: '''
set -euo pipefail

GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if ! [[ "$TENANT_ID" =~ $GUID_RE ]]; then
  echo "ERROR: entraTenantId is not a valid GUID: $TENANT_ID"
  exit 1
fi
if ! [[ "$CLIENT_ID" =~ $GUID_RE ]]; then
  echo "ERROR: entraClientId is not a valid GUID: $CLIENT_ID"
  exit 1
fi

echo "==> Patching auth settings on $WEB_APP_NAME"
az webapp config appsettings set \
  --resource-group "$RG" \
  --name "$WEB_APP_NAME" \
  --settings "AUTH_ENABLED=true" "AUTH_TENANT_ID=$TENANT_ID" "AUTH_CLIENT_ID=$CLIENT_ID" \
  --output none
echo "    done"
'''
  }
}
