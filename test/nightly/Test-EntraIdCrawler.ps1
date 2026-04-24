<#
.SYNOPSIS
    Nightly test step: exercise the Entra ID crawler end-to-end against a real
    tenant. Designed to be called from Run-NightlyLocal.ps1 but also runnable
    standalone for ad-hoc verification.

.DESCRIPTION
    Runs a series of scenarios that hit different code paths through the crawler:

      1. Validate-Only       — POST /admin/validate-graph-credentials only.
                               Confirms creds + permission detection work.
      2. Identity-Only       — selectedObjects = { identity: true }.
                               Smallest possible sync (users + identities).
      3. Users-Groups        — selectedObjects = { usersGroupsMembers: true }.
                               Hits the parallel group-children fetcher.
      4. Full-Sync           — all object types enabled.
                               Hits governance, directory roles, app roles too.
      5. With-Identity-Filter — Full sync + identity filter on a real attribute.
                               Verifies the filter logic doesn't break the run.

    Each scenario:
      - Deletes any leftover config from a previous run (deterministic state).
      - POSTs the config via /api/admin/crawler-configs.
      - POSTs a job via /api/admin/crawler-jobs (with configId).
      - Polls /api/admin/crawler-jobs/:id every 3s until terminal state.
      - Asserts: status == 'completed' AND duration < timeout AND optional
        post-sync queries return non-zero counts where expected.
      - Records pass/fail back to the parent runner via the supplied
        WriteResult callback.

    Credentials are loaded in this order (first hit wins):
      1. Environment variables (TEST_GRAPH_TENANT_ID / CLIENT_ID / CLIENT_SECRET)
      2. test/test.secrets.json (gitignored)
    If neither is available, the entire phase is skipped with a clear message
    so CI runs without secrets just see a "skipped" entry instead of failing.

.PARAMETER ApiBaseUrl
    Base URL of the Identity Atlas API. Default: http://localhost:3001/api

.PARAMETER ApiKey
    Crawler API key for the built-in worker (issued by /api/admin/crawlers).
    The parent runner extracts this earlier in the pipeline.

.PARAMETER LogFolder
    Where to write per-scenario logs. Created if missing.

.PARAMETER WriteResult
    ScriptBlock signature: { param($Name, $Passed, $Detail) ... }
    Lets the parent runner record results into its central hashtable. When
    omitted (standalone use), results are printed and a final exit code is
    returned (count of failures).

.PARAMETER PerJobTimeoutSeconds
    How long to wait for an individual scenario job before declaring failure.
    Default: 600 (10 minutes). The iidemo tenant should complete in <60s
    even at full sync, so 600 is a generous safety net.

.PARAMETER Scenarios
    Optional array of scenario names to run. Default: all five.
    Useful for ad-hoc debugging: -Scenarios 'Validate-Only','Identity-Only'

.PARAMETER KeepConfigs
    Don't delete the test CrawlerConfigs at the end. Default: configs are
    cleaned up so the next run starts fresh and the Configured Crawlers UI
    doesn't fill up with test entries.

.EXAMPLE
    pwsh -File test\nightly\Test-EntraIdCrawler.ps1 `
        -ApiBaseUrl http://localhost:3001/api -ApiKey fgc_abc... `
        -LogFolder C:\tmp\entra-test
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [string]$LogFolder,
    [scriptblock]$WriteResult,
    [int]$PerJobTimeoutSeconds = 600,
    [string[]]$Scenarios,
    [switch]$KeepConfigs,
    # When true (the default on CI against the demo tenant), the pre-flight
    # fails if *any* permission in GRAPH_PERMISSION_MAP is reported as
    # ungranted. This is how we catch regressions like the April 2026
    # DelegatedPermissionGrant.Read.All GUID bug, where the endpoint silently
    # reported a granted permission as missing because the wizard was asking
    # about the wrong app-role id. Pass -StrictPermissions:$false to run
    # against a tenant with intentionally reduced permissions.
    # ([bool] rather than [switch] so a default of $true doesn't trip
    # PSAvoidDefaultValueSwitchParameter.)
    [bool]$StrictPermissions = $true
)

$ErrorActionPreference = 'Continue'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

# A consistent display-name prefix so we can find and clean up our own configs
# without touching anything the user created manually.
$ConfigPrefix = 'NightlyTest — '

