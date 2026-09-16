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
        Invoke-RestMethod -Method $Method -Uri $uri -Headers $h -Body ($Body | ConvertTo-Json -Depth 10 -Compress) -TimeoutSec 600
    } else {
        Invoke-RestMethod -Method $Method -Uri $uri -Headers $h -TimeoutSec 600
    }
}

# Raw HTTP timing that bypasses Invoke-RestMethod's JSON parser.
# Invoke-RestMethod parses the response body into PSCustomObjects, which for
# large responses (the matrix endpoint can return 80+ MB of JSON) takes
# hundreds of seconds — far longer than the server itself. We want to measure
# *server* performance, so we use Invoke-WebRequest with -UseBasicParsing
# and ignore the parsed content. Returns elapsed milliseconds and response size.
function Measure-RawGet {
    param([string]$Path)
    $uri = "$ApiBaseUrl$Path"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-WebRequest -Uri $uri -Method GET -UseBasicParsing -TimeoutSec 600
        $sw.Stop()
        return @{
            ok     = $true
            ms     = $sw.Elapsed.TotalMilliseconds
            bytes  = $r.RawContentLength
            status = $r.StatusCode
        }
    } catch {
        $sw.Stop()
        return @{ ok = $false; ms = $sw.Elapsed.TotalMilliseconds; error = $_.Exception.Message }
    }
}

# Human-readable byte size (shared by the console table and the markdown report).
function Format-ByteSize {
    param([long]$Bytes)
    if ($Bytes -gt 1048576) { return "{0:N1} MB" -f ($Bytes / 1MB) }
    elseif ($Bytes -gt 1024) { return "{0:N1} KB" -f ($Bytes / 1KB) }
    else { return "$Bytes B" }
}

function Show-BenchmarkHeader {
    Write-Host "`n=== Identity Atlas Benchmark ===" -ForegroundColor Cyan
    Write-Host "API:       $ApiBaseUrl" -ForegroundColor Gray
    Write-Host "Runs:      $Runs (per endpoint)" -ForegroundColor Gray
    Write-Host "Output:    $OutputFolder" -ForegroundColor Gray
    Write-Host "Baseline:  $BaselineFile" -ForegroundColor Gray
}

# ─── 1. Environment inventory ────────────────────────────────────
function Get-BenchmarkInventory {
    Write-Host "`n[1/6] Environment inventory..." -ForegroundColor Cyan
    $script:stats = Invoke-Api -Path '/admin/dashboard-stats'
    Write-Host "  Users:                  $($script:stats.principals)" -ForegroundColor Gray
    Write-Host "  Resources:              $($script:stats.resources)" -ForegroundColor Gray
    Write-Host "  Business roles:         $($script:stats.businessRoles)" -ForegroundColor Gray
    Write-Host "  Assignments:            $($script:stats.assignments)" -ForegroundColor Gray
    Write-Host "  Governed assignments:   $($script:stats.governedAssignments)" -ForegroundColor Gray
    Write-Host "  Systems:                $($script:stats.systems)" -ForegroundColor Gray

    if (($script:stats.principals -as [int]) -lt 15) {
        throw "Not enough data for benchmark: only $($script:stats.principals) users loaded."
    }
}

# ─── 2. Ensure Benchmark tag + 15 tagged users ──────────────────
function Resolve-BenchmarkTag {
    Write-Host "`n[2/6] Ensuring 'Benchmark' tag and 15 tagged users..." -ForegroundColor Cyan
    $allTags = @(Invoke-Api -Path '/tags?entityType=user')
    $script:bench = $allTags | Where-Object { $_.name -eq 'Benchmark' } | Select-Object -First 1
    if (-not $script:bench) {
        $script:bench = Invoke-Api -Method POST -Path '/tags' -Body @{ name = 'Benchmark'; color = '#65a30d'; entityType = 'user' }
        Write-Host "  Created tag id=$($script:bench.id)" -ForegroundColor Green
    } else {
        Write-Host "  Found existing tag id=$($script:bench.id)" -ForegroundColor Gray
    }
}

