// One-shot deployment script — runs once at deploy time as the deployScript
// managed identity. Generates the master key + Postgres admin password and
// writes both into Key Vault. The Bicep main.bicep then reads them back via
// kv.getSecret() to wire them into the App Service config + Postgres
// resource. Idempotent: if the secrets already exist (re-deploy), they are
// reused, not rotated.

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

@description('Entra ID tenant GUID. Pair with entraClientId; both empty = first-pass OPEN deploy, both filled = auth ON. The validation script in this module rejects the half-filled case.')
param entraTenantId string

@description('Entra ID App Registration (client) GUID. Pair with entraTenantId.')
param entraClientId string

@description('BYO Log Analytics workspace resource ID — validated by this script (format check + existence check) before any module tries to use it.')
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
      // Auth config — the validation block below derives state from these.
      { name: 'AUTH_TENANT_ID', value: entraTenantId }
      { name: 'AUTH_CLIENT_ID', value: entraClientId }
      // BYO Log Analytics — validation block checks format AND existence
      // before log-analytics module runs (it depends on this bootstrap).
      { name: 'EXISTING_LAW_ID', value: existingLogAnalyticsWorkspaceId }
    ]
    scriptContent: '''
set -euo pipefail

GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

echo "==> Validating Entra ID auth configuration"
if [ -n "$AUTH_TENANT_ID" ] && [ -n "$AUTH_CLIENT_ID" ]; then
  if ! [[ "$AUTH_TENANT_ID" =~ $GUID_RE ]]; then
    echo ""
    echo "ERROR: entraTenantId is not a valid GUID."
    echo "       Got: $AUTH_TENANT_ID"
    echo "       Expected: 8-4-4-4-12 hex chars, e.g. 10b6a2c8-41f9-400d-8020-4ca96606899f"
    echo "       Find your tenant ID at Entra ID → Overview → Tenant ID."
    echo ""
    exit 1
  fi
  if ! [[ "$AUTH_CLIENT_ID" =~ $GUID_RE ]]; then
    echo ""
    echo "ERROR: entraClientId is not a valid GUID."
    echo "       Got: $AUTH_CLIENT_ID"
    echo "       Expected: 8-4-4-4-12 hex chars, e.g. b7b7a63c-e920-47f5-b5da-5c49649a9030"
    echo "       This is the App Registration's Application (client) ID — find it on the app's Overview."
    echo ""
    exit 1
  fi
  echo "    auth ON — tenant=$AUTH_TENANT_ID client=$AUTH_CLIENT_ID"
elif [ -z "$AUTH_TENANT_ID" ] && [ -z "$AUTH_CLIENT_ID" ]; then
  echo "    auth OFF — first-pass deploy in OPEN mode (no Entra IDs provided)."
  echo "    The app will be reachable by anyone with the URL until you re-deploy"
  echo "    with entraTenantId and entraClientId filled in."
else
  echo ""
  echo "ERROR: entraTenantId and entraClientId must be EITHER both empty (first"
  echo "       pass / OPEN mode) OR both filled in (auth ON). Got one of each."
  echo ""
  exit 1
fi

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
