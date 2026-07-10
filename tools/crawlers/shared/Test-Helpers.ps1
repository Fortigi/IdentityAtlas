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
