<#
.SYNOPSIS
    Registers the nightly test run as a Windows Task Scheduler task.

.DESCRIPTION
    Creates a scheduled task that runs Run-NightlyLocal.ps1 every night at 02:00.
    Runs under the current user account. Task runs whether user is logged on or not.

.PARAMETER Time
    Time to run (default: 02:00)

.PARAMETER TaskName
    Name of the scheduled task (default: FortigiGraph-NightlyTests)

.PARAMETER Unregister
    Remove the scheduled task instead of creating it

.EXAMPLE
    .\Register-NightlySchedule.ps1
    Registers the nightly test at 02:00

.EXAMPLE
    .\Register-NightlySchedule.ps1 -Time "04:00"
    Registers the nightly test at 04:00

.EXAMPLE
    .\Register-NightlySchedule.ps1 -Unregister
    Removes the scheduled task
#>

[CmdletBinding()]
Param(
    [string]$Time = '02:00',
    [string]$TaskName = 'IdentityAtlas-NightlyTests',
    [switch]$Unregister
)

$repoRoot = Split-Path $PSScriptRoot -Parent
$scriptPath = Join-Path $PSScriptRoot 'Run-NightlyLocal.ps1'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Scheduled task '$TaskName' removed." -ForegroundColor Green
    return
}

# Find pwsh.exe
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) {
    Write-Host "pwsh.exe not found in PATH. Install PowerShell 7." -ForegroundColor Red
    return
}

$action = New-ScheduledTaskAction `
    -Execute $pwsh `
    -Argument "-NoProfile -NonInteractive -File `"$scriptPath`"" `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

# Remove existing task if present
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Identity Atlas nightly test suite — Docker provisioning, ingest, Playwright E2E"

Write-Host "`nScheduled task '$TaskName' registered:" -ForegroundColor Green
Write-Host "  Schedule:  Daily at $Time" -ForegroundColor Gray
Write-Host "  Script:    $scriptPath" -ForegroundColor Gray
Write-Host "  User:      $env:USERNAME" -ForegroundColor Gray
Write-Host "  Timeout:   2 hours" -ForegroundColor Gray
Write-Host "  Report:    $repoRoot\test\nightly\results\latest.md" -ForegroundColor Gray
Write-Host "  History:   $repoRoot\test\nightly\results\<date>\report.md" -ForegroundColor Gray
Write-Host "`nTo run immediately: pwsh -File `"$scriptPath`"" -ForegroundColor Cyan
Write-Host "To remove: .\Register-NightlySchedule.ps1 -Unregister" -ForegroundColor Cyan
