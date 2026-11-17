<#
.SYNOPSIS
    The nightly security route: which Dependabot security fixes on main still
    have to reach stable, and the hotfix that carries them.

.DESCRIPTION
    A security fix is a merged pull request into main that
      * Dependabot opened (author dependabot[bot]), and
      * carries the `security-fix` label, which dependabot-security-label.yml
        sets when fetch-metadata's alert lookup links the PR to a Dependabot
        alert and the update is a patch or minor one.

    It "still has to reach stable" when it was merged after the commit on main
    the newest stable release grew from, and that release contains neither the
    commit itself nor a `git cherry-pick -x` of it.

    All of them go into ONE hotfix: a branch from the newest stable tag holding
    their merge commits, cherry-picked with -x in merge order — exactly what
    Assert-ReleaseFromMain.ps1 -Mode Hotfix accepts.
#>

Set-StrictMode -Version Latest

$script:SecurityLabel = 'security-fix'
$script:DependabotLogin = 'dependabot[bot]'
$script:HotfixBranchPrefix = 'bugfixes/security-hotfix-'

function Get-SecurityLabel { [CmdletBinding()] [OutputType([string])] param() $script:SecurityLabel }

function Get-HotfixVersion {
    <# The next patch after a stable tag: v6.1.1 -> 6.1.2. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $StableTag)
    if ($StableTag -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { throw "'$StableTag' is not a stable release tag." }
    "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
}

function Get-NextBetaVersion {
    <#
    .SYNOPSIS
        <version>-beta.N with N one past the highest existing beta of that version.
    .DESCRIPTION
        A failed attempt keeps its beta tag (nothing is ever deleted), so the
        next attempt for the same patch must not reuse its number.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $Version, [string[]] $Tags = @())
    $pattern = '^v' + [regex]::Escape($Version) + '-beta\.(\d+)$'
    $taken = @($Tags | ForEach-Object { if ($_ -match $pattern) { [int]$Matches[1] } })
    $next = if ($taken.Count) { ($taken | Measure-Object -Maximum).Maximum + 1 } else { 1 }
    "$Version-beta.$next"
}

function Get-SecurityHotfixBranchName {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][datetime] $Date)
    $script:HotfixBranchPrefix + $Date.ToUniversalTime().ToString('yyyyMMdd')
}

function Get-KeptHotfixBranch {
    <#
    .SYNOPSIS
        Security-hotfix branches still on the remote.
    .DESCRIPTION
        A successful run deletes its branch, so one that is still there is a
        failed attempt (or a dry run) a person has to look at. While one
        exists the route starts nothing new: retrying a conflict every night
        would only pile up branches.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string[]] $RemoteBranches = @())
    @($RemoteBranches | ForEach-Object { $_ -replace '^(refs/heads/|origin/)', '' } |
        Where-Object { $_.StartsWith($script:HotfixBranchPrefix, [StringComparison]::Ordinal) })
}

function Test-SecurityFixPullRequest {
    <# Dependabot's, labelled, merged into main, with a merge commit. #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] $PullRequest)
    $author = Get-Prop (Get-Prop $PullRequest 'author') 'login'
    $labels = @(Get-Prop $PullRequest 'labels' | ForEach-Object { Get-Prop $_ 'name' })
    $commit = Get-Prop (Get-Prop $PullRequest 'mergeCommit') 'oid'
    return ($author -eq $script:DependabotLogin) -and ($labels -contains $script:SecurityLabel) -and
        ((Get-Prop $PullRequest 'baseRefName') -eq 'main') -and [bool](Get-Prop $PullRequest 'mergedAt') -and [bool]$commit
}

function Select-SecurityFix {
    <#
    .SYNOPSIS
        The security fixes still missing from stable, oldest merge first.
    .PARAMETER PullRequests
        `gh pr list --json number,title,author,labels,baseRefName,mergedAt,mergeCommit` output.
    .PARAMETER Since
        When the newest stable release's base commit landed on main. Fixes
        merged before it are part of that release or of an earlier one.
    .PARAMETER IsInRelease
        Scriptblock: given a merge commit SHA, true when the newest stable
        release already contains it (directly or as a cherry-pick).
    #>
    [CmdletBinding()]
    param(
        [object[]] $PullRequests = @(),
        [Parameter(Mandatory)][datetime] $Since,
        [Parameter(Mandatory)][scriptblock] $IsInRelease
    )
    $fixes = foreach ($pr in $PullRequests) {
        if (-not (Test-SecurityFixPullRequest $pr)) { continue }
        $merged = [datetime]::Parse((Get-Prop $pr 'mergedAt'), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
        if ($merged -le $Since.ToUniversalTime()) { continue }
        $sha = (Get-Prop (Get-Prop $pr 'mergeCommit') 'oid')
        if (& $IsInRelease $sha) { continue }
        [pscustomobject]@{ Number = [int](Get-Prop $pr 'number'); Title = [string](Get-Prop $pr 'title'); Commit = $sha; MergedAt = $merged }
    }
    @($fixes | Sort-Object MergedAt)
}

function Invoke-Git {
    <# git <args>, returning stdout lines; throws with git's message on failure. #>
    [CmdletBinding()]
    param([Parameter(ValueFromRemainingArguments)][string[]] $Arguments)
    $out = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $($out -join ' ')" }
    @($out | ForEach-Object { "$_" })
}

function Get-ReleaseBaseDate {
    <# When the commit on main that a stable tag grew from was committed. #>
    [CmdletBinding()]
    [OutputType([datetime])]
    param([Parameter(Mandatory)][string] $StableTag, [string] $Main = 'origin/main')
    $base = @(Invoke-Git merge-base $StableTag $Main)[0]
    $iso = @(Invoke-Git show -s --format=%cI $base)[0]
    [datetimeoffset]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
}

function Test-CommitInRelease {
    <#
    .SYNOPSIS
        True when a stable tag already contains a main commit: as an ancestor
        (a release cut from main after it), or as a `cherry-pick -x` of it on
        the release's own hotfix line.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string] $Commit,
        [Parameter(Mandatory)][string] $StableTag,
        [string] $Main = 'origin/main'
    )
    & git merge-base --is-ancestor $Commit $StableTag 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
    $base = @(Invoke-Git merge-base $StableTag $Main)[0]
    $messages = (Invoke-Git log --format=%B "$base..$StableTag") -join "`n"
    return $messages.Contains("(cherry picked from commit $Commit)")
}

