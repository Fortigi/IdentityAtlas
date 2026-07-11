<#
.SYNOPSIS
    Integration test for the Custom Connector registration and ingest round-trip.

.DESCRIPTION
    Verifies the full custom connector flow:
      1. Register a new crawler via POST /api/admin/crawlers
      2. Authenticate with the returned API key via GET /api/crawlers/whoami
      3. Push a test system via POST /api/ingest/systems using the key
      4. Push a test user via POST /api/ingest/principals
      5. Verify the data landed via GET /api/users
      6. Clean up: the crawler persists (no delete API) but the test data
         is ephemeral — it'll be wiped on the next clean-database cycle.

    Supports both colocated CI discovery (called with -ApiBaseUrl/-ApiKey) and
    standalone use from Run-NightlyLocal.ps1 (called with -WriteResult callback).

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER ApiKey
    Not used by this test (it registers its own connector and gets its own key),
    but declared to satisfy the colocated test parameter contract.

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }

.EXAMPLE
    pwsh -File tools/crawlers/custom-connector/Test-CustomConnectorCrawler.ps1 `
        -ApiBaseUrl http://localhost:3001/api
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$ApiKey = '',
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$standaloneFailures = 0

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "    $status  $Name  $Detail" -ForegroundColor $color
    if ($WriteResult) {
        & $WriteResult $Name $Passed $Detail
    } elseif (-not $Passed) {
        $script:standaloneFailures++
    }
}

Write-Host "`n=== Custom Connector Round-Trip ===" -ForegroundColor Cyan

$connectorKey = $null
$systemId = $null

# ─── 1. Register a custom crawler ────────────────────────────────
try {
    $r = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/crawlers" -Method Post `
        -ContentType 'application/json' -TimeoutSec 30 `
        -Body (@{ displayName = 'Nightly-Test-Connector'; description = 'Automated test — safe to delete' } | ConvertTo-Json)
    $connectorKey = $r.apiKey
    $ok = $null -ne $connectorKey -and $connectorKey.StartsWith('fgc_')
    Write-Result 'CustomConnector/Register' $ok "id=$($r.id) keyPrefix=$($connectorKey.Substring(0,8))..."
} catch {
    Write-Result 'CustomConnector/Register' $false $_.Exception.Message
}

if (-not $connectorKey) {
    Write-Result 'CustomConnector/Whoami' $false 'skipped: no API key from registration'
    Write-Result 'CustomConnector/IngestSystem' $false 'skipped: no API key'
    Write-Result 'CustomConnector/IngestUser' $false 'skipped: no API key'
    Write-Result 'CustomConnector/DataLanded' $false 'skipped: no API key'
    if (-not $WriteResult) { exit $standaloneFailures }
    return
}

$headers = @{ 'Authorization' = "Bearer $connectorKey"; 'Content-Type' = 'application/json' }

# ─── 2. Authenticate via whoami ──────────────────────────────────
try {
    $whoami = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers $headers -TimeoutSec 10
    $ok = $whoami.displayName -eq 'Nightly-Test-Connector'
    Write-Result 'CustomConnector/Whoami' $ok "name=$($whoami.displayName)"
} catch {
    Write-Result 'CustomConnector/Whoami' $false $_.Exception.Message
}

# ─── 3. Push a test system ───────────────────────────────────────
try {
    $r = Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/systems" -Method Post -Headers $headers `
        -Body (@{
            syncMode = 'delta'
            records = @(@{
                displayName = 'CustomConnector-TestSystem'
                systemType = 'NightlyTest'
                enabled = $true
                syncEnabled = $true
            })
        } | ConvertTo-Json -Depth 5) -TimeoutSec 30
    $systemId = if ($r.systemIds) { $r.systemIds[0] } else { $null }
    $ok = $null -ne $systemId
    Write-Result 'CustomConnector/IngestSystem' $ok "systemId=$systemId"
} catch {
    Write-Result 'CustomConnector/IngestSystem' $false $_.Exception.Message
}

# ─── 4. Push a test user ─────────────────────────────────────────
if ($systemId) {
    try {
        $r = Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/principals" -Method Post -Headers $headers `
            -Body (@{
                systemId = [int]$systemId
                syncMode = 'delta'
                records = @(@{
                    externalId = 'custom-connector-test-user'
                    displayName = 'Custom Connector Test User'
                    principalType = 'User'
                    accountEnabled = $true
                })
            } | ConvertTo-Json -Depth 5) -TimeoutSec 30
        $ok = $r.inserted -ge 1 -or $r.updated -ge 1
        Write-Result 'CustomConnector/IngestUser' $ok "inserted=$($r.inserted) updated=$($r.updated)"
    } catch {
        Write-Result 'CustomConnector/IngestUser' $false $_.Exception.Message
    }
} else {
    Write-Result 'CustomConnector/IngestUser' $false 'skipped: no systemId'
}

# ─── 5. Verify data landed ──────────────────────────────────────
try {
    $users = Invoke-RestMethod -Uri "$ApiBaseUrl/users?search=Custom+Connector+Test" -TimeoutSec 10
    $list = if ($users.data) { $users.data } else { $users }
    $found = @($list | Where-Object { $_.displayName -like '*Custom Connector Test*' })
    Write-Result 'CustomConnector/DataLanded' ($found.Count -ge 1) "found=$($found.Count)"
} catch {
    Write-Result 'CustomConnector/DataLanded' $false $_.Exception.Message
}

Write-Host "`n  Custom connector round-trip complete." -ForegroundColor Green

if (-not $WriteResult) { exit $standaloneFailures }
