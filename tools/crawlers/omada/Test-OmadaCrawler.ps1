<#
.SYNOPSIS
    End-to-end integration test for the Omada IGA crawler.

.DESCRIPTION
    Starts a mock OData HTTP server, runs a full Omada crawler job via the
    Identity Atlas dispatch pipeline, and verifies that data landed in the
    database.

    Requires the full Identity Atlas Docker stack to be running (postgres + web API).

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL. Default: http://localhost:3001/api

.PARAMETER ApiKey
    Identity Atlas crawler API key (used for ingest endpoints).

.PARAMETER WriteResult
    Optional ScriptBlock callback { param($Name, $Passed, $Detail) } for nightly runner integration.
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$ApiBaseUrl            = $ApiBaseUrl.TrimEnd('/')
$standaloneFailures    = 0

. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared' 'Test-Helpers.ps1')

function Invoke-AtlasApi {
    param([string]$Method, [string]$Path, [hashtable]$Body = @{})
    $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    $params  = @{ Uri = "$ApiBaseUrl$Path"; Method = $Method; Headers = $headers; ErrorAction = 'Stop' }
    if ($Body.Count -gt 0) { $params['Body'] = ($Body | ConvertTo-Json -Depth 20 -Compress) }
    return Invoke-RestMethod @params
}

function Wait-JobComplete {
    param([int]$JobId, [int]$TimeoutSec = 120)
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSec)
    while ([datetime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 3
        $j = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/crawler-jobs/$JobId" `
            -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction SilentlyContinue
        if ($j.status -in @('completed', 'failed')) { return $j }
    }
    return $null
}

Write-Host "`n=== Omada IGA Crawler Integration Test ===" -ForegroundColor Cyan

# ── Load mock server ──────────────────────────────────────────────────────────
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared' 'Start-MockODataServer.ps1')

# ── Mock entity data ──────────────────────────────────────────────────────────
$identityUid  = 'bbbbbbbb-bbbb-0001-0000-bbbbbbbbbbbb'
$userUid      = 'cccccccc-cccc-0001-0000-cccccccccccc'
$resourceUid  = 'dddddddd-dddd-0001-0000-dddddddddddd'
$assignmentUid = 'eeeeeeee-eeee-0001-0000-eeeeeeeeeeee'

$mockEntities = @{
    'System' = @()   # empty — crawler falls back to default system registration

    'Identity' = @(@{
        UId          = $identityUid
        IDENTITYID   = 'TEST-IDENT-001'
        IDENTITYTYPE = @{ Value = 'Employee' }
        FIRSTNAME    = 'Integration'
        LASTNAME     = 'TestUser'
        EMAIL        = 'integration.testuser@example.com'
        Deleted      = $false
    })

    'User' = @(@{
        UId          = $userUid
        FIRSTNAME    = 'Integration'
        LASTNAME     = 'TestUser'
        EMAIL        = 'integration.testuser@example.com'
        UserName     = 'integration.testuser'
        Inactive     = $false
        Deleted      = $false
        IDENTITYREF  = @{ IDENTITYID = 'TEST-IDENT-001'; UId = $identityUid }
    })

    'Resource' = @(@{
        UId            = $resourceUid
        NAME           = 'Integration Test Role'
        DisplayName    = 'Integration Test Role'
        ROLECATEGORY   = @{ Value = 'Permission' }
        RESOURCESTATUS = @{ Value = 'Active' }
        Deleted        = $false
    })

    'Resourceassignment' = @(@{
        UId            = $assignmentUid
        IDENTITYREF    = @{ UId = $identityUid; IDENTITYID = 'TEST-IDENT-001' }
        ROLEREF        = @{ UId = $resourceUid; DisplayName = 'Integration Test Role' }
        ROLEASSNSTATUS = @{ Value = 'Active' }
        Deleted        = $false
    })
}

$edmxSets = @('System', 'Identity', 'User', 'Resource', 'Resourceassignment')

# ── Start mock server ─────────────────────────────────────────────────────────
$mock = $null
$configId = $null
$cfgResult2 = $null

