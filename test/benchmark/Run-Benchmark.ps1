<#
.SYNOPSIS
    UI API benchmark — hits the key read endpoints a few times each, pulls
    server-side perf metrics, and writes a markdown report.

.DESCRIPTION
    Workflow:
      1. Ensure the 'Benchmark' tag exists and is applied to 15 users.
      2. Give those users a handful of Governed (business role) assignments so
         the filtered matrix is non-empty.
      3. Clear /api/perf metrics.
      4. Call each target endpoint N times (default 5) with cold and warm runs.
      5. Read /api/perf/export and compose BENCHMARK.md.
      6. Compare with a stored baseline (if present) and flag regressions.

    Designed to run standalone for local benchmarking and to plug into the
    nightly test suite via Run-NightlyLocal.ps1.

.PARAMETER ApiBaseUrl
    Base URL of the Identity Atlas API. Default: http://localhost:3001/api

.PARAMETER OutputFolder
    Where to write BENCHMARK.md and benchmark.json. Default: test/benchmark/results

.PARAMETER BaselineFile
    Path to a prior benchmark.json to diff against. Default:
    test/benchmark/baseline.json

.PARAMETER Runs
    How many times to hit each endpoint. Default: 5.

.PARAMETER RegressionPct
    Percentage increase in p95 that counts as a regression. Default: 25.

.PARAMETER FailOnRegression
    Exit with a non-zero code when any endpoint regresses more than
    RegressionPct. Off by default for local use; on for nightly.
#>
[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$OutputFolder = (Join-Path $PSScriptRoot 'results'),
    [string]$BaselineFile = (Join-Path $PSScriptRoot 'baseline.json'),
    [int]$Runs = 5,
    [int]$RegressionPct = 25,
    [switch]$FailOnRegression
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not (Test-Path $OutputFolder)) { New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null }
$timestamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$jsonOut   = Join-Path $OutputFolder "benchmark-$timestamp.json"
$mdOut     = Join-Path $OutputFolder 'BENCHMARK.md'

function Invoke-Api {
    param([string]$Method = 'GET', [string]$Path, $Body)
    $uri = "$ApiBaseUrl$Path"
    $h = @{ 'Content-Type' = 'application/json' }
    if ($Body) {
        Invoke-RestMethod -Method $Method -Uri $uri -Headers $h -Body ($Body | ConvertTo-Json -Depth 10 -Compress) -TimeoutSec 120
    } else {
        Invoke-RestMethod -Method $Method -Uri $uri -Headers $h -TimeoutSec 120
    }
}

Write-Host "`n=== Identity Atlas Benchmark ===" -ForegroundColor Cyan
Write-Host "API:       $ApiBaseUrl" -ForegroundColor Gray
Write-Host "Runs:      $Runs (per endpoint)" -ForegroundColor Gray
Write-Host "Output:    $OutputFolder" -ForegroundColor Gray
Write-Host "Baseline:  $BaselineFile" -ForegroundColor Gray

# ─── 1. Environment inventory ────────────────────────────────────
Write-Host "`n[1/6] Environment inventory..." -ForegroundColor Cyan
$stats = Invoke-Api -Path '/admin/dashboard-stats'
Write-Host "  Users:                  $($stats.users)" -ForegroundColor Gray
Write-Host "  Resources:              $($stats.resources)" -ForegroundColor Gray
Write-Host "  Business roles:         $($stats.businessRoles)" -ForegroundColor Gray
Write-Host "  Assignments:            $($stats.assignments)" -ForegroundColor Gray
Write-Host "  Governed assignments:   $($stats.governedAssignments)" -ForegroundColor Gray
Write-Host "  Systems:                $($stats.systems)" -ForegroundColor Gray

if (($stats.users -as [int]) -lt 15) {
    throw "Not enough data for benchmark: only $($stats.users) users loaded."
}

# ─── 2. Ensure Benchmark tag + 15 tagged users ──────────────────
Write-Host "`n[2/6] Ensuring 'Benchmark' tag and 15 tagged users..." -ForegroundColor Cyan
$allTags = @(Invoke-Api -Path '/tags?entityType=user')
$bench = $allTags | Where-Object { $_.name -eq 'Benchmark' } | Select-Object -First 1
if (-not $bench) {
    $bench = Invoke-Api -Method POST -Path '/tags' -Body @{ name = 'Benchmark'; color = '#65a30d'; entityType = 'user' }
    Write-Host "  Created tag id=$($bench.id)" -ForegroundColor Green
} else {
    Write-Host "  Found existing tag id=$($bench.id)" -ForegroundColor Gray
}

