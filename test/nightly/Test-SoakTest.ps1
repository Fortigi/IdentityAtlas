<#
.SYNOPSIS
    Nightly soak test: hammer the API for a sustained period to detect memory leaks.

.DESCRIPTION
    Sends continuous single-threaded requests to the API for $DurationMinutes
    minutes, cycling through core endpoints. Samples container memory every 60
    seconds via /admin/container-stats and asserts that final memory stays below
    2x the initial value (leak detection heuristic).

    What it covers:
      1. Initial memory baseline from /admin/container-stats (web container)
      2. Sustained request loop across 6 endpoints for $DurationMinutes minutes
      3. Final memory measurement
      4. Memory leak assertion (final < 2x initial)
      5. Throughput and error rate assertion (error rate < 1%)
      6. CSV summary of all memory samples written to stdout

    If /admin/container-stats is unavailable (returns unavailable:true or fails),
    the entire test is skipped — there is nothing to measure without memory data.

    Designed to be called from Run-NightlyLocal.ps1 with a `WriteResult` callback.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER DurationMinutes
    How long to sustain the load. Default: 15

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [int]$DurationMinutes = 15,
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

function Get-WebContainerMemory {
    try {
        $r = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/container-stats" -Method Get -TimeoutSec 10 -ErrorAction Stop
        if ($r.unavailable -eq $true) { return $null }
        $web = $r.containers | Where-Object { $_.name -match 'web' } | Select-Object -First 1
        if ($web -and $web.memUsageBytes) {
            return [long]$web.memUsageBytes
        }
        return $null
    } catch {
        return $null
    }
}

Write-Host "`n=== Soak Test ($DurationMinutes min) ===" -ForegroundColor Cyan

# ─── 1. Initial memory baseline ──────────────────────────────────
$initialMemory = Get-WebContainerMemory
if ($null -eq $initialMemory) {
    $msg = '/admin/container-stats unavailable — skipping soak test'
    Write-Host "    SKIP  $msg" -ForegroundColor Yellow
    Report-Result 'Soak/InitialMemory' $true "skipped: container stats unavailable"
    if (-not $WriteResult) { exit $standaloneFailures }
    return
}

$initialMB = [math]::Round($initialMemory / 1MB, 1)
Report-Result 'Soak/InitialMemory' $true "${initialMB} MB"

# ─── 2. Sustained request loop ───────────────────────────────────
$endpoints = @(
    '/users?limit=25',
    '/resources?limit=25',
    '/permissions?userLimit=25',
    '/identities?limit=25',
    '/systems',
    '/sync-log?limit=25'
)

$memorySamples = @(
    [PSCustomObject]@{ timestamp = (Get-Date).ToString('o'); memUsageBytes = $initialMemory }
)

$totalRequests = 0
$totalErrors   = 0
$endpointIndex = 0
$lastSampleTime = Get-Date
$deadline = (Get-Date).AddMinutes($DurationMinutes)

Write-Host "    Hammering $($endpoints.Count) endpoints until $($deadline.ToString('HH:mm:ss')) ..." -ForegroundColor Cyan

while ((Get-Date) -lt $deadline) {
    $uri = "$ApiBaseUrl$($endpoints[$endpointIndex])"
    try {
        Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop | Out-Null
        $totalRequests++
    } catch {
        $totalRequests++
        $totalErrors++
    }

    $endpointIndex = ($endpointIndex + 1) % $endpoints.Count

    # Sample memory every 60 seconds
    $now = Get-Date
    if (($now - $lastSampleTime).TotalSeconds -ge 60) {
        $mem = Get-WebContainerMemory
        if ($null -ne $mem) {
            $memorySamples += [PSCustomObject]@{
                timestamp     = $now.ToString('o')
                memUsageBytes = $mem
            }
        }
        $lastSampleTime = $now
        $memMB = if ($null -ne $mem) { [math]::Round($mem / 1MB, 1) } else { '?' }
        Write-Host "    ... $totalRequests requests, $totalErrors errors, memory: ${memMB} MB" -ForegroundColor DarkGray
    }
}

# ─── 3. Final memory ─────────────────────────────────────────────
$finalMemory = Get-WebContainerMemory
if ($null -eq $finalMemory) {
    Report-Result 'Soak/FinalMemory' $false 'could not read final memory'
} else {
    $finalMB = [math]::Round($finalMemory / 1MB, 1)
    Report-Result 'Soak/FinalMemory' $true "${finalMB} MB"
    $memorySamples += [PSCustomObject]@{
        timestamp     = (Get-Date).ToString('o')
        memUsageBytes = $finalMemory
    }
}

# ─── 4. Memory leak assertion ────────────────────────────────────
if ($null -ne $finalMemory -and $initialMemory -gt 0) {
    $ratio = [math]::Round($finalMemory / $initialMemory, 2)
    if ($finalMemory -lt (2 * $initialMemory)) {
        Report-Result 'Soak/NoMemoryLeak' $true "ratio=${ratio}x (${initialMB} MB -> ${finalMB} MB)"
    } else {
        Report-Result 'Soak/NoMemoryLeak' $false "ratio=${ratio}x exceeds 2x threshold (${initialMB} MB -> ${finalMB} MB)"
    }
} else {
    Report-Result 'Soak/NoMemoryLeak' $false 'could not compare memory (missing final reading)'
}

# ─── 5. Throughput and error rate ─────────────────────────────────
$errorRate = if ($totalRequests -gt 0) { [math]::Round(($totalErrors / $totalRequests) * 100, 2) } else { 100 }
if ($errorRate -lt 1) {
    Report-Result 'Soak/ThroughputOK' $true "$totalRequests requests, ${errorRate}% error rate"
} else {
    Report-Result 'Soak/ThroughputOK' $false "$totalRequests requests, ${errorRate}% error rate (threshold: <1%)"
}

# ─── 6. Memory samples CSV ───────────────────────────────────────
Write-Host "`n    Memory samples CSV:" -ForegroundColor Cyan
Write-Host "    timestamp,memUsageBytes"
foreach ($s in $memorySamples) {
    Write-Host "    $($s.timestamp),$($s.memUsageBytes)"
}

if (-not $WriteResult) { exit $standaloneFailures }
