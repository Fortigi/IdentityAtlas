[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [string]$ApiKey = ''
)

# Test-AzureRMCrawler — discovered + run by the PR integration CI.
#
# Structural + determinism checks run everywhere (no Azure needed). A live end-to-end check
# runs only when TEST_AZURE_TENANT_ID / TEST_AZURE_CLIENT_ID / TEST_AZURE_CLIENT_SECRET are set
# (e.g. as GitHub Actions secrets); otherwise it is skipped cleanly.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
$failures = 0
function Report { param([string]$Name, [bool]$Ok, [string]$Detail = '')
    if ($Ok) { Write-Host "  [PASS] $Name" -ForegroundColor Green }
    else { Write-Host "  [FAIL] $Name $Detail" -ForegroundColor Red; $script:failures++ }
}

Write-Host "`n=== Test-AzureRMCrawler ===" -ForegroundColor Cyan

# 1. Manifest is valid and points at the entry point.
$manifest = Get-Content (Join-Path $here 'crawler.json') -Raw | ConvertFrom-Json
Report 'manifest type is azure-rm' ($manifest.type -eq 'azure-rm')
Report 'manifest entryPoint exists' (Test-Path (Join-Path $here $manifest.entryPoint))
Report 'manifest requires SP credentials' (@($manifest.configSchema.required) -contains 'tenantId' -and @($manifest.configSchema.required) -contains 'clientSecret')

# 2. Helpers dot-source and expose the expected functions.
. (Join-Path $here 'Get-AzureRMHelpers.ps1')
foreach ($fn in 'Connect-AzureRM', 'Invoke-ARMList', 'Invoke-ARMGet') {
    Report "function $fn defined" ([bool](Get-Command $fn -ErrorAction SilentlyContinue))
}

# 3. Deterministic capability/scope ids — shared with the engine (must match across runs).
. (Join-Path $here '..' 'shared' 'Get-CapabilityId.ps1')
$id1 = Get-CapabilityId -TargetNodeId '/subscriptions/abc' -CapabilityId 'azure-scope'
$id2 = Get-CapabilityId -TargetNodeId '/subscriptions/abc' -CapabilityId 'azure-scope'
Report 'scope node id is deterministic' ($id1 -eq $id2)
Report 'scope node id is uuid-shaped' ($id1 -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
Report 'distinct scopes -> distinct ids' ((Get-CapabilityId -TargetNodeId '/subscriptions/abc' -CapabilityId 'azure-scope') -ne (Get-CapabilityId -TargetNodeId '/subscriptions/def' -CapabilityId 'azure-scope'))

# 4. Live end-to-end (only with real credentials).
$tid = $env:TEST_AZURE_TENANT_ID; $cid = $env:TEST_AZURE_CLIENT_ID; $secret = $env:TEST_AZURE_CLIENT_SECRET
if (-not $tid -or -not $cid -or -not $secret) {
    Write-Host "  [SKIP] live Azure RM test — TEST_AZURE_* not set" -ForegroundColor Yellow
} elseif (-not (Get-Command Get-FGAccessToken -ErrorAction SilentlyContinue)) {
    Write-Host "  [SKIP] live Azure RM test — Get-FGAccessToken (Graph SDK) not loaded" -ForegroundColor Yellow
} else {
    Connect-AzureRM -TenantId $tid -ClientId $cid -ClientSecret $secret
    $subs = Invoke-ARMList -Path '/subscriptions?api-version=2022-12-01'
    Report 'live: at least one accessible subscription' ($subs.Count -ge 1) "(got $($subs.Count))"
}

if ($failures -gt 0) { Write-Error "Test-AzureRMCrawler: $failures check(s) failed"; exit 1 }
Write-Host "Test-AzureRMCrawler: all checks passed" -ForegroundColor Green