function New-SecurityHotfixBranch {
    <#
    .SYNOPSIS
        Creates the hotfix branch locally: the stable tag plus a `cherry-pick -x`
        of each fix, in order. Throws, naming the PR, on the first conflict;
        the half-done cherry-pick is aborted so nothing hand-resolved survives.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string] $StableTag,
        [Parameter(Mandatory)][string] $Branch,
        [Parameter(Mandatory)][object[]] $Fixes
    )
    if (-not $PSCmdlet.ShouldProcess($Branch, "create from $StableTag with $($Fixes.Count) cherry-pick(s)")) { return }
    Invoke-Git switch --quiet --create $Branch $StableTag | Out-Null
    foreach ($fix in $Fixes) {
        & git cherry-pick -x $fix.Commit 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            & git cherry-pick --abort 2>&1 | Out-Null
            throw "Cherry-picking #$($fix.Number) ($($fix.Commit.Substring(0, 9)), $($fix.Title)) onto $StableTag conflicts."
        }
    }
}

function Test-ImagePublished {
    <# True when ghcr.io serves <image>:<tag> to an anonymous client, as docker pull would. #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)][string] $Image, [Parameter(Mandatory)][string] $Tag)
    $token = (Invoke-RestMethod -Uri "https://ghcr.io/token?scope=repository:${Image}:pull" -TimeoutSec 30).token
    $accept = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
    $r = Invoke-WebRequest -Method Head -Uri "https://ghcr.io/v2/$Image/manifests/$Tag" -Headers @{ Authorization = "Bearer $token"; Accept = $accept } -SkipHttpErrorCheck -TimeoutSec 30
    return [int]$r.StatusCode -eq 200
}

function Get-ReleaseImage {
    <# The three images docker-publish.yml pushes for every tag. #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()
    @('fortigi/identity-atlas', 'fortigi/identity-atlas-worker', 'fortigi/identity-atlas-report-generator')
}

function Wait-ImagePublished {
    <# Waits until all three images exist under $Tag; docker-publish takes about 20 minutes. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Tag, [int] $TimeoutSec = 4500)
    Wait-Until -Description "the $Tag images on ghcr.io" -TimeoutSec $TimeoutSec -IntervalSec 60 -Condition {
        @(Get-ReleaseImage | Where-Object { -not (Test-ImagePublished -Image $_ -Tag $Tag) }).Count -eq 0
    } | Out-Null
}

function Get-SecurityRouteOutcome {
    <#
    .SYNOPSIS
        What the route ended in, and what to do about it.
    .DESCRIPTION
        $Results holds each stage's job result (success / failure / cancelled /
        skipped), in pipeline order: branch, beta, images, test, hotfix. The
        first stage that did not succeed is the reason. In a dry run the
        stages that need a pushed tag (images, test) are skipped by design and
        count as passed. Nothing is published, and the branch is kept, unless
        every stage passed for real; an issue is opened for every real failure.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][hashtable] $Results,
        [switch] $DryRun,
        [string] $Beta = '',
        [string] $Version = '',
        [string] $BranchReason = ''
    )
    $why = [ordered]@{
        branch = "Building the hotfix branch failed$(if ($BranchReason) { ": $BranchReason" } else { '.' })"
        beta   = "Cut Beta failed for $Beta."
        images = "The $Beta images did not appear on ghcr.io in time: check the Publish Docker Images run for that tag."
        test   = "The release test of $Beta is red."
        hotfix = "Cut Hotfix failed for $Version. If its tag was already pushed, check the Publish Docker Images run before retrying."
    }
    $needsTag = @('images', 'test')
    foreach ($stage in $why.Keys) {
        $result = [string]$Results[$stage]
        if ($result -eq 'success') { continue }
        if ($DryRun -and $result -eq 'skipped' -and $needsTag -contains $stage) { continue }
        $reason = if ($result -eq 'cancelled') { "The run was cancelled at '$stage'." } else { $why[$stage] }
        return @{ Passed = $false; Reason = $reason; DeleteBranch = $false; OpenIssue = -not $DryRun }
    }
    if ($DryRun) { return @{ Passed = $true; Reason = 'Dry run complete: nothing was tagged or published.'; DeleteBranch = $false; OpenIssue = $false } }
    @{ Passed = $true; Reason = "v$Version is released."; DeleteBranch = $true; OpenIssue = $false }
}