# Find a BusinessRole first, then pick 15 users from the SAME system so the
# deterministic-ingest resolver (which scopes externalIds per systemId) can
# successfully link them.
$brResp = Invoke-Api -Path '/resources?resourceType=BusinessRole&limit=5&offset=0'
$businessRoles = @($brResp.data)
if ($businessRoles.Count -eq 0) {
    throw "No BusinessRole resources found — matrix cannot be benchmarked in filtered mode."
}
$targetSystemId = $businessRoles[0].systemId
Write-Host "  Anchoring to systemId=$targetSystemId (from first business role)" -ForegroundColor Gray

# Pick 15 users from that system
$userFilter = [System.Uri]::EscapeDataString('{"systemId":"' + $targetSystemId + '"}')
$usersResp = Invoke-Api -Path "/users?limit=15&offset=0&filters=$userFilter"
$users15 = @($usersResp.data)
if ($users15.Count -lt 15) {
    # Fallback: grab any 15 — they won't link to the business roles, but at
    # least the tag filter will match.
    Write-Host "  Only $($users15.Count) users in target system — falling back to cross-system selection" -ForegroundColor Yellow
    $usersResp = Invoke-Api -Path '/users?limit=15&offset=0'
    $users15 = @($usersResp.data)
}
if ($users15.Count -lt 15) { throw "Expected 15 users from /users, got $($users15.Count)" }

$userIds = @($users15 | ForEach-Object { $_.id })
Invoke-Api -Method POST -Path "/tags/$($bench.id)/assign" -Body @{ entityIds = $userIds } | Out-Null
Write-Host "  Assigned tag to $($userIds.Count) user(s)" -ForegroundColor Green

# ─── 3. Give tagged users governed assignments ──────────────────
Write-Host "`n[3/6] Giving tagged users governed business-role assignments..." -ForegroundColor Cyan
# Build (resourceExternalId, userExternalId) pairs. All assignments share the
# targetSystemId from step 2 so the deterministic resolver can link them.
$records = @()
foreach ($br in $businessRoles) {
    foreach ($u in $users15) {
        $records += @{
            resourceExternalId  = $br.externalId
            principalExternalId = $u.externalId
            assignmentType      = 'Governed'
        }
    }
}
# /ingest/resource-assignments wants a numeric systemId; targetSystemId from
# the /resources response is already a number (PG int).
$body = @{
    systemId     = $targetSystemId
    syncMode     = 'delta'
    scope        = @{ assignmentType = 'Governed' }
    records      = $records
    idGeneration = 'deterministic'
    idPrefix     = 'bench-assignments'
}
try {
    $r = Invoke-Api -Method POST -Path '/ingest/resource-assignments' -Body $body
    Write-Host "  Seeded $($r.inserted) governed assignment(s) across $($businessRoles.Count) business role(s)" -ForegroundColor Green
    try { Invoke-Api -Method POST -Path '/ingest/classify-business-role-assignments' -Body @{} | Out-Null } catch { }
} catch {
    Write-Host "  Assignment ingest failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
}

# ─── 4. Clear perf metrics ──────────────────────────────────────
Write-Host "`n[4/6] Clearing perf metrics..." -ForegroundColor Cyan
Invoke-Api -Method POST -Path '/perf/clear' -Body @{} | Out-Null

# ─── 5. Exercise endpoints ──────────────────────────────────────
Write-Host "`n[5/6] Exercising endpoints ($Runs runs each)..." -ForegroundColor Cyan

$filterJson = ('{"__userTag":"Benchmark"}' | ConvertTo-Json -Compress).Trim('"').Replace('\"','"')
# We want the raw string, not JSON-encoded:
$filterJson = '{"__userTag":"Benchmark"}'
$encoded = [System.Uri]::EscapeDataString($filterJson)

