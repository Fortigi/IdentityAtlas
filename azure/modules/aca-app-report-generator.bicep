// Report generator (EXPERIMENTAL) — the local model server for custom reports,
// as an Azure Container App that scales to zero.
//
// Only the web App Service talks to it. There is no VNet in this deployment shape,
// so ingress is public and an API key is REQUIRED: llama-server refuses every
// request without it (LLAMA_API_KEY — see the env block), and the web app sends it
// as a bearer token. The container holds no data, no credentials and no identity.
//
// Cost shape: minReplicas 0, so it runs only while a report is being described.
// Azure bills per second of activity; idle costs nothing.
//
// The processed system prompt (~600 MB) lives on an Azure Files share, so a
// scaled-to-zero app restores it in seconds instead of re-reading the prompt for
// minutes on every cold start.

@description('Resource name prefix')
@minLength(3)
@maxLength(15)
param namePrefix string

@description('Azure region')
param location string

@description('Container Apps Environment ID')
param envId string

@description('Storage name registered on the CAE for the prompt cache share')
param promptCacheStorageName string

@description('Container image, e.g. ghcr.io/fortigi/identity-atlas-report-generator:latest')
param image string

@description('API key the web app must send. Generated per deployment by main.bicep.')
@secure()
param apiKey string

@description('CPU cores. Consumption requires memory = 2x cpu (2 -> 4Gi).')
param cpu string = '2'

@description('Memory, e.g. 4Gi')
param memory string = '4Gi'

@description('Seconds of inactivity before the app scales back to zero.')
param scaleToZeroAfterSeconds int = 300

@description('Caller IPs allowed to reach the ingress (the web app outbound set). Empty = any IP, and the API key is the only control.')
param allowedCallerIps array = []

resource app 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: '${namePrefix}-report-generator'
  location: location
  properties: {
    managedEnvironmentId: envId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // Public, because a Consumption-only environment has no VNet. The API key is
        // the control; the IP rules below narrow it further to the web app outbound
        // addresses (shared Azure ranges, so defence in depth rather than a boundary).
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        ipSecurityRestrictions: [for (cidr, i) in allowedCallerIps: {
          name: 'allow-web-${i}'
          action: 'Allow'
          ipAddressRange: cidr
        }]
      }
      secrets: [
        { name: 'api-key', value: apiKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'report-generator'
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            // LLAMA_API_KEY, not LLAMA_ARG_API_KEY: --api-key reads only this name.
            // With the wrong name the server starts with authentication OFF, and this
            // ingress is public. A guard test pins the spelling.
            { name: 'LLAMA_API_KEY', secretRef: 'api-key' }
            // Threads must match the CPUs the container may use.
            { name: 'LLAMA_ARG_THREADS', value: cpu }
          ]
          volumeMounts: [
            { volumeName: 'promptcache', mountPath: '/slots' }
          ]
          probes: [
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8080 }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 30
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'promptcache'
          storageType: 'AzureFile'
          storageName: promptCacheStorageName
        }
      ]
      scale: {
        // Zero when nobody is building a report. One replica is enough: the model
        // server handles one question at a time anyway.
        minReplicas: 0
        maxReplicas: 1
        cooldownPeriod: scaleToZeroAfterSeconds
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '4' } }
          }
        ]
      }
    }
  }
}

@description('Hostname of the report generator (no scheme).')
output appHostname string = app.properties.configuration.ingress.fqdn

@description('URL the web app should call.')
output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
