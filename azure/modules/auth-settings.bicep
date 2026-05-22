// Inner helper for main-auth.bicep. Receives a pre-merged appsettings object
// and writes it to the App Service. Lives in a separate module so ARM
// doesn't see the outer template both reading (`list()`) and writing the
// same appsettings resource — that would trigger a circular-dependency error.

@description('App Service name (Step 1 created it as <namePrefix>-web).')
param siteName string

@description('Full merged appsettings dictionary to write to the site. Caller is responsible for merging — this resource does a full PUT.')
param settings object

resource site 'Microsoft.Web/sites@2024-04-01' existing = {
  name: siteName
}

resource appSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: site
  name: 'appsettings'
  properties: settings
}