function Select-BenchmarkUsers {
    # Find a BusinessRole first, then pick 15 users from the SAME system so the
    # deterministic-ingest resolver (which scopes externalIds per systemId) can
    # successfully link them.
    $brResp = Invoke-Api -Path '/resources?resourceType=BusinessRole&limit=5&offset=0'
    $script:businessRoles = @($brResp.data)
    if ($script:businessRoles.Count -eq 0) {
        throw "No BusinessRole resources found — matrix cannot be benchmarked in filtered mode."
    }
    $script:targetSystemId = $script:businessRoles[0].systemId
    Write-Host "  Anchoring to systemId=$($script:targetSystemId) (from first business role)" -ForegroundColor Gray

    # Pick 15 users from that system
    $userFilter = [System.Uri]::EscapeDataString('{"systemId":"' + $script:targetSystemId + '"}')
    $usersResp = Invoke-Api -Path "/users?limit=15&offset=0&filters=$userFilter"
    $script:users15 = @($usersResp.data)
    if ($script:users15.Count -lt 15) {
        # Fallback: grab any 15 — they won't link to the business roles, but at
        # least the tag filter will match.
        Write-Host "  Only $($script:users15.Count) users in target system — falling back to cross-system selection" -ForegroundColor Yellow
        $usersResp = Invoke-Api -Path '/users?limit=15&offset=0'
        $script:users15 = @($usersResp.data)
    }
    if ($script:users15.Count -lt 15) { throw "Expected 15 users from /users, got $($script:users15.Count)" }

    $userIds = @($script:users15 | ForEach-Object { $_.id })
    Invoke-Api -Method POST -Path "/tags/$($script:bench.id)/assign" -Body @{ entityIds = $userIds } | Out-Null
    Write-Host "  Assigned tag to $($userIds.Count) user(s)" -ForegroundColor Green
}

# ─── 3. Give tagged users governed assignments ──────────────────
# Build (resourceExternalId, userExternalId) pairs. All assignments share the
# targetSystemId from step 2 so the deterministic resolver can link them.
function Get-AssignmentRecords {
    $records = @()
    foreach ($br in $script:businessRoles) {
        foreach ($u in $script:users15) {
            $records += @{
                resourceExternalId  = $br.externalId
                principalExternalId = $u.externalId
                assignmentType      = 'Direct'   # membership on a business role; classify (below) flags it governed=true
            }
        }
    }
    return ,$records
}