$targets = @(
    @{ name = 'dashboard-stats';      path = '/admin/dashboard-stats' }
    @{ name = 'matrix-unfiltered';    path = '/permissions?userLimit=25' }
    @{ name = 'matrix-benchmark-tag'; path = "/permissions?userLimit=500&filters=$encoded" }
    @{ name = 'users-page1';          path = '/users?limit=25&offset=0' }
    @{ name = 'users-search';         path = '/users?limit=25&offset=0&search=user' }
    @{ name = 'resources-page1';      path = '/resources?limit=25&offset=0' }
    @{ name = 'resources-business';   path = '/resources?limit=25&offset=0&resourceType=BusinessRole' }
    @{ name = 'identities-page1';     path = '/identities?limit=25&offset=0' }
    @{ name = 'systems';              path = '/systems' }
    @{ name = 'access-packages';      path = '/access-package-resources' }
    @{ name = 'sync-log';             path = '/sync-log?limit=25' }
)

$clientTimings = @{}
foreach ($t in $targets) {
    $samples = [System.Collections.Generic.List[double]]::new()
    for ($i = 0; $i -lt $Runs; $i++) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try { Invoke-Api -Path $t.path | Out-Null } catch { Write-Host "    $($t.name) run $($i+1): $($_.Exception.Message)" -ForegroundColor Yellow }
        $sw.Stop()
        $samples.Add($sw.Elapsed.TotalMilliseconds) | Out-Null
    }
    $sorted = @($samples | Sort-Object)
    $n = $sorted.Count
    $avg = ($sorted | Measure-Object -Average).Average
    $p50 = $sorted[[Math]::Floor($n * 0.5)]
    $p95 = $sorted[[Math]::Min($n - 1, [Math]::Floor($n * 0.95))]
    $clientTimings[$t.name] = @{
        path  = $t.path
        avgMs = [Math]::Round($avg, 1)
        p50Ms = [Math]::Round($p50, 1)
        p95Ms = [Math]::Round($p95, 1)
        runs  = $n
    }
    Write-Host ("  {0,-26} avg {1,6:N1} ms  p50 {2,6:N1} ms  p95 {3,6:N1} ms" -f $t.name, $avg, $p50, $p95) -ForegroundColor Gray
}

# ─── 6. Collect server perf data + write report ─────────────────
Write-Host "`n[6/6] Collecting server perf metrics..." -ForegroundColor Cyan
$serverPerf = Invoke-Api -Path '/perf/export'

$report = [ordered]@{
    timestamp    = (Get-Date).ToString('o')
    apiBaseUrl   = $ApiBaseUrl
    inventory    = $stats
    runsPerEndpoint = $Runs
    clientTimings = $clientTimings
    serverSummary = $serverPerf.summary
}
$report | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonOut -Encoding UTF8
Write-Host "  JSON:     $jsonOut" -ForegroundColor Gray

# ─── Baseline comparison ────────────────────────────────────────
$regressions = @()
$baseline = $null
if (Test-Path $BaselineFile) {
    try {
        $baseline = Get-Content $BaselineFile -Raw | ConvertFrom-Json
        Write-Host "  Baseline: $BaselineFile (taken $($baseline.timestamp))" -ForegroundColor Gray
    } catch { Write-Host "  Baseline unreadable: $($_.Exception.Message)" -ForegroundColor Yellow }
}
if ($baseline) {
    foreach ($k in $clientTimings.Keys) {
        $cur = $clientTimings[$k]
        $base = $baseline.clientTimings.$k
        if ($null -eq $base) { continue }
        $delta = if ($base.p95Ms -gt 0) { [Math]::Round((($cur.p95Ms - $base.p95Ms) / $base.p95Ms) * 100, 1) } else { 0 }
        if ($delta -gt $RegressionPct) {
            $regressions += "$k  p95 $($base.p95Ms)ms -> $($cur.p95Ms)ms (+$delta%)"
        }
    }
}

