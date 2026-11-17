<#
.SYNOPSIS
    Tonight's security route: is a hotfix needed, and with what. Read-only.

.DESCRIPTION
    Lists merged Dependabot PRs with the security-fix label, keeps the ones
    the newest stable release does not contain yet (SecurityHotfix.Functions.ps1),
    and writes to $GITHUB_OUTPUT:

      needed    true when there is at least one fix and no kept hotfix branch
      blocked   a kept bugfixes/security-hotfix-* branch, if any (needs a person)
      stable    the newest stable tag the hotfix branches from
      version   the hotfix version (next patch)
      beta      the beta version that is tested first (<version>-beta.N)
      branch    bugfixes/security-hotfix-<yyyyMMdd>
      commits   the merge commits to cherry-pick, space-separated, in merge order
      prs       their PR numbers, space-separated

.EXAMPLE
    pwsh tools/release/Get-SecurityHotfixPlan.ps1 -Repository Fortigi/IdentityAtlas
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Repository,
    [string] $Main = 'origin/main',
    [datetime] $Now = (Get-Date)
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'SecurityHotfix.Functions.ps1')

$tags = @(git tag --list 'v*')
$stable = @(Get-StableTag $tags)[0]
if (-not $stable) { throw 'No stable release tag: there is nothing to hotfix.' }
$since = Get-ReleaseBaseDate -StableTag $stable -Main $Main

$json = gh pr list --repo $Repository --base main --state merged --label (Get-SecurityLabel) --limit 200 `
    --json 'number,title,author,labels,baseRefName,mergedAt,mergeCommit'
if ($LASTEXITCODE -ne 0) { throw 'Could not list the merged security-fix pull requests.' }
$fixes = @(Select-SecurityFix -PullRequests @($json | ConvertFrom-Json) -Since $since -IsInRelease {
        param($sha) Test-CommitInRelease -Commit $sha -StableTag $stable -Main $Main
    })

$kept = @(Get-KeptHotfixBranch @(git ls-remote --heads origin 'bugfixes/security-hotfix-*' | ForEach-Object { ($_ -split '\s+')[1] }))
$version = Get-HotfixVersion $stable
$out = [ordered]@{
    needed  = (($fixes.Count -gt 0) -and ($kept.Count -eq 0)).ToString().ToLower()
    blocked = $kept -join ' '
    stable  = $stable
    version = $version
    beta    = Get-NextBetaVersion -Version $version -Tags $tags
    branch  = Get-SecurityHotfixBranchName -Date $Now
    commits = @($fixes | ForEach-Object Commit) -join ' '
    prs     = @($fixes | ForEach-Object Number) -join ' '
}
$lines = $out.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
if ($env:GITHUB_OUTPUT) { $lines | Add-Content $env:GITHUB_OUTPUT }

$summary = @('## Security route', '')
$summary += if ($fixes.Count -eq 0) { "No security fix on main since $stable that is not in a release yet." }
            else { @("Fixes on main that $stable does not contain:", '') + @($fixes | ForEach-Object { "- #$($_.Number) $($_.Title)" }) }
if ($kept.Count) { $summary += @('', "**Not starting:** $($kept -join ', ') is still there from an earlier attempt. Look at it, then delete it to let the route try again.") }
if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content $env:GITHUB_STEP_SUMMARY }
$lines
