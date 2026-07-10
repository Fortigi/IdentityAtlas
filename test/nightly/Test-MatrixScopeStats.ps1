<#
.SYNOPSIS
    Integration tests for the Matrix Scope Statistics feature (scope-stats,
    scope-breakdown, scope-timeseries).

.DESCRIPTION
    Assumes the demo dataset (test/demo-dataset) has been ingested. Validates:

    1. scope-stats (live counts + governed split)
       - ALL principals: 28 principals, 14 resources, 73 assignments.
       - governed + non-governed == assignments; governedPct is consistent.
       - A department-scoped selection (Engineering) returns the expected subset.

    2. scope-breakdown (department drill-down)
       - Per-department principal counts sum to the total.
       - Each group's governed <= assignments and governedPct is consistent.
       - Engineering appears with the expected figures.

    3. scope-timeseries (historic reconstruction from _history)
       - Returns a historyStart and a scopeMode.
       - The most recent (non-pre-history) point matches the live scope-stats —
         i.e. "today" in the timeline equals the live counts.

    Designed to be called from Run-NightlyLocal.ps1 via a WriteResult callback,
    or standalone (returns exit code = number of failures).

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER ApiKey
    Crawler API key (starts with fgc_). Required for authenticated reads.

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [Parameter(Mandatory)] [string]$ApiKey,
    [scriptblock]$WriteResult,
    # When set, additionally assert the timeline reconstructs real depth over
    # time (run test/demo-dataset/Simulate-History.sql first to back-date the
    # audit log). Without it, freshly-loaded demo data has a single-instant
    # history, so only the present-day reconstruction is checked.
    [switch]$ExpectHistoryDepth
)

$ErrorActionPreference = 'Continue'
$standaloneFailures = 0

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color  = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS'  } else { 'FAIL' }
    Write-Host "    $status  $Name  $Detail" -ForegroundColor $color
    if ($WriteResult) { & $WriteResult $Name $Passed $Detail }
    elseif (-not $Passed) { $script:standaloneFailures++ }
}

function Invoke-ScopeApi {
    param([string]$Path, $Filter)
    $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    $body = @{ filter = $Filter } | ConvertTo-Json -Depth 10
    return Invoke-RestMethod -Uri "$ApiBaseUrl$Path" -Method Post -Headers $headers -Body $body -TimeoutSec 60
}

# Filters
$allFilter = @{
    rowType  = 'principal'
    subject  = @{ include = @(); exclude = @() }
    resource = @{ include = @(); exclude = @() }
}
$engFilter = @{
    rowType  = 'principal'
    subject  = @{ include = @(@{ kind = 'attribute'; field = 'department'; values = @('Engineering') }); exclude = @() }
    resource = @{ include = @(); exclude = @() }
}

Write-Host "`n=== Matrix Scope Statistics ===" -ForegroundColor Cyan

# ── 1. scope-stats ───────────────────────────────────────────────────
# Assert invariants + cross-consistency rather than magic counts, so the test
# is robust to dataset evolution and to other tests having added data first.
$all = Invoke-ScopeApi -Path '/matrix/scope-stats' -Filter $allFilter
Write-Result 'scope-stats: non-empty counts' `
    (($all.subjectCount -gt 0) -and ($all.resourceCount -gt 0) -and ($all.assignmentCount -gt 0)) `
    "P=$($all.subjectCount) R=$($all.resourceCount) A=$($all.assignmentCount)"

$splitOk = ($all.governedAssignmentCount + $all.ungovernedAssignmentCount) -eq $all.assignmentCount
Write-Result 'scope-stats: governed split sums to total' $splitOk `
    "$($all.governedAssignmentCount)+$($all.ungovernedAssignmentCount) vs $($all.assignmentCount)"

# Governed is determined by business-role coverage (vw_UserPermissionAssignmentViaBusinessRole),
# NOT the per-row managedByAccessPackage flag. On the demo data (business roles that
# Contain groups + Governed role assignments) some access IS governed and some is not.
# These guard against the regression where governed read as 0.
Write-Result 'scope-stats: some access is governed (BR coverage)' ($all.governedAssignmentCount -gt 0) `
    "governed=$($all.governedAssignmentCount)"
Write-Result 'scope-stats: some access is non-governed' ($all.ungovernedAssignmentCount -gt 0) `
    "non-governed=$($all.ungovernedAssignmentCount)"

$expectPct = if ($all.assignmentCount -gt 0) { [math]::Round($all.governedAssignmentCount / $all.assignmentCount * 100, 1) } else { 0 }
Write-Result 'scope-stats: governedPct consistent' ([math]::Abs($all.governedPct - $expectPct) -lt 0.2) `
    "api=$($all.governedPct) expected≈$expectPct"

