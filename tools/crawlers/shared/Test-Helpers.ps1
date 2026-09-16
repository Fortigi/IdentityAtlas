<#
.SYNOPSIS
    Shared helpers for crawler integration test scripts.

.DESCRIPTION
    Dot-source this file from any Test-*.ps1 script that needs the
    Write-Result helper. Expects $WriteResult (scriptblock or $null) and
    $script:standaloneFailures to be defined in the caller's scope.

    Usage:
        . (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared' 'Test-Helpers.ps1')
#>

[CmdletBinding()]
param()

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color  = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "    $status  $Name  $Detail" -ForegroundColor $color
    if ($WriteResult) { & $WriteResult $Name $Passed $Detail }
    elseif (-not $Passed) { $script:standaloneFailures++ }
}

# Poll one crawler job until it reaches a terminal state, or give up.
#
# Reads $ApiBaseUrl / $ApiKey from the calling test script — this file is
# dot-sourced, so those resolve from the caller at call time, the same way
# Write-Result above is used. Returns the finished job object, or $null on
# timeout so the caller can report a timeout distinctly from a failure.
function Wait-JobComplete {
    param([int]$JobId, [int]$TimeoutSec = 120)
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSec)
    while ([datetime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 3
        $j = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/crawler-jobs/$JobId" `
            -Headers @{ Authorization = "Bearer $ApiKey" } -ErrorAction SilentlyContinue
        if ($j.status -in @('completed', 'failed')) { return $j }
    }
    return $null
}