# ─── Markdown ───────────────────────────────────────────────────
$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine("# Identity Atlas — API Benchmark")
[void]$md.AppendLine("")
[void]$md.AppendLine("_Run at_ ``$($report.timestamp)``")
[void]$md.AppendLine("")
[void]$md.AppendLine("## Dataset inventory")
[void]$md.AppendLine("")
[void]$md.AppendLine("| Entity | Rows |")
[void]$md.AppendLine("|---|---:|")
[void]$md.AppendLine("| Systems | $($stats.systems) |")
[void]$md.AppendLine("| Contexts / OrgUnits | $($stats.contexts) |")
[void]$md.AppendLine("| Resources (all) | $($stats.resources) |")
[void]$md.AppendLine("| Business roles | $($stats.businessRoles) |")
[void]$md.AppendLine("| Principals (users) | $($stats.users) |")
[void]$md.AppendLine("| ResourceAssignments | $($stats.assignments) |")
[void]$md.AppendLine("| Governed assignments | $($stats.governedAssignments) |")
[void]$md.AppendLine("| ResourceRelationships | $($stats.relationships) |")
[void]$md.AppendLine("| Identities | $($stats.identities) |")
[void]$md.AppendLine("| Certifications | $($stats.certifications) |")
[void]$md.AppendLine("")
[void]$md.AppendLine("## Client-side timings")
[void]$md.AppendLine("")
[void]$md.AppendLine("Wall-clock over $($Runs) runs per endpoint, as seen from the benchmark client.")
[void]$md.AppendLine("")
[void]$md.AppendLine("| Endpoint | avg | p50 | p95 |")
[void]$md.AppendLine("|---|---:|---:|---:|")
foreach ($k in ($clientTimings.Keys | Sort-Object)) {
    $t = $clientTimings[$k]
    [void]$md.AppendLine("| ``$k`` | $($t.avgMs) ms | $($t.p50Ms) ms | $($t.p95Ms) ms |")
}
[void]$md.AppendLine("")
[void]$md.AppendLine("## Server-side timings (from /api/perf)")
[void]$md.AppendLine("")
[void]$md.AppendLine("Per-route aggregates from the API's own middleware. ``count`` is the number of requests recorded during this benchmark run.")
[void]$md.AppendLine("")
[void]$md.AppendLine("| Route | count | avg | p50 | p95 | p99 | max |")
[void]$md.AppendLine("|---|---:|---:|---:|---:|---:|---:|")
foreach ($e in ($serverPerf.summary.endpoints | Sort-Object -Property p95 -Descending)) {
    [void]$md.AppendLine("| ``$($e.method) $($e.route)`` | $($e.count) | $($e.avg) ms | $($e.p50) ms | $($e.p95) ms | $($e.p99) ms | $($e.max) ms |")
}
[void]$md.AppendLine("")

# Top SQL queries by cumulative time
[void]$md.AppendLine("## Server-side SQL query breakdown (slowest endpoints)")
[void]$md.AppendLine("")
$topEndpoints = @($serverPerf.summary.endpoints | Sort-Object -Property p95 -Descending | Select-Object -First 5)
foreach ($e in $topEndpoints) {
    if (-not $e.sqlBreakdown -or $e.sqlBreakdown.Count -eq 0) { continue }
    [void]$md.AppendLine("### ``$($e.method) $($e.route)``")
    [void]$md.AppendLine("")
    [void]$md.AppendLine("| SQL label | count | avg | p50 | p95 | max |")
    [void]$md.AppendLine("|---|---:|---:|---:|---:|---:|")
    foreach ($q in ($e.sqlBreakdown | Sort-Object -Property p95 -Descending)) {
        [void]$md.AppendLine("| ``$($q.label)`` | $($q.count) | $($q.avg) ms | $($q.p50) ms | $($q.p95) ms | $($q.max) ms |")
    }
    [void]$md.AppendLine("")
}

if ($regressions.Count -gt 0) {
    [void]$md.AppendLine("## :rotating_light: Regressions")
    [void]$md.AppendLine("")
    [void]$md.AppendLine("The following endpoints got slower than the baseline by more than $RegressionPct% (p95):")
    [void]$md.AppendLine("")
    foreach ($r in $regressions) { [void]$md.AppendLine("- $r") }
    [void]$md.AppendLine("")
} elseif ($baseline) {
    [void]$md.AppendLine("## Regressions")
    [void]$md.AppendLine("")
    [void]$md.AppendLine("None — all endpoints within $RegressionPct% of baseline ($($baseline.timestamp)).")
    [void]$md.AppendLine("")
}

$md.ToString() | Set-Content -Path $mdOut -Encoding UTF8
Write-Host "  Markdown: $mdOut" -ForegroundColor Gray

if ($regressions.Count -gt 0) {
    Write-Host "`nREGRESSIONS DETECTED:" -ForegroundColor Red
    foreach ($r in $regressions) { Write-Host "  $r" -ForegroundColor Red }
    if ($FailOnRegression) { exit 2 }
}

Write-Host "`nDone." -ForegroundColor Green
