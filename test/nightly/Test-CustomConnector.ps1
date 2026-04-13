<#
.SYNOPSIS
    Nightly test step: Custom Connector registration + ingest round-trip.

.DESCRIPTION
    Verifies the full custom connector flow:
      1. Register a new crawler via POST /api/admin/crawlers
      2. Authenticate with the returned API key via GET /api/crawlers/whoami
      3. Push a test system via POST /api/ingest/systems using the key
      4. Push a test user via POST /api/ingest/principals
      5. Verify the data landed via GET /api/users
      6. Clean up: the crawler persists (no delete API) but the test data
         is ephemeral — it'll be wiped on the next clean-database cycle.

    Designed to be called from Run-NightlyLocal.ps1 with a WriteResult callback.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$standaloneFailures = 0

function Report-Result {
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

$apiKey = $null
$systemId = $null

# ─── 1. Register a custom crawler ────────────────────────────────
try {
    $r = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/crawlers" -Method Post `
        -ContentType 'application/json' -TimeoutSec 30 `
        -Body (@{ displayName = 'Nightly-Test-Connector'; description = 'Automated test — safe to delete' } | ConvertTo-Json)
    $apiKey = $r.apiKey
    $ok = $null -ne $apiKey -and $apiKey.StartsWith('fgc_')
    Report-Result 'CustomConnector/Register' $ok "id=$($r.id) keyPrefix=$($apiKey.Substring(0,8))..."
} catch {
    Report-Result 'CustomConnector/Register' $false $_.Exception.Message
}

if (-not $apiKey) {
    Report-Result 'CustomConnector/Whoami' $false 'skipped: no API key from registration'
    Report-Result 'CustomConnector/IngestSystem' $false 'skipped: no API key'
    Report-Result 'CustomConnector/IngestUser' $false 'skipped: no API key'
    Report-Result 'CustomConnector/DataLanded' $false 'skipped: no API key'
    if (-not $WriteResult) { exit $standaloneFailures }
    return
}

$headers = @{ 'Authorization' = "Bearer $apiKey"; 'Content-Type' = 'application/json' }

# ─── 2. Authenticate via whoami ──────────────────────────────────
try {
    $whoami = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers $headers -TimeoutSec 10
    $ok = $whoami.displayName -eq 'Nightly-Test-Connector'
    Report-Result 'CustomConnector/Whoami' $ok "name=$($whoami.displayName)"
} catch {
    Report-Result 'CustomConnector/Whoami' $false $_.Exception.Message
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
    Report-Result 'CustomConnector/IngestSystem' $ok "systemId=$systemId"
} catch {
    Report-Result 'CustomConnector/IngestSystem' $false $_.Exception.Message
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
        Report-Result 'CustomConnector/IngestUser' $ok "inserted=$($r.inserted) updated=$($r.updated)"
    } catch {
        Report-Result 'CustomConnector/IngestUser' $false $_.Exception.Message
    }
} else {
    Report-Result 'CustomConnector/IngestUser' $false 'skipped: no systemId'
}

# ─── 5. Verify data landed ──────────────────────────────────────
try {
    $users = Invoke-RestMethod -Uri "$ApiBaseUrl/users?search=Custom+Connector+Test" -TimeoutSec 10
    $list = if ($users.data) { $users.data } else { $users }
    $found = @($list | Where-Object { $_.displayName -like '*Custom Connector Test*' })
    Report-Result 'CustomConnector/DataLanded' ($found.Count -ge 1) "found=$($found.Count)"
} catch {
    Report-Result 'CustomConnector/DataLanded' $false $_.Exception.Message
}

Write-Host "`n  Custom connector round-trip complete." -ForegroundColor Green

if (-not $WriteResult) { exit $standaloneFailures }
