<#
.SYNOPSIS
    Ends the nightly security route: deletes the hotfix branch after a release,
    or opens one issue after a failure. Never both, and neither in a dry run.

.DESCRIPTION
    The decision is Get-SecurityRouteOutcome (SecurityHotfix.Functions.ps1)
    over the result of each stage. On success the branch goes (the tag keeps
    the commit); on failure it stays for a person, and the issue says why,
    with the run link (.github/scripts/scheduled_failure_issue.sh, one open
    issue that collects later failures as comments). Exits 1 unless the route
    passed, so the nightly run shows red.

.EXAMPLE
    pwsh tools/release/Complete-SecurityHotfix.ps1 -Results '{"branch":"success",...}' -Beta 6.1.2-beta.1 -Version 6.1.2 -Branch bugfixes/security-hotfix-20261117 -RunUrl https://...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Results,
    [Parameter(Mandatory)][string] $Beta,
    [Parameter(Mandatory)][string] $Version,
    [Parameter(Mandatory)][string] $Branch,
    [Parameter(Mandatory)][string] $RunUrl,
    [string] $BranchReason = '',
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'SecurityHotfix.Functions.ps1')

$table = @{}
($Results | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $table[$_.Name] = [string]$_.Value }
$outcome = Get-SecurityRouteOutcome -Results $table -DryRun:$DryRun -Beta $Beta -Version $Version -BranchReason $BranchReason

if ($outcome.DeleteBranch) {
    if ($Branch -notlike 'bugfixes/security-hotfix-*') { throw "Refusing to delete '$Branch': only security-hotfix branches are deleted here." }
    Invoke-Git push origin --delete $Branch | Out-Null
    Write-Step "Deleted $Branch; v$Version keeps its commits."
}
if ($outcome.OpenIssue) {
    & bash (Join-Path $PSScriptRoot '../../.github/scripts/scheduled_failure_issue.sh') 'Release nightly: security hotfix' $RunUrl "$($outcome.Reason) The branch $Branch is kept."
    if ($LASTEXITCODE -ne 0) { throw 'Could not open or update the failure issue.' }
}

$verdict = if ($outcome.Passed) { 'passed' } else { 'FAILED' }
$lines = @("## Security route $verdict", '', $outcome.Reason, '', '| Stage | Result |', '|---|---|') +
    @('branch', 'beta', 'images', 'test', 'hotfix' | ForEach-Object { "| $_ | $($table[$_]) |" })
if ($DryRun) { $lines += @('', 'Dry run: no tag pushed, no issue opened, no branch deleted. Delete the branch by hand when done looking at it.') }
if ($env:GITHUB_STEP_SUMMARY) { $lines | Add-Content $env:GITHUB_STEP_SUMMARY }
$lines | Out-Host
if (-not $outcome.Passed) { exit 1 }
