#Requires -Version 7
<#
.SYNOPSIS
    Starts Identity Atlas using the bundled Node.js runtime (and PostgreSQL, when bundled).
.DESCRIPTION
    With a postgres\ folder next to this script (or -PostgresRoot), starts a real
    PostgreSQL as the current user on 127.0.0.1, creating its cluster on first run,
    then starts node.exe bootstrap.mjs against it. Without one, node.exe runs the
    built-in PGlite database exactly as before. Waits until the API has migrated
    its schema, opens the browser, and on Ctrl+C stops node.exe and then
    PostgreSQL cleanly (pg_ctl stop -m fast).
.PARAMETER Database
    Auto (default): PostgreSQL when bundled, unless this data directory already
    holds PGlite data. Postgres or PGlite force one.
.PARAMETER PostgresRoot
    Folder containing bin\pg_ctl.exe. Defaults to postgres\ next to this script.
.PARAMETER PostgresPort
    Loopback port for PostgreSQL. Default 5433, clear of an installed server's 5432.
.PARAMETER Port
    Loopback port for the app. Default 3001.
.PARAMETER StartupTimeoutSec
    How long to wait before warning that startup is slow. The launcher keeps
    waiting after the warning; it never kills a process that is still starting.
.PARAMETER NoBrowser
    Do not open the browser once the app is ready.
#>
[CmdletBinding()]
param(
    [ValidateSet('Auto', 'Postgres', 'PGlite')][string]$Database = 'Auto',
    [string]$PostgresRoot,
    [ValidateRange(1024, 65535)][int]$PostgresPort = 5433,
    [ValidateRange(1024, 65535)][int]$Port = 3001,
    [ValidateRange(10, 86400)][int]$StartupTimeoutSec = 300,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Launcher.Functions.ps1')

$nodeExe = Join-Path $PSScriptRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
    Write-Error "node.exe not found in $PSScriptRoot. The portable package may be incomplete."
    exit 1
}
$url = "http://localhost:$Port"

Write-Host 'Starting Identity Atlas...' -ForegroundColor Cyan

# One resolver for the data directory, shared with bootstrap.mjs, which is then
# told the answer explicitly so the two can never disagree.
$dataDir = "$(& $nodeExe (Join-Path $PSScriptRoot 'launcherConfig.mjs') --print-data-dir)".Trim()
if ($LASTEXITCODE -ne 0 -or -not $dataDir) { Write-Error 'Could not resolve the data directory.'; exit 1 }

$lock = Enter-LauncherLock -DataDir $dataDir -WaitMs 3000
if (-not $lock) {
    # Another launcher owns this data directory. Never touch its processes.
    exit (Show-OtherLauncher -Port $Port -DataDir $dataDir -OpenBrowser:(-not $NoBrowser))
}

$pgHome = Join-Path $dataDir 'postgres'
$pgRoot = $null
$node = $null
$exitCode = 0
try {
    $null = Stop-OrphanedNode -DataDir $dataDir
    if (Get-AppHealth -Port $Port) { throw "Something else is already serving $url. Stop it, or pass -Port." }

    $choice = Resolve-DatabaseChoice -Requested $Database -DataDir $dataDir `
        -PgRoot (Resolve-PostgresRoot -Override $PostgresRoot -ScriptDir $PSScriptRoot)
    Write-Host "Database: $($choice.Mode) ($($choice.Reason))" -ForegroundColor Gray
    Write-Host "Data directory: $dataDir" -ForegroundColor Gray

    # Set only in Postgres mode, i.e. for binaries that passed the preflight: the
    # server this launcher owns, which the finally block and the watchdog stop.
    $pgRoot = $choice.PgRoot
    # Cleans up after this launcher if it ends without reaching its finally block
    # (window closed, process killed).
    $null = Start-LauncherWatchdog -ScriptDir $PSScriptRoot -DataDir $dataDir -PgRoot $pgRoot
    Initialize-ChosenDatabase -Choice $choice -PgHome $pgHome -Port $PostgresPort -WarnAfterSec $StartupTimeoutSec
    $node = Start-AppProcess -ScriptDir $PSScriptRoot -DataDir $dataDir -Port $Port

    Wait-AppReady -Node $node -Port $Port -CrashLog (Join-Path $dataDir 'startup-error.log') -WarnAfterSec $StartupTimeoutSec
    Write-Host "Identity Atlas is running at $url" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host 'Press Ctrl+C to stop.' -ForegroundColor Gray

    $reason = Wait-AppExit -Node $node -DatabaseAlive { -not $pgRoot -or (Get-PostmasterProcess -PgHome $pgHome) }
    Write-Host $reason -ForegroundColor Yellow
    $exitCode = 1
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    # Node first, so it is not left talking to a database that is going away.
    Stop-NodeProcess -Node $node
    Clear-LauncherState -DataDir $dataDir
    if ($pgRoot) { Stop-PostgresServer -PgRoot $pgRoot -PgHome $pgHome }
    $lock.Dispose()
}
exit $exitCode
