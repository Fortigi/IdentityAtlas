<#
.SYNOPSIS
    Re-import the Identity Atlas Docker images into an existing ACR.

.DESCRIPTION
    The Bicep deployment imports the images once on first deploy. Use this
    script to bring in a fresh tag later (e.g. after a `:edge` rebuild or
    when pinning to a release tag).

.PARAMETER ResourceGroup
    Resource group containing the ACR.

.PARAMETER NamePrefix
    Resource name prefix used at deploy time (default: identityatlas).
    Used to compute the ACR name.

.PARAMETER WebTag
    Source tag for the web image. Default: edge.

.PARAMETER WorkerTag
    Source tag for the worker image. Default: edge.

.EXAMPLE
    ./import-image.ps1 -ResourceGroup ia-prod
    Imports the latest edge tag for both web and worker.

.EXAMPLE
    ./import-image.ps1 -ResourceGroup ia-prod -WebTag 5.30.20260518.1154 -WorkerTag 5.30.20260518.1154
    Pins both images to a specific build.

.NOTES
    After importing, the running Container Apps need to be restarted so
    they pull the new `:latest` tag. The script does this automatically.
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [string]$NamePrefix = 'identityatlas',

    [string]$WebTag = 'edge',

    [string]$WorkerTag = 'edge'
)

$ErrorActionPreference = 'Stop'

Write-Host "=== Re-importing Identity Atlas images ===" -ForegroundColor Cyan

# Find the ACR in the resource group (assumes there's exactly one).
$acrs = az acr list --resource-group $ResourceGroup -o json | ConvertFrom-Json
if (-not $acrs -or $acrs.Count -eq 0) {
    Write-Error "No ACR found in resource group $ResourceGroup"
}
if ($acrs.Count -gt 1) {
    Write-Warning "Multiple ACRs in $ResourceGroup — using the first: $($acrs[0].name)"
}
$acrName = $acrs[0].name
Write-Host "  ACR: $acrName" -ForegroundColor Gray

Write-Host "  Importing ghcr.io/fortigi/identity-atlas:$WebTag → identity-atlas:latest"
az acr import --name $acrName --source "ghcr.io/fortigi/identity-atlas:$WebTag" --image "identity-atlas:latest" --force | Out-Null

Write-Host "  Importing ghcr.io/fortigi/identity-atlas-worker:$WorkerTag → identity-atlas-worker:latest"
az acr import --name $acrName --source "ghcr.io/fortigi/identity-atlas-worker:$WorkerTag" --image "identity-atlas-worker:latest" --force | Out-Null

# Restart the Container Apps so they pull the new image.
Write-Host "`nRestarting Container Apps to pick up new images..." -ForegroundColor Cyan
$apps = az containerapp list --resource-group $ResourceGroup -o json | ConvertFrom-Json
foreach ($app in $apps) {
    Write-Host "  Restarting $($app.name)..." -ForegroundColor Gray
    az containerapp revision restart --name $app.name --resource-group $ResourceGroup --revision $app.properties.latestRevisionName | Out-Null
}

Write-Host "`nDone." -ForegroundColor Green