# Default scenarios when -Scenarios isn't passed.
$AllScenarios = @(
    'Validate-Only',
    'Identity-Only',
    'Users-Groups',
    'Full-Sync',
    'With-Identity-Filter'
)
if (-not $Scenarios -or $Scenarios.Count -eq 0) { $Scenarios = $AllScenarios }

if (-not (Test-Path $LogFolder)) {
    New-Item -ItemType Directory -Path $LogFolder -Force | Out-Null
}

# ─── Result reporting ────────────────────────────────────────────
# When called from Run-NightlyLocal.ps1, results flow back via $WriteResult.
# When run standalone, we keep our own counter so the script can return a
# meaningful exit code.
$standaloneFailures = 0
function Report-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "  $status  $Name  $Detail" -ForegroundColor $color
    if ($WriteResult) {
        & $WriteResult $Name $Passed $Detail
    } elseif (-not $Passed) {
        $script:standaloneFailures++
    }
}

# ─── Credential loading ──────────────────────────────────────────
function Get-TestGraphCreds {
    # 1. Environment variables take precedence so CI can inject without writing files.
    $envTenant = $env:TEST_GRAPH_TENANT_ID
    $envClient = $env:TEST_GRAPH_CLIENT_ID
    $envSecret = $env:TEST_GRAPH_CLIENT_SECRET
    if ($envTenant -and $envClient -and $envSecret) {
        return @{ tenantId = $envTenant; clientId = $envClient; clientSecret = $envSecret; source = 'env vars' }
    }

    # 2. Fall back to the gitignored secrets file.
    $secretsPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'test.secrets.json'
    if (Test-Path $secretsPath) {
        try {
            $j = Get-Content $secretsPath -Raw | ConvertFrom-Json
            if ($j.graph.tenantId -and $j.graph.clientId -and $j.graph.clientSecret) {
                # Reject the template placeholder so a forgotten copy doesn't show as a real cred
                if ($j.graph.tenantId -match '^0{8}-0{4}') {
                    Write-Host "  Note: test.secrets.json still contains placeholder values" -ForegroundColor Yellow
                    return $null
                }
                return @{
                    tenantId     = $j.graph.tenantId
                    clientId     = $j.graph.clientId
                    clientSecret = $j.graph.clientSecret
                    source       = 'test.secrets.json'
                }
            }
        } catch {
            Write-Host "  Note: failed to parse test.secrets.json — $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    return $null
}

$creds = Get-TestGraphCreds
if (-not $creds) {
    Write-Host "  SKIP  Entra ID crawler tests — no test credentials available" -ForegroundColor Yellow
    Write-Host "        Set TEST_GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET env vars" -ForegroundColor Gray
    Write-Host "        OR copy test/test.secrets.json.template to test/test.secrets.json and fill it in" -ForegroundColor Gray
    if ($WriteResult) {
        & $WriteResult 'EntraID-Crawler-Tests' $true 'skipped (no creds)'
    }
    return 0
}
Write-Host "  Credentials loaded from $($creds.source) — tenant $($creds.tenantId)" -ForegroundColor Gray

# ─── HTTP helpers ─────────────────────────────────────────────────
# These talk to the local Identity Atlas API directly. Auth is the user-facing
# layer (no auth in local Docker by default), so no bearer needed for /admin/*.
# The crawler API key is only required for /api/ingest/* and /api/crawlers/*.
function Invoke-LocalApi {
    param([string]$Path, [string]$Method = 'GET', $Body = $null)
    $uri = "$ApiBaseUrl$Path"
    $params = @{ Uri = $uri; Method = $Method; TimeoutSec = 30; ErrorAction = 'Stop' }
    if ($Body) {
        $params['ContentType'] = 'application/json'
        $params['Body']        = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }
    return Invoke-RestMethod @params
}

# ─── Cleanup helpers ─────────────────────────────────────────────
function Remove-PreviousNightlyConfigs {
    # Wipe any test configs left behind by an earlier run so we start clean.
    try {
        $existing = Invoke-LocalApi -Path '/admin/crawler-configs'
        foreach ($c in $existing) {
            if ($c.displayName -and $c.displayName.StartsWith($ConfigPrefix)) {
                try {
                    Invoke-LocalApi -Path "/admin/crawler-configs/$($c.id)" -Method DELETE | Out-Null
                } catch {
                    Write-Host "    cleanup: failed to delete config $($c.id) — $($_.Exception.Message)" -ForegroundColor DarkGray
                }
            }
        }
    } catch {
        Write-Host "    cleanup: list configs failed — $($_.Exception.Message)" -ForegroundColor DarkGray
    }
}

# ─── Wait-for-job poller ──────────────────────────────────────────
# Polls /admin/crawler-jobs/:id at 3s intervals, returns the final job object.
# Times out (returns $null + error message) at PerJobTimeoutSeconds.
function Wait-ForJob {
    param([int]$JobId, [string]$ScenarioName)
    $deadline = (Get-Date).AddSeconds($PerJobTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        try {
            $job = Invoke-LocalApi -Path "/admin/crawler-jobs/$JobId"
        } catch {
            return @{ ok = $false; reason = "polling failed: $($_.Exception.Message)" }
        }
        if ($job.status -in @('completed','failed','cancelled')) {
            return @{ ok = ($job.status -eq 'completed'); job = $job; reason = "ended in $($job.status)" }
        }
    }
    return @{ ok = $false; reason = "timeout after ${PerJobTimeoutSeconds}s" }
}

# ─── Scenario runner ──────────────────────────────────────────────
# Builds a CrawlerConfig, queues a job, waits, runs assertions. Each scenario
# is fully self-contained so a failure in one doesn't poison the others.
function Invoke-Scenario {
    param(
        [string]$Name,
        [hashtable]$SelectedObjects,
        [hashtable]$IdentityFilter = $null,
        [scriptblock]$ExtraAssertions = $null
    )

    $displayName = "$ConfigPrefix$Name"
    $scenarioStart = Get-Date

    # 1. Build the config payload (same shape the wizard sends)
    $configPayload = @{
        tenantId        = $creds.tenantId
        clientId        = $creds.clientId
        clientSecret    = $creds.clientSecret
        selectedObjects = $SelectedObjects
    }
    if ($IdentityFilter) { $configPayload['identityFilter'] = $IdentityFilter }

    try {
        $config = Invoke-LocalApi -Path '/admin/crawler-configs' -Method POST -Body @{
            crawlerType = 'entra-id'
            displayName = $displayName
            config      = $configPayload
        }
    } catch {
        Report-Result "EntraID/$Name/CreateConfig" $false $_.Exception.Message
        return
    }
    Report-Result "EntraID/$Name/CreateConfig" $true "id=$($config.id)"

    # 2. Queue the job
    try {
        $job = Invoke-LocalApi -Path '/admin/crawler-jobs' -Method POST -Body @{
            jobType  = 'entra-id'
            configId = $config.id
        }
    } catch {
        Report-Result "EntraID/$Name/QueueJob" $false $_.Exception.Message
        return
    }
    Report-Result "EntraID/$Name/QueueJob" $true "jobId=$($job.id)"

    # 3. Wait for the job to finish
    $waitResult = Wait-ForJob -JobId $job.id -ScenarioName $Name
    $duration = [Math]::Round(((Get-Date) - $scenarioStart).TotalSeconds, 1)
    if (-not $waitResult.ok) {
        $detail = "$($waitResult.reason) after ${duration}s"
        if ($waitResult.job -and $waitResult.job.errorMessage) {
            $detail += " | $($waitResult.job.errorMessage)"
        }
        Report-Result "EntraID/$Name/JobCompleted" $false $detail
        # Still drop a per-scenario log file with the final job state for debugging
        if ($waitResult.job) {
            $waitResult.job | ConvertTo-Json -Depth 10 |
                Out-File (Join-Path $LogFolder "entra-$Name.json") -Encoding UTF8
        }
        return
    }
    Report-Result "EntraID/$Name/JobCompleted" $true "${duration}s"

    # 4. Save the final job state for forensic review
    $waitResult.job | ConvertTo-Json -Depth 10 |
        Out-File (Join-Path $LogFolder "entra-$Name.json") -Encoding UTF8

    # 5. Optional extra assertions (e.g. row counts via the read API)
    if ($ExtraAssertions) {
        try {
            & $ExtraAssertions
        } catch {
            Report-Result "EntraID/$Name/Assertions" $false $_.Exception.Message
        }
    }
}

# ─── Pre-flight: validate creds before running any scenario ───────
# We do this once even though it's also implicitly tested below — fast feedback
# if the secrets file is wrong before we burn time on a job.
#
# Under -StrictPermissions (default), every permission in the wizard's
# GRAPH_PERMISSION_MAP must come back as granted. This catches GUID-mapping
# bugs in jobs.js where a permission is granted on the app registration but
# the wizard reports it missing because it's checking the wrong app-role id
# (April 2026 regression for DelegatedPermissionGrant.Read.All).
Write-Host "  Pre-flight: validating credentials..." -ForegroundColor Gray
try {
    $vr = Invoke-LocalApi -Path '/admin/validate-graph-credentials' -Method POST -Body @{
        tenantId     = $creds.tenantId
        clientId     = $creds.clientId
        clientSecret = $creds.clientSecret
    }
    if (-not $vr.valid) {
        Report-Result 'EntraID/Validate-Only' $false ($vr.error ?? 'validation returned valid=false')
        if ($WriteResult) { & $WriteResult 'EntraID-Crawler-Tests' $false 'pre-flight validation failed' }
        return
    }
    $grantedProps = @($vr.permissions.PSObject.Properties | Where-Object { $_.Value })
    $missingProps = @($vr.permissions.PSObject.Properties | Where-Object { -not $_.Value })
    $grantedCount = $grantedProps.Count
    Report-Result 'EntraID/Validate-Only' $true "org=$($vr.organization) · $grantedCount permissions granted"

    # Per-permission assertions — one row per permission in the response so a
    # single missing grant stands out in the results table.
    foreach ($p in $vr.permissions.PSObject.Properties) {
        Report-Result "EntraID/Validate-Only/Permission/$($p.Name)" ([bool]$p.Value) $(if ($p.Value) { 'granted' } else { 'NOT granted' })
    }

    if ($StrictPermissions -and $missingProps.Count -gt 0) {
        $names = ($missingProps | ForEach-Object { $_.Name }) -join ', '
        Report-Result 'EntraID/Validate-Only/AllGranted' $false "missing: $names"
        if ($WriteResult) { & $WriteResult 'EntraID-Crawler-Tests' $false "pre-flight: $($missingProps.Count) permission(s) missing" }
        return
    }
    if ($StrictPermissions) {
        Report-Result 'EntraID/Validate-Only/AllGranted' $true "all $grantedCount permissions granted"
    }
} catch {
    Report-Result 'EntraID/Validate-Only' $false $_.Exception.Message
    if ($WriteResult) { & $WriteResult 'EntraID-Crawler-Tests' $false 'pre-flight validation threw' }
    return
}

# ─── Clean previous test configs ──────────────────────────────────
Write-Host "  Cleaning up previous test configs..." -ForegroundColor Gray
Remove-PreviousNightlyConfigs

# ─── Helper: simple read-API count assertion ──────────────────────
function Assert-ApiCount {
    param([string]$Name, [string]$Path, [int]$MinExpected = 1)
    try {
        $r = Invoke-LocalApi -Path $Path
        # Try a few common shapes: { total }, { data: [...] }, [...]
        $count = $null
        if ($r.PSObject.Properties.Name -contains 'total') { $count = [int]$r.total }
        elseif ($r.PSObject.Properties.Name -contains 'data') { $count = $r.data.Count }
        elseif ($r -is [array]) { $count = $r.Count }
        if ($count -ge $MinExpected) {
            Report-Result $Name $true "count=$count"
        } else {
            Report-Result $Name $false "expected >=$MinExpected, got $count"
        }
    } catch {
        Report-Result $Name $false $_.Exception.Message
    }
}

# ─── Deep matrix assertion ────────────────────────────────────────
#
# The naive "count > 0" check passed yesterday even though the matrix was
# rendering empty in the UI, because the bug was in the column/AP-mapping
# pieces, not the row count. This check exercises the same shape the
# frontend consumes:
#   - GET /api/permissions?userLimit=N → must return data + non-zero
#                                        totalUsers + at least one resource
#                                        per row + at least one principal
#   - GET /api/access-package-groups   → AP→group mapping (used to render
#                                        the AP coloring on cells). Must
#                                        respond 200 with an array.
#   - GET /api/groups-with-nested      → group nesting metadata
#                                        (matrix toolbar uses it)
function Assert-MatrixWorks {
    param([string]$NamePrefix, [int]$MinUsers = 1, [int]$MinRows = 1)
    try {
        $perm = Invoke-LocalApi -Path '/permissions?userLimit=25'
        $rows = if ($perm -and $perm.data) { @($perm.data).Count } else { 0 }
        $totalUsers = if ($perm.PSObject.Properties.Name -contains 'totalUsers') { [int]$perm.totalUsers } else { 0 }

        if ($rows -lt $MinRows) {
            Report-Result "$NamePrefix/MatrixRowCount" $false "expected >=$MinRows rows, got $rows"
            return
        }
        Report-Result "$NamePrefix/MatrixRowCount" $true "rows=$rows"

        if ($totalUsers -lt $MinUsers) {
            Report-Result "$NamePrefix/MatrixTotalUsers" $false "expected >=$MinUsers users, got $totalUsers"
        } else {
            Report-Result "$NamePrefix/MatrixTotalUsers" $true "totalUsers=$totalUsers"
        }

        # Sanity-check the row shape — the frontend reads these specific fields
        $first = $perm.data | Select-Object -First 1
        $hasResource = $first -and ($first.PSObject.Properties.Name -contains 'resourceId') -and $first.resourceId
        $hasMember   = $first -and ($first.PSObject.Properties.Name -contains 'memberId')   -and $first.memberId
        $hasType     = $first -and ($first.PSObject.Properties.Name -contains 'membershipType')
        if ($hasResource -and $hasMember -and $hasType) {
            Report-Result "$NamePrefix/MatrixRowShape" $true 'has resourceId/memberId/membershipType'
        } else {
            Report-Result "$NamePrefix/MatrixRowShape" $false "missing fields (res=$hasResource mem=$hasMember type=$hasType)"
        }

        # AP→group mapping endpoint — drives the AP coloring on cells
        try {
            $apGroups = Invoke-LocalApi -Path '/access-package-groups'
            if ($apGroups -is [array] -or ($apGroups -and $apGroups.GetType().Name -eq 'Object[]')) {
                Report-Result "$NamePrefix/MatrixAPMapping" $true "ap-group-rows=$($apGroups.Count)"
            } else {
                Report-Result "$NamePrefix/MatrixAPMapping" $false "unexpected response type: $($apGroups.GetType().Name)"
            }
        } catch {
            Report-Result "$NamePrefix/MatrixAPMapping" $false $_.Exception.Message
        }

        # Group-nesting metadata — matrix toolbar uses this
        try {
            $nested = Invoke-LocalApi -Path '/groups-with-nested'
            if ($nested -and $nested.PSObject.Properties.Name -contains 'groupIds') {
                Report-Result "$NamePrefix/MatrixGroupsWithNested" $true "groupIds=$(@($nested.groupIds).Count)"
            } else {
                Report-Result "$NamePrefix/MatrixGroupsWithNested" $false 'response missing groupIds'
            }
        } catch {
            Report-Result "$NamePrefix/MatrixGroupsWithNested" $false $_.Exception.Message
        }
    } catch {
        Report-Result "$NamePrefix/MatrixWorks" $false $_.Exception.Message
    }
}

# ─── Deep Business Roles assertion ────────────────────────────────
#
# Yesterday's bug returned the rows but with totalAssignments: 0 because the
# `state` filter used lowercase 'delivered' while the column stores 'Delivered'.
# This check verifies at least one BR has a non-zero assignment count, AND
# that the per-AP detail endpoint is reachable for the first row.
function Assert-BusinessRolesWork {
    param([string]$NamePrefix, [int]$MinAssignments = 1)
    try {
        $resp = Invoke-LocalApi -Path '/access-packages?limit=200'
        $rows = if ($resp -and $resp.data) { @($resp.data) } else { @() }
        if ($rows.Count -eq 0) {
            Report-Result "$NamePrefix/BusinessRolesList" $false 'no rows returned'
            return
        }
        Report-Result "$NamePrefix/BusinessRolesList" $true "rows=$($rows.Count)"

        # At least one row should have totalAssignments >= MinAssignments
        $withAssign = @($rows | Where-Object { $_.totalAssignments -ge $MinAssignments })
        if ($withAssign.Count -gt 0) {
            $maxAssign = ($rows | Measure-Object -Property totalAssignments -Maximum).Maximum
            Report-Result "$NamePrefix/BusinessRolesAssignments" $true "withAssign=$($withAssign.Count) max=$maxAssign"
        } else {
            Report-Result "$NamePrefix/BusinessRolesAssignments" $false "no row has totalAssignments >= $MinAssignments (this was the April 2026 regression)"
        }

        # Per-AP detail endpoint reachable for the first row
        $firstId = $rows[0].id
        try {
            $detail = Invoke-LocalApi -Path "/access-package/$firstId"
            if ($detail) {
                Report-Result "$NamePrefix/BusinessRoleDetail" $true 'detail endpoint reachable'
            }
        } catch {
            Report-Result "$NamePrefix/BusinessRoleDetail" $false $_.Exception.Message
        }
    } catch {
        Report-Result "$NamePrefix/BusinessRolesWork" $false $_.Exception.Message
    }
}

# ─── Sync log assertion ───────────────────────────────────────────
#
# Verifies the GraphSyncLog table contains both the per-batch ingest rows AND
# the full-crawler row that the crawler script writes at end-of-run. The
# full-crawler row was added in April 2026 because per-batch rows undercount
# the real sync duration (they only measure the ingest API time, not the
# Microsoft Graph fetch time).
function Assert-SyncLogShape {
    param(
        [string]$NamePrefix,
        [switch]$ExpectFullCrawlerEntry  # only true after Entra Full-Sync runs
    )
    try {
        $entries = Invoke-LocalApi -Path '/sync-log?limit=50'
        $count = if ($entries -is [array]) { $entries.Count } else { 0 }
        if ($count -lt 1) {
            Report-Result "$NamePrefix/SyncLogEntries" $false 'no entries'
            return
        }
        Report-Result "$NamePrefix/SyncLogEntries" $true "entries=$count"

        if ($ExpectFullCrawlerEntry) {
            # The Entra crawler script writes one EntraID-FullCrawl entry at the
            # end of a successful run summarising the full sync duration. We
            # only assert this after a real Entra Full-Sync — other paths (demo
            # data loader, CSV import) don't and shouldn't.
            $fullRows = @($entries | Where-Object { $_.SyncType -like '*FullCrawl*' -or $_.SyncType -like 'EntraID-*' })
            if ($fullRows.Count -gt 0) {
                Report-Result "$NamePrefix/SyncLogFullCrawlerEntry" $true "found ($($fullRows[0].SyncType))"
            } else {
                Report-Result "$NamePrefix/SyncLogFullCrawlerEntry" $false 'no EntraID-FullCrawl entry — crawler did not write end-of-sync log row'
            }
        }

        # All entries should have a numeric DurationSeconds (the UI formats it h/m/s)
        $bad = @($entries | Where-Object { $null -eq $_.DurationSeconds })
        if ($bad.Count -eq 0) {
            Report-Result "$NamePrefix/SyncLogDurations" $true 'all rows have DurationSeconds'
        } else {
            Report-Result "$NamePrefix/SyncLogDurations" $false "$($bad.Count) rows missing DurationSeconds"
        }
    } catch {
        Report-Result "$NamePrefix/SyncLogShape" $false $_.Exception.Message
    }
}

# ─── Governance + LLM substrate assertions ────────────────────────
#
# The governance routes were the most-broken set after the postgres rewrite
# (T-SQL leftovers). These checks make sure they at least respond with the
# expected shape — they don't validate the values, since some endpoints
# correctly return zeros until classifiers are configured.
function Assert-PostSyncEndpoints {
    param([string]$NamePrefix)

    $endpoints = @(
        @{ Path = '/governance/summary';            Field = 'totalAPs' }
        @{ Path = '/governance/categories';         Field = $null }
        @{ Path = '/governance/review-compliance';  Field = $null }
        @{ Path = '/admin/llm/status';              Field = 'configured' }
        @{ Path = '/admin/llm/config';              Field = 'providers' }
        @{ Path = '/admin/history-retention';       Field = 'retentionDays' }
        @{ Path = '/risk-profiles';                 Field = 'data' }
        @{ Path = '/risk-classifiers';              Field = 'data' }
        @{ Path = '/risk-scoring/runs';             Field = 'data' }
    )
    foreach ($ep in $endpoints) {
        try {
            $r = Invoke-LocalApi -Path $ep.Path
            if ($null -eq $r) {
                Report-Result "$NamePrefix/Endpoint$($ep.Path)" $false 'null response'
                continue
            }
            if ($ep.Field) {
                if ($r.PSObject.Properties.Name -contains $ep.Field) {
                    Report-Result "$NamePrefix/Endpoint$($ep.Path)" $true "has $($ep.Field)"
                } else {
                    Report-Result "$NamePrefix/Endpoint$($ep.Path)" $false "missing field $($ep.Field)"
                }
            } else {
                Report-Result "$NamePrefix/Endpoint$($ep.Path)" $true 'reachable'
            }
        } catch {
            Report-Result "$NamePrefix/Endpoint$($ep.Path)" $false $_.Exception.Message
        }
    }
}

# ─── Run requested scenarios ──────────────────────────────────────
foreach ($scenario in $Scenarios) {
    Write-Host "`n  ── Scenario: $scenario ──" -ForegroundColor Cyan
    switch ($scenario) {
        'Validate-Only' {
            # Already covered by pre-flight above. Recording as an explicit
            # entry too so it shows up under each run for traceability.
            Report-Result 'EntraID/Validate-Only/Scenario' $true 'covered by pre-flight'
        }

        'Identity-Only' {
            Invoke-Scenario -Name 'Identity-Only' `
                -SelectedObjects @{ identity = $true; context = $false; usersGroupsMembers = $false; identityGovernance = $false } `
                -ExtraAssertions {
                    # Identity-Only mode syncs Identities (cross-system account
                    # correlation), NOT Principals/Users. Checking /users here
                    # failed because this scenario doesn't sync users — they only
                    # exist if a prior scenario ran in the same session. Verify the
                    # identities endpoint is queryable instead.
                    try {
                        Invoke-LocalApi -Path '/identities?pageSize=1' | Out-Null
                        Report-Result 'EntraID/Identity-Only/IdentitiesQueryable' $true ''
                    } catch {
                        Report-Result 'EntraID/Identity-Only/IdentitiesQueryable' $false $_.Exception.Message
                    }
                }
        }

        'Users-Groups' {
            Invoke-Scenario -Name 'Users-Groups' `
                -SelectedObjects @{ identity = $false; usersGroupsMembers = $true; identityGovernance = $false } `
                -ExtraAssertions {
                    Assert-ApiCount -Name 'EntraID/Users-Groups/UsersExist'     -Path '/users?pageSize=1'     -MinExpected 1
                    Assert-ApiCount -Name 'EntraID/Users-Groups/ResourcesExist' -Path '/resources?pageSize=1' -MinExpected 1
                }
        }

        'Full-Sync' {
            # Every object type in ENTRA_OBJECT_TYPES is enabled here so the
            # scenario proves that every permission on the demo app
            # registration does something useful. If a new object type is
            # added to jobs.js, add it here too — a partial full-sync
            # defeats the point of this test.
            Invoke-Scenario -Name 'Full-Sync' `
                -SelectedObjects @{
                    identity           = $true
                    context            = $true
                    usersGroupsMembers = $true
                    servicePrincipals  = $true
                    identityGovernance = $true
                    appsAppRoles       = $true
                    directoryRoles     = $true
                    pim                = $true
                    signInLogs         = $true
                    oauth2Grants       = $true
                } `
                -ExtraAssertions {
                    # Basic existence checks
                    Assert-ApiCount -Name 'EntraID/Full-Sync/UsersExist'         -Path '/users?pageSize=1'           -MinExpected 1
                    Assert-ApiCount -Name 'EntraID/Full-Sync/ResourcesExist'     -Path '/resources?pageSize=1'       -MinExpected 1
                    Assert-ApiCount -Name 'EntraID/Full-Sync/SystemsExist'       -Path '/systems'                    -MinExpected 1

                    # Per-object-type presence checks — prove each enabled
                    # object type actually produced rows (or at least that
                    # the read-side endpoint responds cleanly when it may
                    # legitimately be empty on the demo tenant).
                    Assert-ApiCount  -Name 'EntraID/Full-Sync/Context'          -Path '/contexts'                                    -MinExpected 1
                    Assert-ApiCount  -Name 'EntraID/Full-Sync/Identities'       -Path '/identities?pageSize=1'                       -MinExpected 1
                    Assert-ApiCount  -Name 'EntraID/Full-Sync/UsersGroups'      -Path '/resources?resourceType=EntraGroup&limit=1'   -MinExpected 1

                    # ServicePrincipals — the /users endpoint has no
                    # principalType filter, so we fetch a page and check the
                    # mix ourselves. A non-zero count proves the SP sync ran.
                    try {
                        $usersPage = Invoke-LocalApi -Path '/users?limit=2000'
                        $spCount = @($usersPage.data | Where-Object { $_.principalType -eq 'ServicePrincipal' -or $_.principalType -eq 'ManagedIdentity' -or $_.principalType -eq 'AIAgent' }).Count
                        if ($spCount -ge 1) {
                            Report-Result 'EntraID/Full-Sync/ServicePrincipals' $true "spCount=$spCount"
                        } else {
                            Report-Result 'EntraID/Full-Sync/ServicePrincipals' $false 'no principals with principalType in (ServicePrincipal,ManagedIdentity,AIAgent)'
                        }
                    } catch {
                        Report-Result 'EntraID/Full-Sync/ServicePrincipals' $false $_.Exception.Message
                    }

                    # OAuth2 delegated grants — best-effort: prove the
                    # endpoint responds. A clean demo tenant may have zero
                    # per-user consents, so count ≥ 0 is fine (the query
                    # succeeding at all confirms the crawler didn't poison
                    # the Resources table).
                    Assert-ApiCount  -Name 'EntraID/Full-Sync/OAuth2Grants'     -Path '/resources?resourceType=DelegatedPermission&limit=1' -MinExpected 0

                    # PIM eligible memberships surface through /permissions
                    # with membershipType='Eligible'. We just confirm the
                    # endpoint responds; a non-PIM-enabled tenant returns
                    # zero eligible rows, which is correct.
                    try {
                        Invoke-LocalApi -Path '/permissions?userLimit=1' | Out-Null
                        Report-Result 'EntraID/Full-Sync/PimEndpoint' $true 'permissions endpoint queryable'
                    } catch {
                        Report-Result 'EntraID/Full-Sync/PimEndpoint' $false $_.Exception.Message
                    }

                    # NOTE: `directoryRoles` and `appsAppRoles` are listed in
                    # ENTRA_OBJECT_TYPES and we enable them above so the
                    # crawler's wiring is exercised, but Start-EntraIDCrawler
                    # does not currently emit rows for them (April 2026 —
                    # crawler docstring claims it does, but the code path
                    # isn't there yet). Add count assertions here once the
                    # crawler writes those resource types.

                    # Deep regression checks. These exist because the naive
                    # "did anything come back" assertion silently passed during
                    # the April 2026 outage where the routes returned non-empty
                    # responses with broken contents.
                    Assert-MatrixWorks         -NamePrefix 'EntraID/Full-Sync'
                    Assert-BusinessRolesWork   -NamePrefix 'EntraID/Full-Sync'
                    Assert-SyncLogShape        -NamePrefix 'EntraID/Full-Sync' -ExpectFullCrawlerEntry
                    Assert-PostSyncEndpoints   -NamePrefix 'EntraID/Full-Sync'
                }
        }

        'With-Identity-Filter' {
            # Simple, broadly-applicable filter: identities are users that have
            # an employeeId set. Works on most tenants. If iidemo doesn't set
            # employeeId on anyone the count check will catch it cleanly.
            Invoke-Scenario -Name 'With-Identity-Filter' `
                -SelectedObjects @{
                    identity           = $true
                    usersGroupsMembers = $true
                    identityGovernance = $false
                } `
                -IdentityFilter @{ attribute = 'employeeId'; condition = 'isNotNull' } `
                -ExtraAssertions {
                    Assert-ApiCount -Name 'EntraID/With-Identity-Filter/UsersExist' -Path '/users?pageSize=1' -MinExpected 1
                    # Identities count check is best-effort: tenant may have zero
                    # users with employeeId. We just verify the endpoint responds.
                    try {
                        Invoke-LocalApi -Path '/identities?pageSize=1' | Out-Null
                        Report-Result 'EntraID/With-Identity-Filter/IdentitiesQueryable' $true ''
                    } catch {
                        Report-Result 'EntraID/With-Identity-Filter/IdentitiesQueryable' $false $_.Exception.Message
                    }
                }
        }

        default {
            Write-Host "    Unknown scenario: $scenario — skipping" -ForegroundColor Yellow
        }
    }
}

# ─── Final cleanup ────────────────────────────────────────────────
if (-not $KeepConfigs) {
    Write-Host "`n  Removing test configs..." -ForegroundColor Gray
    Remove-PreviousNightlyConfigs
}

# Standalone exit code
if (-not $WriteResult) {
    exit $standaloneFailures
}
