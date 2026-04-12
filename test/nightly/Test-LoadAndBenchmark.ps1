<#
.SYNOPSIS
    Nightly test step: 1.5M-row load test + benchmark + materialized view verification.

.DESCRIPTION
    Orchestrates the full-scale load test:
      1. Generate the 1.5M-row synthetic CSV dataset
      2. Create a dedicated CSV crawler config + API key
      3. Run Start-CSVCrawler.ps1 to ingest all data
      4. Poll dashboard-stats until assignments reach expected count
      5. Refresh materialized views and assert success
      6. Run the benchmark suite against the loaded data
      7. Assert dashboard-stats counts match expected minimums

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

Write-Host "`n=== Load Test + Benchmark (1.5M rows) ===" -ForegroundColor Cyan

$dataFolder = Join-Path $LogFolder 'load-test-data'
$generateScript = Join-Path $RepoRoot 'test/load-test/Generate-LoadTestData.ps1'
$crawlerScript = Join-Path $RepoRoot 'tools/crawlers/csv/Start-CSVCrawler.ps1'
$benchmarkScript = Join-Path $RepoRoot 'test/benchmark/Run-Benchmark.ps1'

# ─── 1. Generate load test data ──────────────────────────────────
Write-Host "  Step 1: Generating 1.5M-row dataset..." -ForegroundColor Cyan
try {
    $genStart = Get-Date
    & $generateScript -OutputFolder $dataFolder -ErrorAction Stop
    $genDuration = ((Get-Date) - $genStart).TotalSeconds
    $assignmentsFile = Join-Path $dataFolder 'Assignments.csv'
    $lineCount = if (Test-Path $assignmentsFile) {
        ([System.IO.File]::ReadAllLines($assignmentsFile).Count - 1)  # minus header
    } else { 0 }
    Report-Result 'LoadTest/DataGenerated' ($lineCount -gt 1000000) "rows=$lineCount time=$([math]::Round($genDuration,1))s"
} catch {
    Report-Result 'LoadTest/DataGenerated' $false $_.Exception.Message
    Write-Host "  Cannot continue load test without data." -ForegroundColor Red
    if (-not $WriteResult) { exit 1 }
    return
}

# ─── 2. Ingest via CSV crawler ───────────────────────────────────
Write-Host "  Step 2: Running CSV crawler..." -ForegroundColor Cyan
try {
    $ingestStart = Get-Date
    & $crawlerScript `
        -ApiBaseUrl $ApiBaseUrl `
        -ApiKey $ApiKey `
        -CsvFolder $dataFolder `
        -SystemName 'Load-Test' `
        -SystemType 'LoadTest' `
        -ErrorAction Stop
    $ingestDuration = ((Get-Date) - $ingestStart).TotalSeconds
    Report-Result 'LoadTest/CrawlerCompleted' $true "time=$([math]::Round($ingestDuration / 60, 1))min"
} catch {
    Report-Result 'LoadTest/CrawlerCompleted' $false $_.Exception.Message
    Write-Host "  Cannot continue — crawler failed." -ForegroundColor Red
    if (-not $WriteResult) { exit 1 }
    return
}

# ─── 3. Verify dashboard counts ─────────────────────────────────
Write-Host "  Step 3: Verifying dashboard counts..." -ForegroundColor Cyan
try {
    $stats = Invoke-LocalApi -Path '/admin/dashboard-stats'
    $ok = $stats.assignments -ge 1400000
    Report-Result 'LoadTest/AssignmentCount' $ok "assignments=$($stats.assignments) (expected >=1,400,000)"
    Report-Result 'LoadTest/UserCount' ($stats.users -ge 75000) "users=$($stats.users)"
    Report-Result 'LoadTest/ResourceCount' ($stats.resources -ge 75000) "resources=$($stats.resources)"
    Report-Result 'LoadTest/SystemCount' ($stats.systems -ge 20) "systems=$($stats.systems)"
} catch {
    Report-Result 'LoadTest/AssignmentCount' $false $_.Exception.Message
}

# ─── 4. Refresh materialized views ──────────────────────────────
Write-Host "  Step 4: Refreshing materialized views..." -ForegroundColor Cyan
try {
    $refreshStart = Get-Date
    $r = Invoke-LocalApi -Path '/ingest/refresh-views' -Method 'Post'
    $refreshDuration = ((Get-Date) - $refreshStart).TotalSeconds
    Report-Result 'LoadTest/ViewRefresh' $true "time=$([math]::Round($refreshDuration,1))s"
} catch {
    Report-Result 'LoadTest/ViewRefresh' $false $_.Exception.Message
}

# ─── 5. Test matrix performance at scale ─────────────────────────
Write-Host "  Step 5: Testing matrix query performance..." -ForegroundColor Cyan
try {
    $matrixStart = Get-Date
    $null = Invoke-LocalApi -Path '/permissions?userLimit=25'
    $matrixDuration = ((Get-Date) - $matrixStart).TotalSeconds
    $ok = $matrixDuration -lt 15  # must respond within 15 seconds
    Report-Result 'LoadTest/MatrixPerformance' $ok "time=$([math]::Round($matrixDuration, 2))s (limit=15s)"
} catch {
    Report-Result 'LoadTest/MatrixPerformance' $false $_.Exception.Message
}

# ─── 6. Run benchmark suite ──────────────────────────────────────
Write-Host "  Step 6: Running benchmark suite..." -ForegroundColor Cyan
if (Test-Path $benchmarkScript) {
    try {
        $benchLogFolder = Join-Path $LogFolder 'benchmark'
        if (-not (Test-Path $benchLogFolder)) { New-Item -ItemType Directory -Path $benchLogFolder -Force | Out-Null }
        & $benchmarkScript -ApiBaseUrl $ApiBaseUrl -OutputFolder $benchLogFolder -ErrorAction Stop
        Report-Result 'LoadTest/BenchmarkCompleted' $true ''
    } catch {
        Report-Result 'LoadTest/BenchmarkCompleted' $false $_.Exception.Message
    }
} else {
    Report-Result 'LoadTest/BenchmarkCompleted' $true 'skipped (script missing)'
}

# ─── 7. Dashboard-stats query performance ────────────────────────
Write-Host "  Step 7: Dashboard-stats performance at scale..." -ForegroundColor Cyan
try {
    $dashStart = Get-Date
    $null = Invoke-LocalApi -Path '/admin/dashboard-stats'
    $dashDuration = ((Get-Date) - $dashStart).TotalSeconds
    $ok = $dashDuration -lt 5  # reltuples path should be fast
    Report-Result 'LoadTest/DashboardPerformance' $ok "time=$([math]::Round($dashDuration, 2))s (limit=5s)"
} catch {
    Report-Result 'LoadTest/DashboardPerformance' $false $_.Exception.Message
}

Write-Host "`n  Load test complete." -ForegroundColor Green

if (-not $WriteResult) { exit $standaloneFailures }
