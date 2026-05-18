// One-shot deployment script (Microsoft.Resources/deploymentScripts) that
// runs once at deploy time and does two things the rest of the Bicep
// can't:
//
//   1. Generates a 32-byte master key (`openssl rand -base64 32`) and
//      writes it to Key Vault as `identityatlas-master-key`.
//   2. Generates a Postgres admin password (random) and writes it to
//      Key Vault as `postgres-admin-password`. Output is also returned so
//      the postgres module can consume it.
//   3. Imports the Identity Atlas Docker image from ghcr.io into the
//      private ACR via `az acr import` so the Container Apps can pull
//      from `<acr>.azurecr.io` immediately.
//
// Runs as the deployScript managed identity. RBAC required:
//   - Key Vault Secrets Officer on the KV (granted in keyvault.bicep)
//   - AcrPush on the ACR (granted in acr.bicep)
//
// The script logs its output to the deployment so debugging is possible
// via `az deployment group show … --query 'properties.outputs.deployScriptLog'`.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Managed identity resource ID that runs this script')
param identityId string

@description('Key Vault name to write secrets into')
param keyVaultName string

@description('ACR name to push the image into')
param acrName string

@description('Web image source (e.g. ghcr.io/fortigi/identity-atlas:edge).')
param webSourceImage string = 'ghcr.io/fortigi/identity-atlas:edge'

@description('Worker image source. The worker uses a separate image — PowerShell-based.')
param workerSourceImage string = 'ghcr.io/fortigi/identity-atlas-worker:edge'

@description('Destination web image tag in ACR.')
param webDestImage string = 'identity-atlas:latest'

@description('Destination worker image tag in ACR.')
param workerDestImage string = 'identity-atlas-worker:latest'

@description('Force re-run of the script on each deployment (useful when changing source image).')
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
    timeout: 'PT30M'
    retentionInterval: 'PT1H'
    cleanupPreference: 'OnSuccess'
    forceUpdateTag: forceUpdateTag
    environmentVariables: [
      { name: 'KV_NAME',            value: keyVaultName }
      { name: 'ACR_NAME',           value: acrName }
      { name: 'WEB_SOURCE_IMAGE',   value: webSourceImage }
      { name: 'WORKER_SOURCE_IMAGE', value: workerSourceImage }
      { name: 'WEB_DEST_IMAGE',     value: webDestImage }
      { name: 'WORKER_DEST_IMAGE',  value: workerDestImage }
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
  PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
  az keyvault secret set \
    --vault-name "$KV_NAME" \
    --name postgres-admin-password \
    --value "$PG_PASS" \
    --output none
  echo "    wrote postgres-admin-password"
else
  echo "    postgres-admin-password already present, skipping"
fi

echo "==> Importing web image $WEB_SOURCE_IMAGE into ACR $ACR_NAME as $WEB_DEST_IMAGE"
az acr import \
  --name "$ACR_NAME" \
  --source "$WEB_SOURCE_IMAGE" \
  --image "$WEB_DEST_IMAGE" \
  --force \
  --output none
echo "    web image imported"

echo "==> Importing worker image $WORKER_SOURCE_IMAGE into ACR $ACR_NAME as $WORKER_DEST_IMAGE"
az acr import \
  --name "$ACR_NAME" \
  --source "$WORKER_SOURCE_IMAGE" \
  --image "$WORKER_DEST_IMAGE" \
  --force \
  --output none
echo "    worker image imported"

echo "==> Done"
'''
  }
}

output deployScriptLog string = script.properties.outputs.?log ?? ''
