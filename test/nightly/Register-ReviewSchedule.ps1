<#
.SYNOPSIS
    Register the nightly Identity Atlas test + Claude review as a Windows
    Scheduled Task at 04:00 daily.

.DESCRIPTION
    Wraps `Run-NightlyAndReview.ps1` in a Windows Task Scheduler entry. The
    review wrapper handles both running the nightly tests AND triggering the
    automated review pass when something fails. There is no need to also
    schedule `Run-NightlyLocal.ps1` separately — the wrapper invokes it.

    If a previous schedule (`IdentityAtlas-NightlyTests`) exists, you can
    optionally have this script remove it so the two don't both run.

.PARAMETER Time
    Time of day in HH:mm format. Default: 04:00.

.PARAMETER TaskName
    Name of the scheduled task. Default: IdentityAtlas-NightlyReview.

.PARAMETER RemoveOldNightlyTask
    If set, also unregisters the old IdentityAtlas-NightlyTests task (the one
    that ran the bare nightly suite without auto-review).

.PARAMETER Unregister
    Remove this scheduled task instead of creating it.

.EXAMPLE
    .\Register-ReviewSchedule.ps1
    Registers the wrapper at 04:00.

.EXAMPLE
    .\Register-ReviewSchedule.ps1 -RemoveOldNightlyTask
    Registers the wrapper at 04:00 AND removes the old plain nightly task.

.EXAMPLE
    .\Register-ReviewSchedule.ps1 -Unregister
    Removes the wrapper task. The plain nightly task (if any) is left alone.

.NOTES
    The task runs as the current user with `S4U` logon type, which means it
    runs whether the user is signed in or not, but only when the workstation
    is on (it does NOT wake the machine — that's a separate setting on the
    trigger and is intentionally off because Docker on Windows doesn't always
    cope with cold-start under power management).
#>

[CmdletBinding()]
Param(
    [string]$Time = '04:00',
    [string]$TaskName = 'IdentityAtlas-NightlyReview',
    [switch]$RemoveOldNightlyTask,
    [switch]$Unregister
)

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$scriptPath = Join-Path $PSScriptRoot 'Run-NightlyAndReview.ps1'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Scheduled task '$TaskName' removed." -ForegroundColor Green
    return
}

if (-not (Test-Path $scriptPath)) {
    Write-Host "Wrapper script not found: $scriptPath" -ForegroundColor Red
    return
}

# Find pwsh.exe — Task Scheduler can't expand env vars in -Execute
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

# Long execution time limit because the wrapper might re-run the nightly suite
# after a fix. The plain nightly takes ~30 min on this workload; review + fix
# + rerun could plausibly run for 2 hours on a slow night. Cap at 4 to be safe.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

# Replace any existing task with the same name
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Identity Atlas: nightly tests + automated Claude review on failure" | Out-Null

Write-Host "`nScheduled task '$TaskName' registered:" -ForegroundColor Green
Write-Host "  Schedule:  Daily at $Time" -ForegroundColor Gray
Write-Host "  Script:    $scriptPath" -ForegroundColor Gray
Write-Host "  User:      $env:USERNAME" -ForegroundColor Gray
Write-Host "  Timeout:   4 hours" -ForegroundColor Gray
Write-Host "  Logs:      $repoRoot\test\nightly\results\<date>\" -ForegroundColor Gray
Write-Host "  Rolling:   $repoRoot\test\nightly\results\_rolling-summary.log" -ForegroundColor Gray

if ($RemoveOldNightlyTask) {
    $old = 'IdentityAtlas-NightlyTests'
    $existing = Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $old -Confirm:$false
        Write-Host "`nAlso removed old task '$old'." -ForegroundColor Yellow
    } else {
        Write-Host "`n(No '$old' task to remove.)" -ForegroundColor DarkGray
    }
}

Write-Host "`nTo run immediately:    pwsh -File `"$scriptPath`"" -ForegroundColor Cyan
Write-Host "To run in -NoFix mode: pwsh -File `"$scriptPath`" -NoFix" -ForegroundColor Cyan
Write-Host "To remove:             .\Register-ReviewSchedule.ps1 -Unregister" -ForegroundColor Cyan