try {
    $mock = Start-MockODataServer -EntitySets $mockEntities -EdmxEntitySets $edmxSets
    Write-Host "  Mock OData server started on port $($mock.Port)" -ForegroundColor Gray

    # ── Register Omada crawler config ─────────────────────────────────────────
    $runTag = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $config = @{
        baseUrl    = "http://host.docker.internal:$($mock.Port)/odata/dataobjects"
        authMethod = 'BasicAuth'
        username   = 'testuser'
        password   = 'testpass'
        # Minimize scope: only the phases needed for the core assertions
        selectedObjects = @{
            contexts       = $false
            identities     = $true
            accounts       = $true
            contextMembers = $false
            resources      = $true
            entitlements   = $false
            assignments    = $true
            cras           = $false
        }
    }

    $configName = "omada-integration-test-$runTag"
    try {
        $cfgResult = Invoke-AtlasApi -Method POST -Path '/admin/crawler-configs' -Body @{
            crawlerType = 'omada'
            displayName = $configName
            config      = $config
        }
        $configId = $cfgResult.id
        Write-Host "  Crawler config registered: $configId" -ForegroundColor Gray
    } catch {
        Write-Result 'Omada/Setup — register crawler config' $false $_.Exception.Message
        throw
    }

    # ── Dispatch crawler job ──────────────────────────────────────────────────
    $job = $null
    try {
        $job = Invoke-AtlasApi -Method POST -Path '/admin/crawler-jobs' -Body @{
            jobType  = 'omada'
            configId = $configId
        }
        Write-Host "  Job queued: $($job.id)" -ForegroundColor Gray
    } catch {
        Write-Result 'Omada/Setup — queue crawler job' $false $_.Exception.Message
        throw
    }

    # ── Wait for completion ───────────────────────────────────────────────────
    $completed = Wait-JobComplete -JobId $job.id -TimeoutSec 120
    if ($null -eq $completed) {
        Write-Result 'Omada/Job — completed within 120s' $false '(timed out)'
        throw 'Job timed out'
    }

    $passed = $completed.status -eq 'completed'
    Write-Result 'Omada/Job — completed successfully' $passed "(status: $($completed.status))"

    if (-not $passed) {
        Write-Host "  Job log: $ApiBaseUrl/admin/crawler-jobs/$($job.id)/log" -ForegroundColor Yellow
        throw "Job failed with status: $($completed.status)"
    }

    # ── Assert: system registered + counts scoped to this run ────────────────
    # The systems endpoint returns resourceCount/principalCount inline, so a
    # single call both verifies the system exists AND avoids asserting against
    # the full database (prior CI steps may have loaded other systems/users).
    # We identify our system by the mock port which is OS-assigned and unique.
    $thisSystem = $null
    try {
        $systems = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" `
            -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $thisSystem = @($systems) | Where-Object { $_.displayName -like "*:$($mock.Port)/*" } | Select-Object -First 1
        Write-Result 'Omada/Data — system registered' ($null -ne $thisSystem) `
            "$(if ($thisSystem) { "($($thisSystem.displayName))" } else { '(not found — port $($mock.Port) not in any system displayName)' })"
    } catch {
        Write-Result 'Omada/Data — system registered' $false $_.Exception.Message
    }

    # Diagnostic: log the systems API's own principalCount/resourceCount so we can
    # compare against the direct-query values below and detect discrepancies.
    if ($thisSystem) {
        Write-Host "  [diag] systems API: principalCount=$($thisSystem.principalCount) resourceCount=$($thisSystem.resourceCount) systemId=$($thisSystem.id)" -ForegroundColor DarkGray
    }

    # ── Assert: principal ingested (scoped to this run via unique test email) ──
    # Search by the mock user's email — unique across CI runs (no real user would
    # have 'integration.testuser@example.com'), so this can't be satisfied by
    # Entra ID or demo data from earlier CI steps.
    try {
        $usersResp = Invoke-RestMethod -Uri "$ApiBaseUrl/users?search=integration.testuser&limit=5" `
            -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $principalCount = if ($usersResp.users)           { $usersResp.users.Count }
                          elseif ($usersResp.data)        { $usersResp.data.Count }
                          elseif ($usersResp -is [array]) { $usersResp.Count }
                          else { 0 }
        Write-Result 'Omada/Data — principal ingested' ($principalCount -ge 1) `
            "($principalCount user(s) matching 'integration.testuser')"
    } catch {
        Write-Result 'Omada/Data — principal ingested' $false $_.Exception.Message
    }

    # ── Assert: resource ingested (scoped to this run's system via systemId) ───
    # Resources support ?systemId= filtering — use the system we found by port.
    try {
        $systemId = if ($thisSystem) { $thisSystem.id } else { 0 }
        $resResp  = Invoke-RestMethod -Uri "$ApiBaseUrl/resources?systemId=$systemId&limit=10" `
            -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $resourceCount = if ($resResp.data)           { $resResp.data.Count }
                         elseif ($resResp -is [array]) { $resResp.Count }
                         else { 0 }
        Write-Result 'Omada/Data — resource ingested' ($resourceCount -ge 1) `
            "($resourceCount resource(s) in system $systemId)"
    } catch {
        Write-Result 'Omada/Data — resource ingested' $false $_.Exception.Message
    }

    # ── Assert: sync log entry created ───────────────────────────────────────
    try {
        $syncLog = Invoke-RestMethod -Uri "$ApiBaseUrl/sync-log" `
            -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction Stop
        $syncEntries = if ($syncLog -is [array]) { $syncLog.Count }
                       elseif ($syncLog.data) { $syncLog.data.Count }
                       else { 0 }
        Write-Result 'Omada/Data — sync log entry created' ($syncEntries -ge 1) `
            "($syncEntries sync log entries)"
    } catch {
        Write-Result 'Omada/Data — sync log entry created' $false $_.Exception.Message
    }

    # ── Test: partial failure (mock returns 500 mid-crawl) ────────────────────
    # Reuse the same mock — switch it to error-after-1-request mode via /_control.
    # Use maxRetries=0 in the config so the crawler fails immediately on 500 without
    # waiting through 5 retry delays (62s per phase) — keeps the test under 60s.
    # Only enable identities so a single phase fails fast and the job is marked 'failed'.
    Write-Host "`n  Partial failure test:" -ForegroundColor Gray
    try {
        Invoke-RestMethod -Uri "http://localhost:$($mock.Port)/_control" -Method POST `
            -ContentType 'application/json' -Body '{"errorAfterN":1,"resetCount":true}' | Out-Null

        $pfConfig = @{
            baseUrl    = "http://host.docker.internal:$($mock.Port)/odata/dataobjects"
            authMethod = 'BasicAuth'
            username   = 'testuser'
            password   = 'testpass'
            maxRetries = 0
            selectedObjects = @{
                contexts = $false; identities = $true; accounts = $false
                contextMembers = $false; resources = $false; entitlements = $false
                assignments = $false; cras = $false
            }
        }
        $cfgResult2 = Invoke-AtlasApi -Method POST -Path '/admin/crawler-configs' -Body @{
            crawlerType = 'omada'; displayName = "omada-partial-fail-$runTag"; config = $pfConfig
        }
        $job2 = Invoke-AtlasApi -Method POST -Path '/admin/crawler-jobs' -Body @{
            jobType = 'omada'; configId = $cfgResult2.id
        }
        $completed2 = Wait-JobComplete -JobId $job2.id -TimeoutSec 60
        $pfPassed = ($null -ne $completed2) -and ($completed2.status -eq 'failed')
        Write-Result 'Omada/Error — partial failure (500 mid-crawl) detected' $pfPassed `
            "(status: $($completed2.status))"
    } catch {
        Write-Result 'Omada/Error — partial failure setup' $false $_.Exception.Message
    } finally {
        # Reset mock to normal state for any tests that might follow
        try {
            Invoke-RestMethod -Uri "http://localhost:$($mock.Port)/_control" -Method POST `
                -ContentType 'application/json' -Body '{"reset":true}' | Out-Null
        } catch {}
    }

} catch {
    Write-Host "  Fatal test error: $($_.Exception.Message)" -ForegroundColor Red
    $script:standaloneFailures++
} finally {
    # Delete crawler configs so CI runs don't accumulate stale entries.
    foreach ($id in @($configId, $(if ($null -ne $cfgResult2) { $cfgResult2.id }))) {
        if (-not $id) { continue }
        try { Invoke-AtlasApi -Method DELETE -Path "/admin/crawler-configs/$id" | Out-Null } catch {}
    }
    if ($mock) { Stop-MockODataServer -Mock $mock }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ''
if (-not $WriteResult) {
    if ($standaloneFailures -gt 0) {
        Write-Host "Omada integration tests: $standaloneFailures FAILED" -ForegroundColor Red
        exit 1
    } else {
        Write-Host 'Omada integration tests: all passed' -ForegroundColor Green
        exit 0
    }
}
