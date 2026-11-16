<#
.SYNOPSIS
    One portable-ZIP scenario of the release test (Windows only).

.DESCRIPTION
    -Scenario Fresh
        Unpacks the candidate's ZIP, starts it on an empty data directory,
        waits until the schema is migrated, loads the demo data and reads one
        page of the matrix.

    -Scenario Upgrade
        The same with the previous stable release's ZIP first, then stops it,
        unpacks the candidate into a new folder and starts it on the SAME data
        directory: the migrations must run, and the totals and the matrix must
        come back as they were.

    -Variant default is IdentityAtlas-portable.zip (PGlite); -Variant postgres
    is IdentityAtlas-portable-postgres.zip, started with -Database Postgres.

.EXAMPLE
    pwsh tools/release/Invoke-PortableReleaseTest.ps1 -Scenario Upgrade -Variant postgres -CandidateZipDir .\candidate -PreviousZipDir .\previous
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Fresh', 'Upgrade')][string] $Scenario,
    [Parameter(Mandatory)][ValidateSet('default', 'postgres')][string] $Variant,
    [Parameter(Mandatory)][string] $CandidateZipDir,
    [string] $PreviousZipDir = '',
    [string] $WorkDir = (Join-Path ([IO.Path]::GetTempPath()) "ia-portable-$PID"),
    [string] $BaseUrl = 'http://127.0.0.1:3001/api'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'ReleaseTest.Portable.ps1')

$zipName = Get-PortableZipName $Variant
$database = Get-PortableDatabase $Variant
$dataDir = Join-Path $WorkDir 'data'
$logs = [System.Collections.Generic.List[string]]::new()

function Start-Release([string] $ZipDir, [string] $Label) {
    $appDir = Expand-PortableZip -Zip (Join-Path $ZipDir $zipName) -Destination (Join-Path $WorkDir $Label)
    $log = Join-Path $WorkDir "$Label.log"
    $logs.Add($log)
    $process = Start-Portable -AppDir $appDir -DataDir $dataDir -Database $database -LogFile $log
    Wait-SchemaReady -BaseUrl $BaseUrl -TimeoutSec 900
    $process
}

function Invoke-Fresh {
    Write-Step "Portable $Variant, fresh start"
    $p = Start-Release $CandidateZipDir 'candidate'
    Invoke-DemoLoad -BaseUrl $BaseUrl
    Assert-MatrixPage -BaseUrl $BaseUrl
    Stop-Portable $p
}

function Invoke-Upgrade {
    if (-not $PreviousZipDir) { throw '-PreviousZipDir is required for the Upgrade scenario.' }
    Write-Step "Portable $Variant, upgrade on a kept data directory"
    $old = Start-Release $PreviousZipDir 'previous'
    Invoke-DemoLoad -BaseUrl $BaseUrl
    $before = Get-ApiTotal -BaseUrl $BaseUrl
    if (-not $before.Users) { throw 'The previous release shows no users after the demo load.' }
    Stop-Portable $old

    $new = Start-Release $CandidateZipDir 'candidate'
    $after = Get-ApiTotal -BaseUrl $BaseUrl
    $problems = @(Compare-RowCount -Before $before -After $after)
    if ($problems.Count -gt 0) { throw "After the upgrade: $($problems -join '; ')" }
    Assert-MatrixPage -BaseUrl $BaseUrl
    Stop-Portable $new
}

New-Item -ItemType Directory -Force $WorkDir | Out-Null
try {
    if ($Scenario -eq 'Fresh') { Invoke-Fresh } else { Invoke-Upgrade }
    Write-Step "Portable $Variant $Scenario passed"
} catch {
    Write-Host "::error::Portable $Variant $Scenario failed: $_"
    foreach ($log in $logs) {
        foreach ($f in $log, "$log.err") { if (Test-Path $f) { Write-Host "--- $f"; Get-Content $f -Tail 80 | Out-Host } }
    }
    exit 1
}
