<#
.SYNOPSIS
    Nightly test step: 1.5M-row load test + benchmark + materialized view verification.

.DESCRIPTION
    Orchestrates the full-scale load test:
      1. Generate the 1.5M-row synthetic CSV dataset
      2. Create a dedicated CSV crawler config + API key
      3. Run Start-CSVCrawler.ps1 to ingest all data
      4. Check the stored counts (exact, not the dashboard estimate)
      5. Refresh materialized views and assert success
      6. Run the benchmark suite against the loaded data
      7. Assert the stored assignment count equals the distinct keys generated

    Designed to be called from Run-NightlyLocal.ps1 with a WriteResult callback.
    Runs LAST in the integration phases because it takes 15-30 minutes and
    changes the database state significantly (1.5M+ rows).

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER ApiKey
    Crawler API key for the built-in worker (used for crawler config creation)

.PARAMETER RepoRoot
    Repository root (for locating Generate-LoadTestData.ps1 and Run-Benchmark.ps1)

.PARAMETER LogFolder
    Where to write generated data and logs

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$ApiKey,
    [string]$RepoRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$LogFolder = (Join-Path $PSScriptRoot 'results'),
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

# Limits a regression can fail. Each is about twice the slowest of nine green CI
# runs (ubuntu-latest, 1.5M rows, Nov 2026), so runner noise passes and a 3x
# slowdown of a typical run does not. The limits they replace (15 s matrix, 5 s
# dashboard, none on ingest or view refresh) passed a 20x regression. Raise one
# only with the measurements that justify it.
$script:LoadTestLimits = @{
    IngestMinutes      = 8     # measured 3.0 - 4.7 min
    ViewRefreshSeconds = 60    # measured 21 - 31 s
    MatrixSeconds      = 2     # median of 3; single requests measured 0.50 - 1.07 s
    DashboardSeconds   = 0.5   # median of 3; single requests measured 0.09 - 0.16 s
}

# A timing checked against its limit. At the limit fails.
function Write-LimitResult {
    param([string]$Name, [double]$Value, [double]$Limit, [string]$Unit)
    $shown = [math]::Round($Value, 2)
    Write-Result $Name ($Value -lt $Limit) "time=$shown$Unit (limit=$Limit$Unit)"
}

# Median duration in seconds of $Count GETs of one path. One slow request on a
# shared runner should not fail the run; a path that is slow every time should.
function Measure-MedianSeconds {
    param([string]$Path, [int]$Count = 3)
    $times = foreach ($i in 1..$Count) {
        $start = Get-Date
        $null = Invoke-LocalApi -Path $Path
        ((Get-Date) - $start).TotalSeconds
    }
    $sorted = @($times | Sort-Object)
    return $sorted[[math]::Floor($sorted.Count / 2)]
}

function Invoke-LocalApi {
    param([string]$Path, [string]$Method = 'Get', [hashtable]$Body = $null)
    $uri = "$ApiBaseUrl$Path"
    $headers = @{}
    if ($ApiKey) { $headers['Authorization'] = "Bearer $ApiKey" }
    $params = @{
        Uri         = $uri
        Method      = $Method
        ContentType = 'application/json'
        TimeoutSec  = 120
        ErrorAction = 'Stop'
    }
    if ($headers.Count -gt 0) { $params.Headers = $headers }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod @params
}

# ─── 1. Generate load test data ──────────────────────────────────
function Invoke-LoadTestGenerate {
    param([string]$DataFolder, [string]$GenerateScript)
    Write-Host "  Step 1: Generating 1.5M-row dataset..." -ForegroundColor Cyan
    try {
        $genStart = Get-Date
        & $GenerateScript -OutputFolder $DataFolder -ErrorAction Stop
        $genDuration = ((Get-Date) - $genStart).TotalSeconds
        $assignmentsFile = Join-Path $DataFolder 'Assignments.csv'
        $lineCount = if (Test-Path $assignmentsFile) {
            ([System.IO.File]::ReadAllLines($assignmentsFile).Count - 1)  # minus header
        } else { 0 }
        Write-Result 'LoadTest/DataGenerated' ($lineCount -gt 1000000) "rows=$lineCount time=$([math]::Round($genDuration,1))s"
    } catch {
        Write-Result 'LoadTest/DataGenerated' $false $_.Exception.Message
        Write-Host "  Cannot continue load test without data." -ForegroundColor Red
        $script:loadTestAborted = $true
    }
}

