<#
.SYNOPSIS
    What the nightly release run tests tonight. Dot-source after
    ReleaseTest.Functions.ps1.

.DESCRIPTION
    One rule, decided from tags alone so it can be unit-tested without GitHub:

      * a pre-release (beta / rc / alpha) newer than the newest stable release,
        not tested before            -> test it, Azure included
      * otherwise                    -> test :edge, Docker and portable only,
                                        as an early warning that costs nothing
                                        in Azure

    "Tested before" is recorded as an artifact named release-tested-<tag>
    (Get-TestedMarkerName), uploaded by the nightly run once the test has
    finished, green or red. So a beta is tested once; testing it again is a
    manual run (Actions → Release nightly → candidate).
#>

Set-StrictMode -Version Latest

$script:PreReleasePattern = '^v(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$'
$script:PreReleaseRank = @{ alpha = 0; beta = 1; rc = 2 }

function Get-PreReleaseSortKey {
    <# Base version, then alpha < beta < rc, then the number: v6.2.0-beta.10 after v6.2.0-beta.9. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Tag)
    if ($Tag -notmatch $script:PreReleasePattern) { throw "'$Tag' is not a pre-release tag." }
    [pscustomobject]@{ Version = [version]$Matches[1]; Rank = $script:PreReleaseRank[$Matches[2]]; Number = [int]$Matches[3] }
}

function Get-NewestPreRelease {
    <#
    .SYNOPSIS
        The newest pre-release that is ahead of every stable release, or $null.
    .DESCRIPTION
        A pre-release whose version a stable release has already reached
        (v6.1.0-rc.1 once v6.1.0 exists) or passed is history, not a candidate.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([string[]] $Tags = @())
    $stable = @(Get-StableTag $Tags)
    $floor = if ($stable.Count) { [version]$stable[0].Substring(1) } else { [version]'0.0.0' }
    $ahead = @($Tags | Where-Object { $_ -match $script:PreReleasePattern -and [version]$Matches[1] -gt $floor })
    if ($ahead.Count -eq 0) { return $null }
    $ahead | Sort-Object { (Get-PreReleaseSortKey $_).Version }, { (Get-PreReleaseSortKey $_).Rank }, { (Get-PreReleaseSortKey $_).Number } |
        Select-Object -Last 1
}

function Get-TestedMarkerName {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $Candidate)
    Assert-Candidate $Candidate
    "release-tested-$Candidate"
}

function Get-NightlyPlan {
    <#
    .SYNOPSIS
        Tonight's candidate and whether Azure is part of it.
    .PARAMETER Override
        A candidate a person asked for (workflow_dispatch). Always tested, with
        Azure unless it is edge.
    .PARAMETER Tested
        The pre-release tags that already carry a tested marker.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string[]] $Tags = @(), [string[]] $Tested = @(), [string] $Override = '')
    if ($Override) {
        Assert-Candidate $Override
        return @{ Candidate = $Override; Azure = ($Override -ne 'edge'); Reason = 'asked for by hand' }
    }
    $beta = Get-NewestPreRelease $Tags
    if ($beta -and $Tested -notcontains $beta) {
        return @{ Candidate = $beta; Azure = $true; Reason = "$beta has not been tested yet" }
    }
    $why = if ($beta) { "the newest pre-release, $beta, was tested before" } else { 'no pre-release is ahead of the newest stable release' }
    @{ Candidate = 'edge'; Azure = $false; Reason = "$why; early warning on edge, without Azure" }
}
