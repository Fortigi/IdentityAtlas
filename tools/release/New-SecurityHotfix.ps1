<#
.SYNOPSIS
    Builds the security hotfix branch and pushes it (the nightly route, step 1).

.DESCRIPTION
    From the newest stable tag, `git cherry-pick -x` each fix's merge commit in
    merge order (Get-SecurityHotfixPlan.ps1 decided which), then runs this
    checkout's Assert-ReleaseFromMain.ps1 -Mode Hotfix — the check Cut Beta and
    Cut Hotfix will run — before anything leaves the runner. Pushes the branch
    (a dry run pushes it too; only tags, issues and branch deletion are left
    out of a dry run). On failure writes `reason=` to $GITHUB_OUTPUT and exits 1;
    the branch is not pushed then, so there is nothing to clean up.

.EXAMPLE
    pwsh tools/release/New-SecurityHotfix.ps1 -StableTag v6.1.1 -Branch bugfixes/security-hotfix-20261117 -Commits 'abc... def...' -PullRequests '1601 1604'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $StableTag,
    [Parameter(Mandatory)][string] $Branch,
    [Parameter(Mandatory)][string] $Commits,
    [Parameter(Mandatory)][string] $PullRequests,
    [switch] $NoPush
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'SecurityHotfix.Functions.ps1')

function Write-Reason([string] $Reason) {
    Write-Host "::error::$Reason"
    if ($env:GITHUB_OUTPUT) { "reason=$($Reason -replace '[\r\n]+', ' ')" | Add-Content $env:GITHUB_OUTPUT }
}

try {
    $shas = @($Commits -split '\s+' | Where-Object { $_ })
    $numbers = @($PullRequests -split '\s+' | Where-Object { $_ })
    if ($shas.Count -eq 0 -or $shas.Count -ne $numbers.Count) { throw "Expected one PR number per commit (got $($shas.Count) commits, $($numbers.Count) PRs)." }
    $fixes = for ($i = 0; $i -lt $shas.Count; $i++) {
        $title = @(Invoke-Git log -1 --format=%s $shas[$i])[0]
        [pscustomobject]@{ Number = [int]$numbers[$i]; Title = $title; Commit = $shas[$i] }
    }
    Invoke-Git config user.name 'github-actions[bot]' | Out-Null
    Invoke-Git config user.email 'github-actions[bot]@users.noreply.github.com' | Out-Null
    New-SecurityHotfixBranch -StableTag $StableTag -Branch $Branch -Fixes $fixes

    $check = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Assert-ReleaseFromMain.ps1') -Mode Hotfix -Ref HEAD 2>&1
    $check | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Assert-ReleaseFromMain refuses the branch: $(($check | Select-String '::error::') -join ' ')" }

    if (-not $NoPush) { Invoke-Git push origin "HEAD:refs/heads/$Branch" | Out-Null }
    Write-Step "${Branch}: $StableTag + $($fixes.Count) cherry-pick(s): $(($fixes | ForEach-Object { "#$($_.Number)" }) -join ', ')"
} catch {
    Write-Reason "$_"
    exit 1
}
