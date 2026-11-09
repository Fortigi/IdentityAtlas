<#
.SYNOPSIS
    Functions for Test-SoakTest.ps1, kept apart so test/unit/SoakTest.Tests.ps1 can
    load them without starting a 15-minute run.

.DESCRIPTION
    Memory is read from the Docker host with `docker stats`, on the machine running
    the test (the CI runner, or the developer's own machine). It is NOT read through
    the API: GET /admin/container-stats and the docker.sock mount it needed were
    removed in #213, because the socket made a compromise of the web process a
    compromise of the host. Do not reintroduce either to feed this test (#721).

    The caller sets $ApiBaseUrl, $DurationMinutes, $Container and $WriteResult in
    script scope before calling Invoke-SoakTest.
#>

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

# The first non-blank output line of a docker command, or $null when it fails.
# All output is collected before any is looked at: piping a native command into
# `Select-Object -First 1` stops it early and leaves $LASTEXITCODE unset, which
# reads as a failure -- that made the first CI run report no web container while
# the container was serving the load test.
function Invoke-DockerLine {
    param([string[]]$Arguments)
    $out = @(& docker @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) { return $null }
    $line = $out | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
    if ($null -eq $line) { return $null }
    return "$line".Trim()
}

# The id of the running container for a compose service, or $null.
function Resolve-SoakContainer {
    param([string]$ComposeFile, [string]$Service = 'web')
    return Invoke-DockerLine -Arguments @('compose', '-f', $ComposeFile, 'ps', '-q', $Service)
}

# One `docker stats` line for the container, as JSON text; $null when docker fails.
function Invoke-DockerStats {
    param([string]$Container)
    return Invoke-DockerLine -Arguments @('stats', '--no-stream', '--format', '{{json .}}', $Container)
}

# Bytes in the usage half of docker's MemUsage ("95.1MiB / 7.75GiB"), or $null.
# Docker prints binary units (KiB, MiB, GiB) on Linux and has printed decimal
# ones (kB, MB, GB) in other versions; both are accepted, each at its own base.
function ConvertFrom-DockerMemUsage {
    param([string]$MemUsage)
    if ($MemUsage -cnotmatch '^\s*([\d.]+)\s*([KMGT]i?B|kB|B)\b') { return $null }
    $factor = switch -CaseSensitive ($Matches[2]) {
        'B'   { 1 }
        'kB'  { 1e3 }
        'KB'  { 1e3 }
        'MB'  { 1e6 }
        'GB'  { 1e9 }
        'TB'  { 1e12 }
        'KiB' { 1KB }
        'MiB' { 1MB }
        'GiB' { 1GB }
        'TiB' { 1TB }
    }
    return [long]([double]$Matches[1] * $factor)
}

# The container's current memory use in bytes, or $null when it cannot be read.
function Get-WebContainerMemory {
    param([string]$Container)
    if ([string]::IsNullOrWhiteSpace($Container)) { return $null }
    $json = Invoke-DockerStats -Container $Container
    if ($null -eq $json) { return $null }
    try {
        $stats = $json | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
    return ConvertFrom-DockerMemUsage $stats.MemUsage
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
    $mem = Get-WebContainerMemory -Container $Container
    if ($null -ne $mem) {
        $script:memorySamples += [PSCustomObject]@{
            timestamp     = $Now.ToString('o')
            memUsageBytes = $mem
        }
    }
    $memMB = if ($null -ne $mem) { [math]::Round($mem / 1MB, 1) } else { '?' }
    Write-Host "    ... $totalRequests requests, $totalErrors errors, memory: ${memMB} MB" -ForegroundColor DarkGray
}

$script:SoakEndpoints = @(
    '/users?limit=25',
    '/resources?limit=25',
    '/permissions?userLimit=25',
    '/identities?limit=25',
    '/systems',
    '/sync-log?limit=25'
)

# One request to each endpoint before the baseline, so the baseline is taken from
# a process that has loaded its routes and filled its caches. A baseline from a
# cold process makes ordinary warm-up look like a leak against the 2x limit.
function Invoke-SoakWarmUp {
    foreach ($e in $script:SoakEndpoints) {
        try { Invoke-WebRequest -Uri "$ApiBaseUrl$e" -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop | Out-Null } catch { }
    }
}

# Phase 2: sustained request loop, sampling memory every 60 seconds.
function Invoke-SoakLoop {
    param([long]$InitialMemory)

    $endpoints = $script:SoakEndpoints

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
    $script:finalMemory = Get-WebContainerMemory -Container $Container
    if ($null -eq $script:finalMemory) {
        Write-Result 'Soak/FinalMemory' $false "could not read final memory of container '$Container'"
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

# Orchestrates the full soak-test sequence. A missing memory baseline FAILS the
# run: before #721 it was recorded as a pass, and the soak skipped unnoticed for
# months while its step went green.
function Invoke-SoakTest {
    Write-Host "`n=== Soak Test ($DurationMinutes min) ===" -ForegroundColor Cyan

    if ([string]::IsNullOrWhiteSpace($Container)) {
        Write-Result 'Soak/InitialMemory' $false 'no running web container found; memory cannot be measured'
        return
    }

    # 1. Initial memory baseline, from a warmed-up process
    Invoke-SoakWarmUp
    $initialMemory = Get-WebContainerMemory -Container $Container
    if ($null -eq $initialMemory) {
        Write-Result 'Soak/InitialMemory' $false "docker stats returned no memory reading for container '$Container'"
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
