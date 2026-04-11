# Dry-run harness for the new Assert-* helpers in Test-EntraIdCrawler.ps1.
#
# Loads the helpers without invoking the full Entra ID crawler scenario, then
# runs them against whatever data is currently in the database. Used by the
# author to verify the helpers compile and produce sensible output during
# development. NOT part of the normal nightly run — Test-EntraIdCrawler.ps1
# already runs them in the right context.
#
# Usage:
#   pwsh -File test/nightly/dry-run-assertions.ps1

$ApiBaseUrl = 'http://localhost:3001/api'

function Report-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "  $status  $Name  $Detail" -ForegroundColor $color
}

function Invoke-LocalApi {
    param([string]$Path)
    return Invoke-RestMethod -Uri "$ApiBaseUrl$Path" -Method Get -ContentType 'application/json' -TimeoutSec 30
}

# Dot-source only the assertion helpers from Test-EntraIdCrawler.ps1 by reading
# the file and selecting the function blocks we need. We can't dot-source the
# whole file because it has top-level Param() and side-effecting calls.
$src = Get-Content (Join-Path $PSScriptRoot 'Test-EntraIdCrawler.ps1') -Raw
$helpers = @('Assert-ApiCount', 'Assert-MatrixWorks', 'Assert-BusinessRolesWork', 'Assert-SyncLogShape', 'Assert-PostSyncEndpoints')
foreach ($h in $helpers) {
    $pattern = "(?ms)^function $h \{.*?^\}"
    $match = [regex]::Match($src, $pattern)
    if ($match.Success) {
        Invoke-Expression $match.Value
        Write-Host "loaded $h" -ForegroundColor DarkGray
    } else {
        Write-Host "FAILED to extract $h" -ForegroundColor Red
    }
}

Write-Host "`n=== Running assertions against current dataset ===`n" -ForegroundColor Cyan

Assert-MatrixWorks       -NamePrefix 'DryRun'
Assert-BusinessRolesWork -NamePrefix 'DryRun'
Assert-SyncLogShape      -NamePrefix 'DryRun'
Assert-PostSyncEndpoints -NamePrefix 'DryRun'
