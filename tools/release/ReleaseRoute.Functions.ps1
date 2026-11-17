<#
.SYNOPSIS
    Shared pieces of the two weekly release routes (release-route.yml): version
    numbers, waiting for the images, and what a finished route means.

.DESCRIPTION
    The weekly run (release-weekly.yml) can start two routes, each a call of
    release-route.yml: cut a beta, wait for its images, release-test it, and
    for the stable route only, cut the stable release from the same commit.

      stable   the release line, release/X.Y, has Dependabot updates the newest
               stable vX.Y.Z does not have -> vX.Y.(Z+1)-beta.N, test, vX.Y.(Z+1)
      beta     main has Dependabot updates of shipped code since the last beta
               of the next minor -> vX.(Y+1).0-beta.N, test

    What to start is decided in ReleaseWeekly.Functions.ps1. Dot-source after
    ReleaseTest.Functions.ps1.
#>

Set-StrictMode -Version Latest

function Get-NextPatchVersion {
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
        next attempt for the same version must not reuse its number.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $Version, [string[]] $Tags = @())
    $pattern = '^v' + [regex]::Escape($Version) + '-beta\.(\d+)$'
    $taken = @($Tags | ForEach-Object { if ($_ -match $pattern) { [int]$Matches[1] } })
    $next = if ($taken.Count) { ($taken | Measure-Object -Maximum).Maximum + 1 } else { 1 }
    "$Version-beta.$next"
}

function Invoke-Git {
    <# git <args>, returning stdout lines; throws with git's message on failure. #>
    [CmdletBinding()]
    param([Parameter(ValueFromRemainingArguments)][string[]] $Arguments)
    $out = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $($out -join ' ')" }
    @($out | ForEach-Object { "$_" })
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

function Get-RouteOutcome {
    <#
    .SYNOPSIS
        What a route ended in, and whether to open an issue about it.
    .DESCRIPTION
        $Results holds each stage's job result (success / failure / cancelled /
        skipped), in pipeline order: beta, images, test, and for the stable
        route (-Promote) release. The first stage that did not succeed is the
        reason. In a dry run the stages that need a pushed tag (images, test)
        are skipped by design and count as passed. An issue is opened for
        every real failure, never for a dry run.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][hashtable] $Results,
        [switch] $Promote,
        [switch] $DryRun,
        [string] $Beta = '',
        [string] $Version = ''
    )
    $why = [ordered]@{
        beta    = "Cut Beta failed for $Beta."
        images  = "The $Beta images did not appear on ghcr.io in time: check the Publish Docker Images run for that tag."
        test    = "The release test of v$Beta is red."
        release = "Cut Hotfix failed for $Version. If its tag was already pushed, check the Publish Docker Images run before retrying."
    }
    if (-not $Promote) { $why.Remove('release') }
    $needsTag = @('images', 'test')
    foreach ($stage in $why.Keys) {
        $result = [string]$Results[$stage]
        if ($result -eq 'success') { continue }
        if ($DryRun -and $result -eq 'skipped' -and $needsTag -contains $stage) { continue }
        $reason = if ($result -eq 'cancelled') { "The run was cancelled at '$stage'." } else { $why[$stage] }
        return @{ Passed = $false; Reason = $reason; OpenIssue = -not $DryRun }
    }
    if ($DryRun) { return @{ Passed = $true; Reason = 'Dry run complete: nothing was tagged or published.'; OpenIssue = $false } }
    $done = if ($Promote) { "v$Version is released." } else { "v$Beta is published and passed the release test." }
    @{ Passed = $true; Reason = $done; OpenIssue = $false }
}
