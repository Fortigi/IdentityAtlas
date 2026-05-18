// Worker Container App — no ingress (the worker only makes outbound HTTP
// to the web app for crawler jobs). Same /data/uploads mount as web so
// the built-in worker key file is shared.
//
// Worker doesn't talk to the DB directly (v5 changed this) — it talks to
// the web container via `WEB_API_URL`. We use the env's internal FQDN.

@description('Resource name prefix')
param namePrefix string

@description('Azure region')
param location string

@description('Container Apps Environment ID')
param caeId string

@description('Container Apps Environment default domain (e.g. greenocean-xxx.westeurope.azurecontainerapps.io)')
param caeDefaultDomain string

@description('Storage name registered on the CAE (uploads share)')
param uploadsStorageName string

@description('Managed identity resource ID')
param identityId string

@description('Container image full reference')
param image string

@description('ACR login server')
param acrLoginServer string

@description('Web app name (used to compute the internal FQDN)')
param webAppName string

@description('CPU cores per replica')
param cpu string = '0.5'

@description('Memory per replica')
param memory string = '1Gi'

resource app 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: '${namePrefix}-worker'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: caeId
    configuration: {
      activeRevisionsMode: 'Single'
      // No ingress block — the worker exposes nothing.
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      // No secrets block — the worker reads its API key from the shared
      // Azure Files mount where the web container wrote it on first boot
      // (/data/uploads/.builtin-worker-key).
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          // The worker container's default CMD in Dockerfile.powershell is
          // already `pwsh -File /app/setup/docker/scheduler.ps1`. We
          // intentionally don't override `command` here so the image's
          // existing entrypoint runs unchanged.
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            // Web app is reachable inside the CAE on its short name.
            // <appname>.<defaultDomain> resolves through the env's
            // ingress for both external and internal-only envs.
            { name: 'WEB_API_URL', value: 'https://${webAppName}.${caeDefaultDomain}/api' }
          ]
          volumeMounts: [
            { volumeName: 'uploads', mountPath: '/data/uploads' }
          ]
        }
      ]
      volumes: [
        {
          name: 'uploads'
          storageType: 'AzureFile'
          storageName: uploadsStorageName
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output appId string = app.id
output appName string = app.name
