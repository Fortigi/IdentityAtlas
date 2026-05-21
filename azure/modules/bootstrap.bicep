// One-shot deployment script — runs once at deploy time as the deployScript
// managed identity. Validates Step-1 inputs (LAW workspace ID format) then
// generates the master key + Postgres admin password into Key Vault. The
// Bicep main.bicep then reads them back via kv.getSecret() to wire them into
// the App Service config + Postgres resource. Idempotent: if the secrets
// already exist (re-deploy), they are reused, not rotated.
//
// Entra ID auth is NOT touched here — that's Step 2 (main-auth.bicep).

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Managed identity that runs this script (must have Key Vault Secrets Officer on the KV).')
param identityId string

@description('Key Vault name to write secrets into.')
param keyVaultName string

@description('Postgres admin password to store in KV (matches the value passed to the Postgres module).')
@secure()
param pgPasswordToStore string

@description('Force re-run of the script on each deployment. Default = utcNow(), so a fresh deploy always re-evaluates the secrets-exist check.')
param forceUpdateTag string = utcNow()

@description('BYO Log Analytics workspace resource ID — validated by this script (format check) before any module tries to use it.')
param existingLogAnalyticsWorkspaceId string

resource script 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: '${namePrefix}-bootstrap'
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
    timeout: 'PT10M'
    retentionInterval: 'PT1H'
    cleanupPreference: 'OnSuccess'
    forceUpdateTag: forceUpdateTag
    environmentVariables: [
      { name: 'KV_NAME', value: keyVaultName }
      // Secure environment variables travel as deployment secrets — not in
      // logs, not in deployment history.
      { name: 'PG_PASS_TO_STORE', secureValue: pgPasswordToStore }
      // BYO Log Analytics — validation block checks format before log-analytics
      // module runs (it depends on this bootstrap).
      { name: 'EXISTING_LAW_ID', value: existingLogAnalyticsWorkspaceId }
    ]
    scriptContent: '''
set -euo pipefail

echo "==> Validating existingLogAnalyticsWorkspaceId"
if [ -n "$EXISTING_LAW_ID" ]; then
  # Format check — must be the FULL workspace resource ID, not a resource group.
  EXPECTED='^/subscriptions/[0-9a-fA-F-]+/resourceGroups/[^/]+/providers/Microsoft\.OperationalInsights/workspaces/[^/]+$'
  if ! [[ "$EXISTING_LAW_ID" =~ $EXPECTED ]]; then
    echo ""
    echo "ERROR: existingLogAnalyticsWorkspaceId is not a valid Log Analytics workspace resource ID."
    echo "       You provided: $EXISTING_LAW_ID"
    echo "       Expected format:"
    echo "         /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<workspace-name>"
    echo ""
    echo "       Common mistake: copying the parent resource GROUP's ID instead of the workspace ID."
    echo "       To get the correct one: open the workspace in the portal → Overview → JSON View → copy 'id'."
    echo "       Or leave the field BLANK to create a fresh workspace inside this deployment's RG."
    echo ""
    exit 1
  fi
  echo "    LAW format OK — $EXISTING_LAW_ID"
  echo "    (note: existence is verified by log-analytics module; if you see a ResourceNotFound"
  echo "     error there, the workspace doesn't exist at that path or you lack Log Analytics Reader)"
else
  echo "    no LAW provided — a new workspace will be created in this RG"
fi

echo "==> Generating master key (if absent)"
if ! az keyvault secret show --vault-name "$KV_NAME" --name identityatlas-master-key >/dev/null 2>&1; then
  MASTER_KEY=$(openssl rand -base64 32)
  az keyvault secret set \
    --vault-name "$KV_NAME" \
    --name identityatlas-master-key \
    --value "$MASTER_KEY" \
    --output none
  echo "    wrote identityatlas-master-key"
else
  echo "    identityatlas-master-key already present, skipping"
fi

echo "==> Storing postgres admin password (always overwrites — same value passed to the Postgres module by main.bicep)"
az keyvault secret set \
  --vault-name "$KV_NAME" \
  --name postgres-admin-password \
  --value "$PG_PASS_TO_STORE" \
  --output none
echo "    wrote postgres-admin-password"

echo "==> Done"
'''
  }
}
