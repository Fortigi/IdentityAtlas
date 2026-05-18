<#
.SYNOPSIS
    Deploy Identity Atlas to an Azure resource group. CLI fallback for users
    who don't want to click the Deploy to Azure button.

.DESCRIPTION
    Creates the resource group (if missing) and runs the main.bicep template
    against it. The deployment takes ~15 minutes. On success, prints the
    public URL.

.PARAMETER ResourceGroup
    Resource group name. Will be created if it doesn't exist.

.PARAMETER Location
    Azure region (e.g. westeurope, northeurope, eastus). Default: westeurope.

.PARAMETER NamePrefix
    Resource name prefix. Default: identityatlas.

.PARAMETER SubscriptionId
    Subscription ID. Optional — uses your current `az account` if omitted.

.PARAMETER ParametersFile
    Path to a parameters JSON file. Default: main.parameters.example.json
    next to this script.

.EXAMPLE
    ./deploy.ps1 -ResourceGroup ia-prod -Location westeurope

.EXAMPLE
    ./deploy.ps1 -ResourceGroup ia-test -ParametersFile ./my.parameters.json
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [string]$Location = 'westeurope',

    [string]$NamePrefix = 'identityatlas',

    [string]$SubscriptionId,

    [string]$ParametersFile
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bicepFile = Join-Path $here 'main.bicep'
if (-not $ParametersFile) {
    $ParametersFile = Join-Path $here 'main.parameters.example.json'
}

Write-Host "=== Identity Atlas Azure deploy ===" -ForegroundColor Cyan
Write-Host "  ResourceGroup : $ResourceGroup"
Write-Host "  Location      : $Location"
Write-Host "  NamePrefix    : $NamePrefix"
Write-Host "  Bicep file    : $bicepFile"
Write-Host "  Parameters    : $ParametersFile"

# ── Ensure az CLI is logged in ──────────────────────────────────────────
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "Not logged in to az. Running 'az login'..." -ForegroundColor Yellow
    az login | Out-Null
    $account = az account show | ConvertFrom-Json
}

if ($SubscriptionId) {
    az account set --subscription $SubscriptionId | Out-Null
    $account = az account show | ConvertFrom-Json
}
Write-Host "  Subscription  : $($account.name) ($($account.id))" -ForegroundColor Gray

# ── Resource group ──────────────────────────────────────────────────────
$rg = az group show --name $ResourceGroup 2>$null | ConvertFrom-Json
if (-not $rg) {
    Write-Host "Creating resource group..." -ForegroundColor Yellow
    az group create --name $ResourceGroup --location $Location | Out-Null
}

# ── Deploy ──────────────────────────────────────────────────────────────
Write-Host "`nStarting deployment. This takes ~15 minutes." -ForegroundColor Cyan
$deploymentName = "identityatlas-$(Get-Date -Format 'yyyyMMddHHmmss')"

$result = az deployment group create `
    --resource-group $ResourceGroup `
    --name $deploymentName `
    --template-file $bicepFile `
    --parameters "@$ParametersFile" `
    --parameters namePrefix=$NamePrefix location=$Location `
    --output json | ConvertFrom-Json

if ($LASTEXITCODE -ne 0 -or $result.properties.provisioningState -ne 'Succeeded') {
    Write-Host "`nDeployment failed. See errors above." -ForegroundColor Red
    Write-Host "Inspect: az deployment group show -g $ResourceGroup -n $deploymentName" -ForegroundColor Yellow
    exit 1
}

# ── Outputs ─────────────────────────────────────────────────────────────
Write-Host "`n=== Deployment succeeded ===" -ForegroundColor Green
$outputs = $result.properties.outputs
Write-Host "  App URL        : $($outputs.appUrl.value)" -ForegroundColor Cyan
Write-Host "  App FQDN       : $($outputs.appFqdn.value)"
Write-Host "  ACR            : $($outputs.acrLoginServer.value)"
Write-Host "  Key Vault      : $($outputs.keyVaultUri.value)"
Write-Host "  Postgres FQDN  : $($outputs.postgresFqdn.value)"

Write-Host "`nNext steps:" -ForegroundColor Cyan
Write-Host "  1. Open $($outputs.appUrl.value) — first paint takes ~30s while the container warms up"
Write-Host "  2. Go to Admin → Crawlers to load demo data or connect Microsoft Graph"
Write-Host "  3. (Optional) Go to Admin → Authentication to enable Entra ID sign-in"
