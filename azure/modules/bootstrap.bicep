// One-shot deployment script — runs once at deploy time as the deployScript
// managed identity. Validates Step-1 inputs (LAW workspace ID format) then
// generates the master key + Postgres admin password into Key Vault. main.bicep
// reads the password back via kv.getSecret() for the Postgres resource, and the
// App Service references it by the versioned secret URI this script outputs.
// Idempotent: if the secrets already exist (re-deploy), they are reused, not
// rotated — unless rotatePostgresPassword is set.
//
// Postgres password history (SEC-2026-09 H-06): templates before this change
// derived the password from the resource group ID with uniqueString(), which is
// a public, deterministic hash — anyone who learned the subscription ID and the
// resource group name could compute it. They also wrote that value into Key
// Vault on every deploy, so every existing deployment already has the secret:
// this script keeps it (nothing rotates silently on upgrade). Rotate it once,
// deliberately, with rotatePostgresPassword=true to replace the derivable value.
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

@description('Replace the Postgres admin password with a new random value on this deployment. The Postgres server and the App Service pick up the new value in the same deployment (the web app restarts).')
param rotatePostgresPassword bool = false

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
      { name: 'ROTATE_PG_PASSWORD', value: string(rotatePostgresPassword) }
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

# Random, never derived. 32 random alphanumerics (~190 bits) plus a fixed
# "Aa1" suffix so the value always meets the Postgres complexity rule
# (upper + lower + digit), whatever the random part happens to contain.
new_pg_password() {
  local random
  random=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')
  printf '%sAa1' "${random:0:32}"
}

echo "==> Postgres admin password"
if [ "$ROTATE_PG_PASSWORD" = "True" ] || [ "$ROTATE_PG_PASSWORD" = "true" ]; then
  az keyvault secret set --vault-name "$KV_NAME" --name postgres-admin-password \
    --value "$(new_pg_password)" --output none
  echo "    rotated postgres-admin-password (rotatePostgresPassword=true)"
elif ! az keyvault secret show --vault-name "$KV_NAME" --name postgres-admin-password >/dev/null 2>&1; then
  az keyvault secret set --vault-name "$KV_NAME" --name postgres-admin-password \
    --value "$(new_pg_password)" --output none
  echo "    generated postgres-admin-password"
else
  echo "    postgres-admin-password already present, keeping it"
fi

# The App Service references the exact secret version, so a rotation changes
# the app setting and restarts the app onto the new password. The URI holds no
# secret value, so it is safe as a script output.
PG_SECRET_URI=$(az keyvault secret show --vault-name "$KV_NAME" --name postgres-admin-password --query id -o tsv)
printf '{"pgPasswordSecretUri":"%s"}' "$PG_SECRET_URI" > "$AZ_SCRIPTS_OUTPUT_PATH"

echo "==> Done"
'''
  }
}

// A versioned secret URI (no secret value), so it is safe as an output.
#disable-next-line outputs-should-not-contain-secrets
@description('Versioned Key Vault URI of the Postgres admin password (no secret value).')
output pgPasswordSecretUri string = script.properties.outputs.pgPasswordSecretUri