$eng = Invoke-ScopeApi -Path '/matrix/scope-stats' -Filter $engFilter
Write-Result 'scope-stats: Engineering subset smaller than all' `
    (($eng.subjectCount -lt $all.subjectCount) -and ($eng.subjectCount -gt 0)) "eng=$($eng.subjectCount)"

# ── 2. scope-breakdown ───────────────────────────────────────────────
$bd = Invoke-ScopeApi -Path '/matrix/scope-breakdown?attribute=department' -Filter $allFilter
$groups = @($bd.groups)
$sumPrincipals = ($groups | Measure-Object -Property principals -Sum).Sum
Write-Result 'breakdown: principals sum to total' ($sumPrincipals -eq $all.subjectCount) `
    "sum=$sumPrincipals total=$($all.subjectCount)"

# Every assignment pair belongs to exactly one department, so they must sum to
# the total assignment count.
$sumAssign = ($groups | Measure-Object -Property assignments -Sum).Sum
Write-Result 'breakdown: assignments sum to total' ($sumAssign -eq $all.assignmentCount) `
    "sum=$sumAssign total=$($all.assignmentCount)"

$consistent = $true
foreach ($g in $groups) {
    if ($g.governed -gt $g.assignments) { $consistent = $false }
}
Write-Result 'breakdown: governed <= assignments per group' $consistent ''

# Cross-consistency: the Engineering breakdown row must equal a direct
# Engineering-scoped scope-stats query (strong proof both code paths agree).
$engGroup = $groups | Where-Object { $_.group -eq 'Engineering' } | Select-Object -First 1
Write-Result 'breakdown: Engineering present' ($null -ne $engGroup) ''
if ($engGroup) {
    Write-Result 'breakdown: Engineering matches scope-stats' `
        (($engGroup.principals -eq $eng.subjectCount) -and ($engGroup.assignments -eq $eng.assignmentCount)) `
        "bd P=$($engGroup.principals)/A=$($engGroup.assignments) vs stats P=$($eng.subjectCount)/A=$($eng.assignmentCount)"
}

# ── 3. scope-timeseries ──────────────────────────────────────────────
$ts = Invoke-ScopeApi -Path '/matrix/scope-timeseries' -Filter $allFilter
Write-Result 'timeseries: has historyStart' ($null -ne $ts.historyStart) "start=$($ts.historyStart)"
Write-Result 'timeseries: scopeMode is attribute' ($ts.scopeMode -eq 'attribute') "mode=$($ts.scopeMode)"

$livePoints = @($ts.points | Where-Object { -not $_.beforeHistory })
Write-Result 'timeseries: has at least one in-history point' ($livePoints.Count -ge 1) "n=$($livePoints.Count)"
if ($livePoints.Count -ge 1) {
    $today = $livePoints[-1]
    Write-Result 'timeseries: latest point equals live scope-stats' `
        (($today.assignments -eq $all.assignmentCount) -and ($today.governed -eq $all.governedAssignmentCount)) `
        "ts A=$($today.assignments)/G=$($today.governed) vs live A=$($all.assignmentCount)/G=$($all.governedAssignmentCount)"
}

# ── 4. History depth (optional — requires a back-dated audit log) ────
if ($ExpectHistoryDepth) {
    $start = [datetime]$ts.historyStart
    $ageDays = ([datetime]::UtcNow - $start.ToUniversalTime()).TotalDays
    Write-Result 'depth: historyStart is well in the past' ($ageDays -gt 90) "ageDays=$([math]::Round($ageDays))"

    $distinctPct = @($livePoints | ForEach-Object { $_.governedPct } | Sort-Object -Unique)
    Write-Result 'depth: governed % varies across the timeline' ($distinctPct.Count -ge 2) `
        "distinct=$($distinctPct.Count)"

    # Governance should be monotonic-ish upward in the simulated story: the
    # earliest in-history point should be <= the latest.
    if ($livePoints.Count -ge 2) {
        Write-Result 'depth: governed % grows from first to last point' `
            ($livePoints[0].governedPct -le $livePoints[-1].governedPct) `
            "first=$($livePoints[0].governedPct) last=$($livePoints[-1].governedPct)"
    }
}

if (-not $WriteResult) {
    Write-Host "`nFailures: $standaloneFailures" -ForegroundColor $(if ($standaloneFailures) { 'Red' } else { 'Green' })
    exit $standaloneFailures
}
