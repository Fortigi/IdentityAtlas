<#
.SYNOPSIS
    Soak test: hammer the API for a sustained period to detect memory leaks.

.DESCRIPTION
    Sends continuous single-threaded requests to the API for $DurationMinutes
    minutes, cycling through core endpoints. Samples the web container's memory
    every 60 seconds with `docker stats` on the machine running this script, and
    asserts that final memory stays below 2x the initial value (leak detection
    heuristic).

    What it covers:
      1. Initial memory baseline of the web container, after one warm-up pass
      2. Sustained request loop across 6 endpoints for $DurationMinutes minutes
      3. Final memory measurement
      4. Memory leak assertion (final < 2x initial)
      5. Throughput and error rate assertion (error rate < 1%)
      6. CSV summary of all memory samples written to stdout

    Memory comes from the Docker host, never from the API: the API's old
    /admin/container-stats endpoint and its docker.sock mount were removed for
    security in #213 and must not come back for this test (#721). When memory
    cannot be read, the soak FAILS -- it does not skip.

    Designed to be called from Run-NightlyLocal.ps1 with a `WriteResult` callback,
    and directly from pr-integration.yml.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER DurationMinutes
    How long to sustain the load. Default: 15

.PARAMETER ComposeFile
    The compose file the stack was started from; the web container is looked up
    in it. Default: docker-compose.ci.yml at the repository root.

.PARAMETER Container
    The web container's name or id. Overrides the lookup through -ComposeFile.

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [int]$DurationMinutes = 15,
    [string]$ComposeFile = (Join-Path $PSScriptRoot '..' '..' 'docker-compose.ci.yml'),
    [string]$Container,
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$standaloneFailures = 0

. (Join-Path $PSScriptRoot 'SoakTest.Functions.ps1')

if (-not $Container) {
    $Container = Resolve-SoakContainer -ComposeFile $ComposeFile -Service 'web'
}

Invoke-SoakTest
if (-not $WriteResult) { exit $standaloneFailures }
