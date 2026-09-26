#Requires -Version 7
<#
.SYNOPSIS
    Cleans up after Start-IdentityAtlas.ps1 once it has ended, however it ended.
.DESCRIPTION
    Started hidden by the launcher, in a console of its own. Ctrl+C in the launcher
    runs its finally block, which stops node.exe and PostgreSQL itself; closing the
    launcher's window or killing its process does not. This waits for the launcher
    process to end and then stops what it left behind: the recorded node.exe, and
    PostgreSQL with a fast (clean) shutdown. After a normal stop there is nothing
    left and it simply exits.
#>
param(
    [Parameter(Mandatory)][int]$LauncherPid,
    [Parameter(Mandatory)][string]$DataDir,
    [string]$PgRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Launcher.Functions.ps1')

Wait-Process -Id $LauncherPid -ErrorAction SilentlyContinue
$null = Invoke-LauncherCleanup -DataDir $DataDir -PgRoot $PgRoot
