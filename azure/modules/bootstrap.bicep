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

@description('Resource ID of the customer\'s Azure Container Registry to pull the images from — validated by this script (format check) before the AcrPull assignment is attempted. Empty = pull from ghcr.io.')
param containerRegistryResourceId string = ''

@description('Optional: the report generator API key to store. Empty = generate one if Key Vault has none yet, and keep it.')
@secure()
param reportGeneratorApiKey string = ''

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
    environmentVariables: concat([
      { name: 'KV_NAME', value: keyVaultName }
      { name: 'ROTATE_PG_PASSWORD', value: string(rotatePostgresPassword) }
      // BYO Log Analytics — validation block checks format before log-analytics
      // module runs (it depends on this bootstrap).
      { name: 'EXISTING_LAW_ID', value: existingLogAnalyticsWorkspaceId }
      { name: 'ACR_ID', value: containerRegistryResourceId }
    ], empty(reportGeneratorApiKey) ? [] : [
      // Only when the operator chose a key: the script generates one otherwise.
      { name: 'REPORT_GENERATOR_API_KEY', secureValue: reportGeneratorApiKey }
    ])
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

echo "==> Validating containerRegistryResourceId"
if [ -n "$ACR_ID" ]; then
  EXPECTED='^/subscriptions/[0-9a-fA-F-]+/resourceGroups/[^/]+/providers/Microsoft\.ContainerRegistry/registries/[^/]+$'
  if ! [[ "$ACR_ID" =~ $EXPECTED ]]; then
    echo ""
    echo "ERROR: containerRegistryResourceId is not a valid Azure Container Registry resource ID."
    echo "       You provided: $ACR_ID"
    echo "       Expected format:"
    echo "         /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerRegistry/registries/<registry-name>"
    echo "       Copy it from the registry's Overview → JSON View → 'id', or leave it empty to pull from ghcr.io."
    echo ""
    exit 1
  fi
  echo "    registry format OK — $ACR_ID"
else
  echo "    no registry provided — images are pulled from ghcr.io"
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

# Generated once and kept, so a redeploy does not hand both containers a new key
# (it used to be a newGuid() template default). Written even when the report
# generator is not deployed, so switching it on later needs no extra step.
echo "==> Report generator API key"
if [ -n "${REPORT_GENERATOR_API_KEY:-}" ]; then
  CURRENT=$(az keyvault secret show --vault-name "$KV_NAME" --name report-generator-api-key --query value -o tsv 2>/dev/null || true)
  if [ "$CURRENT" != "$REPORT_GENERATOR_API_KEY" ]; then
    az keyvault secret set --vault-name "$KV_NAME" --name report-generator-api-key \
      --value "$REPORT_GENERATOR_API_KEY" --output none
    echo "    stored the supplied report-generator-api-key"
  else
    echo "    supplied report-generator-api-key already stored"
  fi
elif ! az keyvault secret show --vault-name "$KV_NAME" --name report-generator-api-key >/dev/null 2>&1; then
  az keyvault secret set --vault-name "$KV_NAME" --name report-generator-api-key \
    --value "$(openssl rand -hex 32)" --output none
  echo "    generated report-generator-api-key"
else
  echo "    report-generator-api-key already present, keeping it"
fi
RG_KEY_SECRET_URI=$(az keyvault secret show --vault-name "$KV_NAME" --name report-generator-api-key --query id -o tsv)

printf '{"pgPasswordSecretUri":"%s","reportGeneratorKeySecretUri":"%s"}' "$PG_SECRET_URI" "$RG_KEY_SECRET_URI" > "$AZ_SCRIPTS_OUTPUT_PATH"

echo "==> Done"
'''
  }
}

// A versioned secret URI (no secret value), so it is safe as an output.
#disable-next-line outputs-should-not-contain-secrets
@description('Versioned Key Vault URI of the Postgres admin password (no secret value).')
output pgPasswordSecretUri string = script.properties.outputs.pgPasswordSecretUri

// A versioned secret URI (no secret value), so it is safe as an output.
#disable-next-line outputs-should-not-contain-secrets
@description('Versioned Key Vault URI of the report generator API key (no secret value).')
output reportGeneratorKeySecretUri string = script.properties.outputs.reportGeneratorKeySecretUri
