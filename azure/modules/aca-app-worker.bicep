// Worker — Azure Container Apps App (NOT a Job). Always running so
// "Sync now" responds immediately. Reads the built-in worker API key
// from the shared Azure Files mount where the web App Service wrote it
// on first boot.
//
// No ingress (the worker exposes no HTTP). Talks outbound to the web
// App Service's public URL.

@description('Resource name prefix')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('Container Apps Environment ID')
param envId string

@description('Storage name registered on the CAE (the uploads share)')
param uploadsStorageName string

@description('Container image full reference, e.g. ghcr.io/fortigi/identity-atlas-worker:latest')
param image string

@description('Web app FQDN, used to compute WEB_API_URL')
param webAppHostname string

@description('Worker CPU cores (0.25, 0.5, 0.75, 1, 1.25, ...)')
param cpu string = '0.25'

@description('Worker memory (0.5Gi, 1Gi, 1.5Gi, 2Gi, ...)')
param memory string = '0.5Gi'

resource app 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: '${namePrefix}-worker'
  location: location
  properties: {
    managedEnvironmentId: envId
    configuration: {
      activeRevisionsMode: 'Single'
      // No ingress — the worker has no inbound HTTP.
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          // Image's default CMD already runs `pwsh -File scheduler.ps1`.
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            { name: 'WEB_API_URL', value: 'https://${webAppHostname}/api' }
            // CRAWLER_API_KEY is NOT set — scheduler.ps1 falls back to
            // reading /data/uploads/.builtin-worker-key which the web
            // container's bootstrap.js writes on first boot. The shared
            // Azure Files mount makes both sides see the same file.
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
