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

.PARAMETER DeployReportGenerator
    Also deploy the experimental report generator: a small local model in its own
    container that turns a plain-language question into a report definition. Scales
    to zero, so it only costs while in use. Its ingress is protected by a
    per-deployment API key; re-running this script also narrows it to the web app's
    outbound addresses.

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

    # Deploy the experimental report generator (a small local model in its own
    # container, scaled to zero). Off by default.
    [switch]$DeployReportGenerator,

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
Write-Host "  ReportGen     : $(if ($DeployReportGenerator) { 'deployed (scales to zero)' } else { 'not deployed' })"
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

# ── Key Vault: make an older deployment updatable ───────────────────────
# The template reads the Postgres admin password out of Key Vault
# (kvRef.getSecret, SEC-2026-09 H-06). ARM resolves that reference during preflight,
# BEFORE it updates anything — so the template cannot switch template access on for
# its own vault. A deployment created before that change has the flag off, and every
# later update of it dies at submission with:
#
#   KeyVaultParameterReferenceSecretRetrieveFailed ... Access denied to first party
#   service ... Vault: <name>
#
# The same goes for the secret itself: preflight needs it to exist, while the
# bootstrap script that normally creates it runs later in the deployment. So both are
# settled here, once, before anything is deployed. Newer deployments already satisfy
# both and nothing is touched.
function Get-VaultsMissingTemplateAccess {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$VaultListJson)

    if ([string]::IsNullOrWhiteSpace($VaultListJson)) { return @() }
    return @($VaultListJson | ConvertFrom-Json |
        Where-Object { -not $_.templateDeployment } |
        ForEach-Object { $_.name })
}

# 32 random alphanumerics plus a fixed "Aa1", so the value always satisfies the
# Postgres complexity rule whatever the random part happens to be. Same shape as the
# bootstrap script's, which owns the password from then on.
function New-PostgresPassword {
    $bytes = [byte[]]::new(64)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $alnum = ([System.Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '')
    return ($alnum.Substring(0, 32) + 'Aa1')
}

# Reading a secret is the Key Vault DATA plane, which the operator's own account often
# cannot touch: these vaults use access policies, and the template grants them to the
# deployment's managed identities, not to people. "Cannot read it" and "it is not there"
# then look the same from outside, and creating a password that already exists would
# change the database password for no reason. So the two are told apart and a missing
# permission is reported, never guessed around.
function Get-SecretState {
    param(
        [Parameter(Mandatory)][int]$ExitCode,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Output
    )

    if ($ExitCode -eq 0) { return 'present' }
    if ($Output -match 'SecretNotFound|was not found in this key vault|does not exist') { return 'missing' }
    if ($Output -match 'Forbidden|does not have secrets get permission|AuthorizationFailed|token_expired|invalid_grant') { return 'denied' }
    return 'denied'
}

function Initialize-ExistingVault {
    param([Parameter(Mandatory)][string]$ResourceGroup)

    $listed = az keyvault list -g $ResourceGroup `
        --query "[].{name:name, templateDeployment:properties.enabledForTemplateDeployment}" -o json 2>$null
    foreach ($vault in Get-VaultsMissingTemplateAccess -VaultListJson ([string]$listed)) {
        Write-Host "  Key Vault        : enabling template access on $vault (needed to read the Postgres password)" -ForegroundColor DarkGray
        az keyvault update -n $vault -g $ResourceGroup --enabled-for-template-deployment true --output none
    }

    # Every vault in the group is listed, but only this deployment's holds the secret.
    $vaultName = az keyvault list -g $ResourceGroup --query "[0].name" -o tsv 2>$null
    if (-not $vaultName) { return }

    $shown = az keyvault secret show --vault-name $vaultName --name postgres-admin-password 2>&1 | Out-String
    switch (Get-SecretState -ExitCode $LASTEXITCODE -Output $shown) {
        'present' { return }
        'missing' {
            Write-Host "  Key Vault        : creating postgres-admin-password in $vaultName (the deployment sets the server to it)" -ForegroundColor DarkGray
            az keyvault secret set --vault-name $vaultName --name postgres-admin-password --value (New-PostgresPassword) --output none
            if ($LASTEXITCODE -ne 0) { Write-VaultPermissionHelp -VaultName $vaultName; exit 1 }
        }
        default {
            Write-Host "`nCannot read the secret 'postgres-admin-password' in $vaultName." -ForegroundColor Red
            Write-VaultPermissionHelp -VaultName $vaultName
            exit 1
        }
    }
}

