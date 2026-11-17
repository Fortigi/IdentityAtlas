<#
.SYNOPSIS
    Ends one nightly release route: a summary, and one issue when it failed.

.DESCRIPTION
    The decision is Get-RouteOutcome (ReleaseRoute.Functions.ps1) over the
    result of each stage. On failure it opens one issue per route, with the
    reason and the run link (.github/scripts/scheduled_failure_issue.sh keeps
    one open issue per title and adds later failures as comments). Nothing is
    cleaned up: a failed beta keeps its tag, and the next night tries again only
    when the branch has moved (Get-StableRoutePlan / Get-BetaRoutePlan). Exits 1
    unless the route passed, so the nightly run shows red. A dry run opens no
    issue.

.EXAMPLE
    pwsh tools/release/Complete-NightlyRoute.ps1 -Route stable -Results '{"beta":"success",...}' -Beta 6.1.2-beta.1 -Version 6.1.2 -RunUrl https://...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('stable', 'beta')][string] $Route,
    [Parameter(Mandatory)][string] $Results,
    [Parameter(Mandatory)][string] $Beta,
    [string] $Version = '',
    [Parameter(Mandatory)][string] $RunUrl,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'ReleaseRoute.Functions.ps1')

$stages = if ($Route -eq 'stable') { @('beta', 'images', 'test', 'release') } else { @('beta', 'images', 'test') }
$table = @{}
($Results | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $table[$_.Name] = [string]$_.Value }
$outcome = Get-RouteOutcome -Results $table -Promote:($Route -eq 'stable') -DryRun:$DryRun -Beta $Beta -Version $Version

if ($outcome.OpenIssue) {
    $title = if ($Route -eq 'stable') { 'Release nightly: stable patch release' } else { 'Release nightly: beta' }
    & bash (Join-Path $PSScriptRoot '../../.github/scripts/scheduled_failure_issue.sh') $title $RunUrl $outcome.Reason
    if ($LASTEXITCODE -ne 0) { throw 'Could not open or update the failure issue.' }
}

$verdict = if ($outcome.Passed) { 'passed' } else { 'FAILED' }
$lines = @("## The $Route route $verdict", '', $outcome.Reason, '', '| Stage | Result |', '|---|---|') +
    @($stages | ForEach-Object { "| $_ | $($table[$_]) |" })
if ($DryRun) { $lines += @('', 'Dry run: no tag pushed, no release created, no issue opened.') }
if ($env:GITHUB_STEP_SUMMARY) { $lines | Add-Content $env:GITHUB_STEP_SUMMARY }
$lines | Out-Host
if (-not $outcome.Passed) { exit 1 }
