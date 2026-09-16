<#
.SYNOPSIS
    Deploy Identity Atlas (Simple shape) to an Azure resource group. CLI
    equivalent of the README's "Deploy to Azure" button.

.DESCRIPTION
    Creates the resource group (if missing) and runs main.bicep against it.
    The deployment takes ~5-7 minutes. On success, prints the public URL.

.PARAMETER ResourceGroup
    Resource group name. Will be created if it doesn't exist.

.PARAMETER Location
    Azure region. Default: westeurope.

.PARAMETER SizeProfile
    xs / s / m / l / xl. Default: s. See docs/architecture/azure-deployment.md.

.PARAMETER ImageChannel
    stable / edge. Default: stable. stable tracks :latest (the last cut release);
    edge tracks :edge (the latest main-branch build).

.PARAMETER ExistingLogAnalyticsWorkspaceId
    Optional: ARM ID of an existing Log Analytics workspace.

.PARAMETER SubscriptionId
    Subscription ID. Optional — uses the current `az account` if omitted.

.PARAMETER ParametersFile
    Path to a parameters JSON file. Default: main.parameters.example.json.

.EXAMPLE
    ./deploy.ps1 -ResourceGroup ia-prod

.EXAMPLE
    ./deploy.ps1 -ResourceGroup ia-prod -SizeProfile m -ExistingLogAnalyticsWorkspaceId "/subscriptions/.../workspaces/corp-law"
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [string]$Location = 'westeurope',

    [ValidateSet('xs', 's', 'm', 'l', 'xl')]
    [string]$SizeProfile = 's',

    [ValidateSet('stable', 'edge')]
    [string]$ImageChannel = 'stable',

    [string]$ExistingLogAnalyticsWorkspaceId = '',

    [string]$SubscriptionId,

    [string]$ParametersFile
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bicepFile = Join-Path $here 'main.bicep'
if (-not $ParametersFile) {
    $ParametersFile = Join-Path $here 'main.parameters.example.json'
}

Write-Host "=== Identity Atlas Azure deploy (Simple shape) ===" -ForegroundColor Cyan
Write-Host "  ResourceGroup : $ResourceGroup"
Write-Host "  Location      : $Location"
Write-Host "  SizeProfile   : $SizeProfile"
Write-Host "  ImageChannel  : $ImageChannel"
Write-Host "  Bicep         : $bicepFile"

# ── az login ────────────────────────────────────────────────────────────
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
Write-Host "`nStarting deployment. This takes ~5-7 minutes." -ForegroundColor Cyan
$deploymentName = "identityatlas-$(Get-Date -Format 'yyyyMMddHHmmss')"

$deployArgs = @(
    'deployment', 'group', 'create',
    '--resource-group', $ResourceGroup,
    '--name', $deploymentName,
    '--template-file', $bicepFile,
    '--parameters', "@$ParametersFile",
    '--parameters', "sizeProfile=$SizeProfile", "imageChannel=$ImageChannel",
    '--output', 'json'
)
if ($ExistingLogAnalyticsWorkspaceId) {
    $deployArgs += @('--parameters', "existingLogAnalyticsWorkspaceId=$ExistingLogAnalyticsWorkspaceId")
}

$result = az @deployArgs | ConvertFrom-Json

if ($LASTEXITCODE -ne 0 -or $result.properties.provisioningState -ne 'Succeeded') {
    Write-Host "`nDeployment failed. See errors above." -ForegroundColor Red
    Write-Host "Inspect: az deployment group show -g $ResourceGroup -n $deploymentName" -ForegroundColor Yellow
    exit 1
}

# ── Outputs ─────────────────────────────────────────────────────────────
Write-Host "`n=== Deployment succeeded ===" -ForegroundColor Green
$outputs = $result.properties.outputs
Write-Host "  App URL              : $($outputs.appUrl.value)" -ForegroundColor Cyan
Write-Host "  App hostname         : $($outputs.appHostname.value)"
Write-Host "  Name prefix used     : $($outputs.namePrefixUsed.value)"
Write-Host "  Key Vault            : $($outputs.keyVaultUri.value)"
Write-Host "  Postgres FQDN        : $($outputs.postgresFqdn.value)"
Write-Host "  Size profile applied : $($outputs.sizeProfileApplied.value)"
Write-Host "  LA workspace created : $($outputs.logAnalyticsCreated.value) (false = BYO)"

Write-Host "`nNext steps:" -ForegroundColor Cyan
Write-Host "  1. Open $($outputs.appUrl.value) — first paint takes ~20-30s while the container warms up"
Write-Host "  2. Admin → Crawlers to load demo data or connect Microsoft Graph"
Write-Host "  3. (Optional) Admin → Authentication to enable Entra ID sign-in"