function Write-VaultPermissionHelp {
    param([Parameter(Mandatory)][string]$VaultName)

    $who = az ad signed-in-user show --query userPrincipalName -o tsv 2>$null
    Write-Host "The deployment needs that secret to exist before it starts, and your account cannot see it." -ForegroundColor Yellow
    Write-Host "Either your sign-in has expired (run 'az login' and try again), or this vault's access" -ForegroundColor Yellow
    Write-Host "policies do not include you — they are granted to the deployment's managed identities." -ForegroundColor Yellow
    Write-Host "  az login" -ForegroundColor Gray
    Write-Host "  az keyvault set-policy -n $VaultName --upn $(if ($who) { $who } else { '<your-upn>' }) --secret-permissions get list set" -ForegroundColor Gray
}

Initialize-ExistingVault -ResourceGroup $ResourceGroup

# The report generator has public ingress (no VNet in this deployment shape) and its
# API key is what protects it. This narrows it further to the addresses the web app can
# call out from — but only once that app exists, because those addresses do not exist
# until it does. So a first deployment ships key-only and any later run adds the
# allow-list. Deliberately not derived inside the template: an ARM loop needs its
# length before the deployment starts. Returns the /32 CIDRs, or nothing.
function Get-ReportGeneratorCallerCidrs {
    param([Parameter(Mandatory)][string]$ResourceGroup)

    # This shape deploys exactly one App Service into the group.
    $webAppName = az webapp list -g $ResourceGroup --query "[0].name" -o tsv 2>$null
    if (-not $webAppName) { return }
    $outboundIps = az webapp show -g $ResourceGroup -n $webAppName --query possibleOutboundIpAddresses -o tsv 2>$null
    if (-not $outboundIps) { return }
    return @($outboundIps -split ',' | Where-Object { $_ } | ForEach-Object { "$($_.Trim())/32" })
}

# An array parameter goes to az in a FILE, never inline. On Windows `az` is a batch
# wrapper: cmd.exe strips the double quotes out of an inline
# `name=["1.2.3.4/32", ...]`, az receives `[1.2.3.4/32, ...]` and refuses it with
# "Failed to parse string as JSON ... Expecting ',' delimiter". A parameters file is
# read by az itself, so nothing can rewrite it on the way.
# Returns the path of a temporary file the caller deletes.
function New-CallerIpsParameterFile {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Cidrs,
        [Parameter(Mandatory)][string]$Directory
    )

    # @() around $Cidrs: a one-element array otherwise serialises as a bare string,
    # and the template rejects it as not an array.
    $content = [ordered]@{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = [ordered]@{
            reportGeneratorAllowedCallerIps = [ordered]@{ value = @($Cidrs) }
        }
    } | ConvertTo-Json -Depth 6
    $path = Join-Path $Directory "caller-ips-$([guid]::NewGuid().ToString('N')).params.json"
    Set-Content -LiteralPath $path -Value $content -Encoding utf8
    return $path
}

# ── Deploy ──────────────────────────────────────────────────────────────
Write-Host "`nStarting deployment. This takes ~5-7 minutes." -ForegroundColor Cyan
$deploymentName = "identityatlas-$(Get-Date -Format 'yyyyMMddHHmmss')"

$callerIpsFile = $null
$deployArgs = @(
    'deployment', 'group', 'create',
    '--resource-group', $ResourceGroup,
    '--name', $deploymentName,
    '--template-file', $bicepFile,
    '--parameters', "@$ParametersFile",
    '--parameters', "sizeProfile=$SizeProfile", "imageChannel=$ImageChannel",
    '--output', 'json'
)
if ($DeployReportGenerator) {
    $deployArgs += @('--parameters', 'deployReportGenerator=true')
    # @(): a function returning a one-element array hands back a bare string otherwise.
    $cidrs = @(Get-ReportGeneratorCallerCidrs -ResourceGroup $ResourceGroup)
    if ($cidrs) {
        $callerIpsFile = New-CallerIpsParameterFile -Cidrs $cidrs -Directory ([System.IO.Path]::GetTempPath())
        $deployArgs += @('--parameters', "@$callerIpsFile")
        Write-Host "  ReportGen ingress    : limited to $($cidrs.Count) web-app address(es)" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  ReportGen ingress    : API key only on this deployment; re-run once the web app exists to add the IP allow-list" -ForegroundColor DarkGray
    }
}
if ($ExistingLogAnalyticsWorkspaceId) {
    $deployArgs += @('--parameters', "existingLogAnalyticsWorkspaceId=$ExistingLogAnalyticsWorkspaceId")
}

try {
    $result = az @deployArgs | ConvertFrom-Json
}
finally {
    if ($callerIpsFile) { Remove-Item -LiteralPath $callerIpsFile -Force -ErrorAction SilentlyContinue }
}

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