# ─── 2. Ingest via CSV crawler ───────────────────────────────────
function Invoke-LoadTestIngest {
    param([string]$DataFolder, [string]$CrawlerScript)
    Write-Host "  Step 2: Running CSV crawler..." -ForegroundColor Cyan
    # Write a temp config file — the CSV crawler now uses the standard -ConfigPath
    # interface (step-2 refactor). JobId 0 skips progress reporting (safe for direct
    # invocation outside the job queue).
    $tempConfig = Join-Path ([System.IO.Path]::GetTempPath()) "load-test-config-$([guid]::NewGuid()).json"
    @{ csvFolder = $DataFolder; systemName = 'Load-Test'; systemType = 'LoadTest' } |
        ConvertTo-Json | Set-Content -Path $tempConfig -Encoding utf8
    try {
        $ingestStart = Get-Date
        & $CrawlerScript `
            -ApiBaseUrl $ApiBaseUrl `
            -ApiKey $ApiKey `
            -JobId 0 `
            -ConfigPath $tempConfig `
            -ErrorAction Stop
        $ingestDuration = ((Get-Date) - $ingestStart).TotalSeconds
        Write-Result 'LoadTest/CrawlerCompleted' $true "time=$([math]::Round($ingestDuration / 60, 1))min"
        Write-LimitResult 'LoadTest/IngestDuration' ($ingestDuration / 60) $script:LoadTestLimits.IngestMinutes 'min'
    } catch {
        Write-Result 'LoadTest/CrawlerCompleted' $false $_.Exception.Message
        Write-Host "  Cannot continue — crawler failed." -ForegroundColor Red
        $script:loadTestAborted = $true
    } finally {
        Remove-Item $tempConfig -ErrorAction SilentlyContinue
    }
}

# ─── 3. Verify stored counts ────────────────────────────────────
# Distinct (resource, user, assignmentType) keys in the generated file: the
# random generator repeats a few, and the ingest upsert collapses those.
function Get-ExpectedAssignmentCount {
    param([string]$DataFolder)
    $keys = [System.Collections.Generic.HashSet[string]]::new()
    $first = $true
    foreach ($line in [System.IO.File]::ReadLines((Join-Path $DataFolder 'Assignments.csv'))) {
        if ($first) { $first = $false; continue }
        $p = $line.Split(';')
        [void]$keys.Add("$($p[0]);$($p[1]);$($p[2])")
    }
    return $keys.Count
}

# Exact counts, not the dashboard's. /admin/dashboard-stats returns
# pg_class.reltuples for the big tables: an ANALYZE estimate, deliberately so
# (see dashboard.js). A lower bound asserted against it passes or fails on when
# ANALYZE last ran, not on what was stored: once the matrix refresh (and its
# closing ANALYZE) moved to the background, it read 1,370,145 where 1,499,943
# were expected. GET /systems counts rows per system with COUNT(*).
function Test-LoadTestStoredCounts {
    param([string]$DataFolder)
    Write-Host "  Step 3: Verifying stored counts..." -ForegroundColor Cyan
    try {
        # Invoke-RestMethod emits a JSON array as ONE object; re-emit its items,
        # or @() holds a single array and every sum below reads 0.
        $systems = @(Invoke-LocalApi -Path '/systems' | ForEach-Object { $_ })
        $sum = { param($field) ($systems | Measure-Object -Property $field -Sum).Sum }
        $assignments = [long](& $sum 'assignmentCount')
        $principals = [long](& $sum 'principalCount')
        $resources = [long](& $sum 'resourceCount')
        $expected = Get-ExpectedAssignmentCount -DataFolder $DataFolder
        Write-Result 'LoadTest/AssignmentCount' ($assignments -eq $expected) "assignments=$assignments (expected exactly $expected)"
        Write-Result 'LoadTest/UserCount' ($principals -ge 75000) "principals=$principals"
        Write-Result 'LoadTest/ResourceCount' ($resources -ge 75000) "resources=$resources"
        Write-Result 'LoadTest/SystemCount' ($systems.Count -ge 20) "systems=$($systems.Count)"
    } catch {
        Write-Result 'LoadTest/AssignmentCount' $false $_.Exception.Message
    }
}

# ─── 4. Refresh materialized views ──────────────────────────────
function Test-LoadTestViewRefresh {
    Write-Host "  Step 4: Refreshing materialized views..." -ForegroundColor Cyan
    try {
        $refreshStart = Get-Date
        $null = Invoke-LocalApi -Path '/ingest/refresh-views?wait=1' -Method 'Post'
        $refreshDuration = ((Get-Date) - $refreshStart).TotalSeconds
        Write-LimitResult 'LoadTest/ViewRefresh' $refreshDuration $script:LoadTestLimits.ViewRefreshSeconds 's'
    } catch {
        Write-Result 'LoadTest/ViewRefresh' $false $_.Exception.Message
    }
}

# ─── 5. Test matrix performance at scale ─────────────────────────
function Test-LoadTestMatrixPerformance {
    Write-Host "  Step 5: Testing matrix query performance..." -ForegroundColor Cyan
    try {
        $matrixDuration = Measure-MedianSeconds -Path '/permissions?userLimit=25'
        Write-LimitResult 'LoadTest/MatrixPerformance' $matrixDuration $script:LoadTestLimits.MatrixSeconds 's'
    } catch {
        Write-Result 'LoadTest/MatrixPerformance' $false $_.Exception.Message
    }
}

# ─── 6. Run benchmark suite ──────────────────────────────────────
function Invoke-LoadTestBenchmark {
    param([string]$BenchmarkScript)
    Write-Host "  Step 6: Running benchmark suite..." -ForegroundColor Cyan
    if (-not (Test-Path $BenchmarkScript)) {
        Write-Result 'LoadTest/BenchmarkCompleted' $true 'skipped (script missing)'
        return
    }
    try {
        $benchLogFolder = Join-Path $LogFolder 'benchmark'
        if (-not (Test-Path $benchLogFolder)) { New-Item -ItemType Directory -Path $benchLogFolder -Force | Out-Null }
        # p95 per endpoint against the CI baseline: a warning, not a failure. Five
        # samples per endpoint on a shared runner are too noisy to block a merge on,
        # but a 50% slowdown should be seen on the PR that caused it.
        & $BenchmarkScript -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey -OutputFolder $benchLogFolder `
            -BaselineFile (Join-Path $RepoRoot 'test/benchmark/ci-baseline.json') `
            -RegressionPct 50 -MinRegressionMs 50 -ErrorAction Stop
        Write-Result 'LoadTest/BenchmarkCompleted' $true ''
    } catch {
        Write-Result 'LoadTest/BenchmarkCompleted' $false $_.Exception.Message
    }
}

# ─── 7. Dashboard-stats query performance ────────────────────────
function Test-LoadTestDashboardPerformance {
    Write-Host "  Step 7: Dashboard-stats performance at scale..." -ForegroundColor Cyan
    try {
        $dashDuration = Measure-MedianSeconds -Path '/admin/dashboard-stats'
        Write-LimitResult 'LoadTest/DashboardPerformance' $dashDuration $script:LoadTestLimits.DashboardSeconds 's'
    } catch {
        Write-Result 'LoadTest/DashboardPerformance' $false $_.Exception.Message
    }
}

function Invoke-LoadAndBenchmark {
    Write-Host "`n=== Load Test + Benchmark (1.5M rows) ===" -ForegroundColor Cyan

    $dataFolder = Join-Path $LogFolder 'load-test-data'
    $generateScript = Join-Path $RepoRoot 'test/load-test/Generate-LoadTestData.ps1'
    $crawlerScript = Join-Path $RepoRoot 'tools/crawlers/csv/Start-CSVCrawler.ps1'
    $benchmarkScript = Join-Path $RepoRoot 'test/benchmark/Run-Benchmark.ps1'

    $script:loadTestAborted = $false

    Invoke-LoadTestGenerate -DataFolder $dataFolder -GenerateScript $generateScript
    if ($script:loadTestAborted) { $script:loadTestExitCode = 1; return }

    Invoke-LoadTestIngest -DataFolder $dataFolder -CrawlerScript $crawlerScript
    if ($script:loadTestAborted) { $script:loadTestExitCode = 1; return }

    Test-LoadTestStoredCounts -DataFolder $dataFolder
    Test-LoadTestViewRefresh
    Test-LoadTestMatrixPerformance
    Invoke-LoadTestBenchmark -BenchmarkScript $benchmarkScript
    Test-LoadTestDashboardPerformance

    Write-Host "`n  Load test complete." -ForegroundColor Green
    $script:loadTestExitCode = $script:standaloneFailures
}

# Dot-sourced (test/unit/LoadTestLimits.Tests.ps1): define the functions only.
if ($MyInvocation.InvocationName -eq '.') { return }

$script:loadTestExitCode = 0
Invoke-LoadAndBenchmark
if (-not $WriteResult) { exit $script:loadTestExitCode }