function Add-GovernedAssignments {
    Write-Host "`n[3/6] Giving tagged users governed business-role assignments..." -ForegroundColor Cyan
    $records = Get-AssignmentRecords
    # /ingest/resource-assignments wants a numeric systemId; targetSystemId from
    # the /resources response is already a number (PG int).
    $body = @{
        systemId     = $script:targetSystemId
        syncMode     = 'delta'
        scope        = @{ assignmentType = 'Direct' }
        records      = $records
        idGeneration = 'deterministic'
        idPrefix     = 'bench-assignments'
    }
    try {
        $r = Invoke-Api -Method POST -Path '/ingest/resource-assignments' -Body $body
        Write-Host "  Seeded $($r.inserted) governed assignment(s) across $($script:businessRoles.Count) business role(s)" -ForegroundColor Green
        try { Invoke-Api -Method POST -Path '/ingest/classify-business-role-assignments' -Body @{} | Out-Null } catch { }
    } catch {
        Write-Host "  Assignment ingest failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ─── 4. Clear perf metrics ──────────────────────────────────────
function Clear-BenchmarkPerf {
    Write-Host "`n[4/6] Clearing perf metrics..." -ForegroundColor Cyan
    Invoke-Api -Method POST -Path '/perf/clear' -Body @{} | Out-Null
}

# ─── 5. Exercise endpoints ──────────────────────────────────────
# Measure one endpoint over $Runs samples and return its timing summary.
function Measure-Endpoint {
    param([hashtable]$Target, [int]$Runs)
    $samples = [System.Collections.Generic.List[double]]::new()
    $lastBytes = 0
    for ($i = 0; $i -lt $Runs; $i++) {
        $r = Measure-RawGet -Path $Target.path
        if (-not $r.ok) { Write-Host "    $($Target.name) run $($i+1): $($r.error)" -ForegroundColor Yellow }
        $samples.Add($r.ms) | Out-Null
        if ($r.bytes) { $lastBytes = $r.bytes }
    }
    $sorted = @($samples | Sort-Object)
    $n = $sorted.Count
    $avg = ($sorted | Measure-Object -Average).Average
    $p50 = $sorted[[Math]::Floor($n * 0.5)]
    $p95 = $sorted[[Math]::Min($n - 1, [Math]::Floor($n * 0.95))]
    $timing = @{
        path      = $Target.path
        avgMs     = [Math]::Round($avg, 1)
        p50Ms     = [Math]::Round($p50, 1)
        p95Ms     = [Math]::Round($p95, 1)
        runs      = $n
        respBytes = [int64]$lastBytes
    }
    $sizeStr = Format-ByteSize $lastBytes
    Write-Host ("  {0,-26} avg {1,8:N1} ms  p50 {2,8:N1} ms  p95 {3,8:N1} ms  [{4}]" -f $Target.name, $avg, $p50, $p95, $sizeStr) -ForegroundColor Gray
    return $timing
}

function Invoke-BenchmarkEndpoints {
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

    $script:clientTimings = @{}
    foreach ($t in $targets) {
        $script:clientTimings[$t.name] = Measure-Endpoint -Target $t -Runs $Runs
    }
}

# ─── 6. Collect server perf data + write report ─────────────────
function Write-BenchmarkJson {
    Write-Host "`n[6/6] Collecting server perf metrics..." -ForegroundColor Cyan
    $script:serverPerf = Invoke-Api -Path '/perf/export'

    $script:report = [ordered]@{
        timestamp    = (Get-Date).ToString('o')
        apiBaseUrl   = $ApiBaseUrl
        inventory    = $script:stats
        runsPerEndpoint = $Runs
        clientTimings = $script:clientTimings
        serverSummary = $script:serverPerf.summary
    }
    $script:report | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonOut -Encoding UTF8
    Write-Host "  JSON:     $jsonOut" -ForegroundColor Gray
}

# ─── Baseline comparison ────────────────────────────────────────
function Read-BenchmarkBaseline {
    $script:regressions = @()
    $script:baseline = $null
    if (Test-Path $BaselineFile) {
        try {
            $script:baseline = Get-Content $BaselineFile -Raw | ConvertFrom-Json
            Write-Host "  Baseline: $BaselineFile (taken $($script:baseline.timestamp))" -ForegroundColor Gray
        } catch { Write-Host "  Baseline unreadable: $($_.Exception.Message)" -ForegroundColor Yellow }
    }
}

# Return the regression line for one endpoint, or nothing if within tolerance.
function Get-BaselineRegression {
    param([string]$Name, $Cur, $Base, [int]$Pct)
    $delta = if ($Base.p95Ms -gt 0) { [Math]::Round((($Cur.p95Ms - $Base.p95Ms) / $Base.p95Ms) * 100, 1) } else { 0 }
    if ($delta -gt $Pct) {
        return "$Name  p95 $($Base.p95Ms)ms -> $($Cur.p95Ms)ms (+$delta%)"
    }
}

function Get-BenchmarkRegressions {
    if (-not $script:baseline) { return }
    foreach ($k in $script:clientTimings.Keys) {
        $base = $script:baseline.clientTimings.$k
        if ($null -eq $base) { continue }
        $reg = Get-BaselineRegression -Name $k -Cur $script:clientTimings[$k] -Base $base -Pct $RegressionPct
        if ($reg) { $script:regressions += $reg }
    }
}

# ─── Markdown ───────────────────────────────────────────────────
function Add-MarkdownInventory {
    [void]$script:md.AppendLine("# Identity Atlas — API Benchmark")
    [void]$script:md.AppendLine("")
    [void]$script:md.AppendLine("_Run at_ ``$($script:report.timestamp)``")
    [void]$script:md.AppendLine("")
    [void]$script:md.AppendLine("## Dataset inventory")
    [void]$script:md.AppendLine("")
    [void]$script:md.AppendLine("| Entity | Rows |")
    [void]$script:md.AppendLine("|---|---:|")
    [void]$script:md.AppendLine("| Systems | $($script:stats.systems) |")
    [void]$script:md.AppendLine("| Contexts / OrgUnits | $($script:stats.contexts) |")
    [void]$script:md.AppendLine("| Resources (all) | $($script:stats.resources) |")
    [void]$script:md.AppendLine("| Business roles | $($script:stats.businessRoles) |")
    [void]$script:md.AppendLine("| Principals (users) | $($script:stats.principals) |")
    [void]$script:md.AppendLine("| ResourceAssignments | $($script:stats.assignments) |")
    [void]$script:md.AppendLine("| Governed assignments | $($script:stats.governedAssignments) |")
    [void]$script:md.AppendLine("| ResourceRelationships | $($script:stats.relationships) |")
    [void]$script:md.AppendLine("| Identities | $($script:stats.identities) |")
    [void]$script:md.AppendLine("| Certifications | $($script:stats.certifications) |")
    [void]$script:md.AppendLine("")
}

function Add-MarkdownClientTimings {
    [void]$script:md.AppendLine("## Client-side timings")
    [void]$script:md.AppendLine("")
    [void]$script:md.AppendLine("Wall-clock over $($Runs) runs per endpoint, measured via Invoke-WebRequest without JSON parsing (server-side HTTP time only).")
    [void]$script:md.AppendLine("")
    [void]$script:md.AppendLine("| Endpoint | avg | p50 | p95 | Response size |")
    [void]$script:md.AppendLine("|---|---:|---:|---:|---:|")
    foreach ($k in ($script:clientTimings.Keys | Sort-Object)) {
        $t = $script:clientTimings[$k]
        $b = [int64]$t.respBytes
        $sz = Format-ByteSize $b
        [void]$script:md.AppendLine("| ``$k`` | $($t.avgMs) ms | $($t.p50Ms) ms | $($t.p95Ms) ms | $sz |")
    }
    [void]$script:md.AppendLine("")
}

function Add-MarkdownServerTimings {
    [void]$script:md.AppendLine("## Server-side timings (from /api/perf)")
    [void]$script:md.AppendLine("")
    [void]$script:md.AppendLine("Per-route aggregates from the API's own middleware. ``count`` is the number of requests recorded during this benchmark run.")
    [void]$script:md.AppendLine("")
    [void]$script:md.AppendLine("| Route | count | avg | p50 | p95 | p99 | max |")
    [void]$script:md.AppendLine("|---|---:|---:|---:|---:|---:|---:|")
    foreach ($e in ($script:serverPerf.summary.endpoints | Sort-Object -Property p95 -Descending)) {
        [void]$script:md.AppendLine("| ``$($e.method) $($e.route)`` | $($e.count) | $($e.avg) ms | $($e.p50) ms | $($e.p95) ms | $($e.p99) ms | $($e.max) ms |")
    }
    [void]$script:md.AppendLine("")
}

function Add-MarkdownSqlBreakdown {
    # Top SQL queries by cumulative time
    [void]$script:md.AppendLine("## Server-side SQL query breakdown (slowest endpoints)")
    [void]$script:md.AppendLine("")
    $topEndpoints = @($script:serverPerf.summary.endpoints | Sort-Object -Property p95 -Descending | Select-Object -First 5)
    foreach ($e in $topEndpoints) {
        if (-not $e.sqlBreakdown -or $e.sqlBreakdown.Count -eq 0) { continue }
        [void]$script:md.AppendLine("### ``$($e.method) $($e.route)``")
        [void]$script:md.AppendLine("")
        [void]$script:md.AppendLine("| SQL label | count | avg | p50 | p95 | max |")
        [void]$script:md.AppendLine("|---|---:|---:|---:|---:|---:|")
        foreach ($q in ($e.sqlBreakdown | Sort-Object -Property p95 -Descending)) {
            [void]$script:md.AppendLine("| ``$($q.label)`` | $($q.count) | $($q.avg) ms | $($q.p50) ms | $($q.p95) ms | $($q.max) ms |")
        }
        [void]$script:md.AppendLine("")
    }
}

function Add-MarkdownRegressions {
    if ($script:regressions.Count -gt 0) {
        [void]$script:md.AppendLine("## :rotating_light: Regressions")
        [void]$script:md.AppendLine("")
        [void]$script:md.AppendLine("The following endpoints got slower than the baseline by more than $RegressionPct% (p95):")
        [void]$script:md.AppendLine("")
        foreach ($r in $script:regressions) { [void]$script:md.AppendLine("- $r") }
        [void]$script:md.AppendLine("")
    } elseif ($script:baseline) {
        [void]$script:md.AppendLine("## Regressions")
        [void]$script:md.AppendLine("")
        [void]$script:md.AppendLine("None — all endpoints within $RegressionPct% of baseline ($($script:baseline.timestamp)).")
        [void]$script:md.AppendLine("")
    }
}

function Write-BenchmarkMarkdown {
    $script:md = New-Object System.Text.StringBuilder
    Add-MarkdownInventory
    Add-MarkdownClientTimings
    Add-MarkdownServerTimings
    Add-MarkdownSqlBreakdown
    Add-MarkdownRegressions
    $script:md.ToString() | Set-Content -Path $mdOut -Encoding UTF8
    Write-Host "  Markdown: $mdOut" -ForegroundColor Gray
}

# ─── Final summary + exit code ──────────────────────────────────
function Complete-Benchmark {
    if ($script:regressions.Count -gt 0) {
        Write-Host "`nREGRESSIONS DETECTED:" -ForegroundColor Red
        foreach ($r in $script:regressions) { Write-Host "  $r" -ForegroundColor Red }
        if ($FailOnRegression) { $script:exitCode = 2; return }
    }
    Write-Host "`nDone." -ForegroundColor Green
}

function Invoke-Benchmark {
    Show-BenchmarkHeader
    Get-BenchmarkInventory
    Resolve-BenchmarkTag
    Select-BenchmarkUsers
    Add-GovernedAssignments
    Clear-BenchmarkPerf
    Invoke-BenchmarkEndpoints
    Write-BenchmarkJson
    Read-BenchmarkBaseline
    Get-BenchmarkRegressions
    Write-BenchmarkMarkdown
    Complete-Benchmark
}

$script:exitCode = 0
Invoke-Benchmark
if ($script:exitCode -ne 0) { exit $script:exitCode }
