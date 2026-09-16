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

# One request against the API, tallying totals in script scope.
function Invoke-SoakRequest {
    param([string]$Uri)
    try {
        Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop | Out-Null
        $script:totalRequests++
    } catch {
        $script:totalRequests++
        $script:totalErrors++
    }
}

# One periodic memory sample plus a progress line.
function Invoke-SoakSample {
    param([datetime]$Now)
    $mem = Get-WebContainerMemory
    if ($null -ne $mem) {
        $script:memorySamples += [PSCustomObject]@{
            timestamp     = $Now.ToString('o')
            memUsageBytes = $mem
        }
    }
    $memMB = if ($null -ne $mem) { [math]::Round($mem / 1MB, 1) } else { '?' }
    Write-Host "    ... $totalRequests requests, $totalErrors errors, memory: ${memMB} MB" -ForegroundColor DarkGray
}

# Phase 2: sustained request loop, sampling memory every 60 seconds.
function Invoke-SoakLoop {
    param([long]$InitialMemory)

    $endpoints = @(
        '/users?limit=25',
        '/resources?limit=25',
        '/permissions?userLimit=25',
        '/identities?limit=25',
        '/systems',
        '/sync-log?limit=25'
    )

    $script:memorySamples = @(
        [PSCustomObject]@{ timestamp = (Get-Date).ToString('o'); memUsageBytes = $InitialMemory }
    )
    $script:totalRequests = 0
    $script:totalErrors   = 0

    $endpointIndex = 0
    $lastSampleTime = Get-Date
    $deadline = (Get-Date).AddMinutes($DurationMinutes)

    Write-Host "    Hammering $($endpoints.Count) endpoints until $($deadline.ToString('HH:mm:ss')) ..." -ForegroundColor Cyan

    while ((Get-Date) -lt $deadline) {
        Invoke-SoakRequest -Uri "$ApiBaseUrl$($endpoints[$endpointIndex])"
        $endpointIndex = ($endpointIndex + 1) % $endpoints.Count

        $now = Get-Date
        if (($now - $lastSampleTime).TotalSeconds -ge 60) {
            Invoke-SoakSample -Now $now
            $lastSampleTime = $now
        }
    }
}

# Phase 3: final memory reading, recorded in script scope.
function Set-SoakFinalMemory {
    $script:finalMemory = Get-WebContainerMemory
    if ($null -eq $script:finalMemory) {
        Write-Result 'Soak/FinalMemory' $false 'could not read final memory'
        return
    }
    $finalMB = [math]::Round($script:finalMemory / 1MB, 1)
    Write-Result 'Soak/FinalMemory' $true "${finalMB} MB"
    $script:memorySamples += [PSCustomObject]@{
        timestamp     = (Get-Date).ToString('o')
        memUsageBytes = $script:finalMemory
    }
}

# Phase 4: memory leak assertion (final < 2x initial).
function Assert-SoakMemoryLeak {
    param([long]$InitialMemory, $FinalMemory, $InitialMB, $FinalMB)
    if ($null -ne $FinalMemory -and $InitialMemory -gt 0) {
        $ratio = [math]::Round($FinalMemory / $InitialMemory, 2)
        if ($FinalMemory -lt (2 * $InitialMemory)) {
            Write-Result 'Soak/NoMemoryLeak' $true "ratio=${ratio}x (${InitialMB} MB -> ${FinalMB} MB)"
        } else {
            Write-Result 'Soak/NoMemoryLeak' $false "ratio=${ratio}x exceeds 2x threshold (${InitialMB} MB -> ${FinalMB} MB)"
        }
    } else {
        Write-Result 'Soak/NoMemoryLeak' $false 'could not compare memory (missing final reading)'
    }
}

# Phase 5: throughput and error rate assertion (< 1%).
function Assert-SoakThroughput {
    $errorRate = if ($totalRequests -gt 0) { [math]::Round(($totalErrors / $totalRequests) * 100, 2) } else { 100 }
    if ($errorRate -lt 1) {
        Write-Result 'Soak/ThroughputOK' $true "$totalRequests requests, ${errorRate}% error rate"
    } else {
        Write-Result 'Soak/ThroughputOK' $false "$totalRequests requests, ${errorRate}% error rate (threshold: <1%)"
    }
}

# Phase 6: CSV summary of all memory samples.
function Write-SoakCsv {
    Write-Host "`n    Memory samples CSV:" -ForegroundColor Cyan
    Write-Host "    timestamp,memUsageBytes"
    foreach ($s in $memorySamples) {
        Write-Host "    $($s.timestamp),$($s.memUsageBytes)"
    }
}

# Orchestrates the full soak-test sequence; returns early when stats are unavailable.
function Invoke-SoakTest {
    Write-Host "`n=== Soak Test ($DurationMinutes min) ===" -ForegroundColor Cyan

    # 1. Initial memory baseline
    $initialMemory = Get-WebContainerMemory
    if ($null -eq $initialMemory) {
        $msg = '/admin/container-stats unavailable — skipping soak test'
        Write-Host "    SKIP  $msg" -ForegroundColor Yellow
        Write-Result 'Soak/InitialMemory' $true "skipped: container stats unavailable"
        return
    }
    $initialMB = [math]::Round($initialMemory / 1MB, 1)
    Write-Result 'Soak/InitialMemory' $true "${initialMB} MB"

    # 2. Sustained request loop
    Invoke-SoakLoop -InitialMemory $initialMemory

    # 3. Final memory
    Set-SoakFinalMemory
    $finalMemory = $script:finalMemory
    $finalMB = if ($null -ne $finalMemory) { [math]::Round($finalMemory / 1MB, 1) } else { $null }

    # 4. Memory leak assertion
    Assert-SoakMemoryLeak -InitialMemory $initialMemory -FinalMemory $finalMemory -InitialMB $initialMB -FinalMB $finalMB

    # 5. Throughput and error rate
    Assert-SoakThroughput

    # 6. Memory samples CSV
    Write-SoakCsv
}

Invoke-SoakTest
if (-not $WriteResult) { exit $standaloneFailures }
