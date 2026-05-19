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

@description('Force re-run of the script on each deployment. Default = utcNow(), so a fresh deploy always re-evaluates the secrets-exist check.')
param forceUpdateTag string = utcNow()

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
    ]
    scriptContent: '''
set -euo pipefail

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

echo "==> Generating postgres admin password (if absent)"
if ! az keyvault secret show --vault-name "$KV_NAME" --name postgres-admin-password >/dev/null 2>&1; then
  # Postgres password rules: 8-128 chars, must contain chars from 3 of 4
  # classes (upper, lower, digit, non-alnum). 24 base64 chars
  # (with /+= stripped) reliably gives us upper+lower+digits.
  PG_PASS=$(openssl rand -base64 32 | tr -d "/+=" | head -c 24)
  az keyvault secret set \
    --vault-name "$KV_NAME" \
    --name postgres-admin-password \
    --value "$PG_PASS" \
    --output none
  echo "    wrote postgres-admin-password"
else
  echo "    postgres-admin-password already present, skipping"
fi

echo "==> Done"
'''
  }
}
