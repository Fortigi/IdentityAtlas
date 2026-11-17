<#
.SYNOPSIS
    What the weekly release run tests this run. Dot-source after
    ReleaseTest.Functions.ps1.

.DESCRIPTION
    One rule, decided from tags alone so it can be unit-tested without GitHub:

      * a pre-release (beta / rc / alpha) newer than the newest stable release,
        not tested before            -> test it, Azure included
      * otherwise                    -> test :edge, Docker and portable only,
                                        as an early warning that costs nothing
                                        in Azure

    "Tested before" is recorded as an artifact named release-tested-<tag>
    (Get-TestedMarkerName), uploaded by the weekly run once the test has
    finished, green or red. So a beta is tested once; testing it again is a
    manual run (Actions → Release weekly → candidate).
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

function Get-WeeklyPlan {
    <#
    .SYNOPSIS
        This run's candidate and whether Azure is part of it.
    .PARAMETER Override
        A candidate a person asked for (workflow_dispatch). Always tested, with
        Azure unless it is edge.
    .PARAMETER Tested
        The pre-release tags that already carry a tested marker.
    .PARAMETER BetaRoute
        This run's beta route cuts and tests a new beta of main, which is newer
        than :edge's state at the last run and than any older beta: nothing else to
        test then (Candidate is empty).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string[]] $Tags = @(), [string[]] $Tested = @(), [string] $Override = '', [switch] $BetaRoute)
    if ($Override) {
        Assert-Candidate $Override
        return @{ Candidate = $Override; Azure = ($Override -ne 'edge'); Reason = 'asked for by hand' }
    }
    if ($BetaRoute) { return @{ Candidate = ''; Azure = $false; Reason = 'the beta route tests this run''s new beta of main' } }
    $beta = Get-NewestPreRelease $Tags
    if ($beta -and $Tested -notcontains $beta) {
        return @{ Candidate = $beta; Azure = $true; Reason = "$beta has not been tested yet" }
    }
    $why = if ($beta) { "the newest pre-release, $beta, was tested before" } else { 'no pre-release is ahead of the newest stable release' }
    @{ Candidate = 'edge'; Azure = $false; Reason = "$why; early warning on edge, without Azure" }
}

# ── The two release routes: what to cut this run ────────────────────────────
# Both decide from facts the plan script gathers from git (Get-WeeklyPlan.ps1),
# so every rule here is unit-tested without a repository.

function Get-ReleaseLineName {
    <# The branch a stable release's patch releases come from: v6.1.1 -> release/6.1. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $StableTag)
    if ($StableTag -notmatch '^v(\d+)\.(\d+)\.\d+$') { throw "'$StableTag' is not a stable release tag." }
    "release/$($Matches[1]).$($Matches[2])"
}

function Get-NextMinorBeta {
    <#
    .SYNOPSIS
        The next beta of main: which version, which beta tag came before it.
    .DESCRIPTION
        main's betas are X.Y.0-beta.N of the minor after the newest stable
        release (6.2.0-beta.N while 6.1.x is stable). A person may already have
        started a later one (7.0.0-beta.1): the highest X.Y.0 beta ahead of
        stable wins. Patch betas (6.1.2-beta.1) belong to the release line and
        never count here. Previous is the newest beta tag of that version, or
        empty when this run's would be its first.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string[]] $Tags = @())
    $stable = (Get-StableTag $Tags | Select-Object -First 1)
    if (-not $stable) { throw 'No stable release tag: the next minor is not defined.' }
    $floor = [version]$stable.Substring(1)
    $ahead = @($Tags | Where-Object { $_ -match '^v(\d+\.\d+\.0)-beta\.(\d+)$' -and [version]$Matches[1] -gt $floor })
    $base = if ($ahead.Count) {
        @($ahead | ForEach-Object { [version]($_ -replace '^v|-beta\.\d+$', '') } | Sort-Object -Descending)[0].ToString()
    } else { "$($floor.Major).$($floor.Minor + 1).0" }
    $previous = @($ahead | Where-Object { $_.StartsWith("v$base-beta.", [StringComparison]::Ordinal) } |
        Sort-Object { [int]($_ -replace '^.*-beta\.', '') } -Descending)
    @{ Version = (Get-NextBetaVersion -Version $base -Tags $Tags); Previous = $(if ($previous.Count) { $previous[0] } else { '' }) }
}

function Test-ShippedDependencyCommit {
    <#
    .SYNOPSIS
        True when a Dependabot commit changes something a customer runs.
    .DESCRIPTION
        Dependabot lists every dependency it moved in the commit body
        (`dependency-type: direct:production | direct:development | indirect`).
        Only development dependencies (eslint, vitest, playwright …) are left
        out: the API image is built with --omit=dev and the UI ships compiled
        dist/. A body without that list (an older format) counts, to be safe.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([string] $Body = '')
    $types = @([regex]::Matches($Body, '(?m)^\s*dependency-type:\s*(\S+)') | ForEach-Object { $_.Groups[1].Value })
    if ($types.Count -eq 0) { return $true }
    return @($types | Where-Object { $_ -ne 'direct:development' }).Count -gt 0
}

function Get-StableRoutePlan {
    <#
    .SYNOPSIS
        Whether this run cuts a patch release of the newest stable line.
    .PARAMETER BranchExists
        release/X.Y exists on the remote.
    .PARAMETER ContainsStable
        The newest stable tag is an ancestor of release/X.Y (a hotfix cut from
        elsewhere would leave the line behind; that needs a person).
    .PARAMETER NewCommits
        Commits on release/X.Y after the stable tag.
    .PARAMETER AttemptedAtHead
        Pre-release tags already on the line's newest commit: an earlier run
        tried exactly this, and its result stands until the line moves.
    .PARAMETER TemplatesChanged
        The Azure templates differ between the stable tag and the line.
    .PARAMETER Retry
        A person asked to try the same commit again.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [string[]] $Tags = @(),
        [bool] $BranchExists, [bool] $ContainsStable, [int] $NewCommits,
        [string[]] $AttemptedAtHead = @(), [bool] $TemplatesChanged, [switch] $Retry
    )
    $stable = (Get-StableTag $Tags | Select-Object -First 1)
    if (-not $stable) { return @{ Needed = $false; Reason = 'there is no stable release yet' } }
    $line = Get-ReleaseLineName $stable
    $skip = if (-not $BranchExists) { "$line does not exist; Cut Release creates it with X.Y.0" }
            elseif (-not $ContainsStable) { "$stable is not on $line, so a patch from the line would drop what $stable fixed; a person must bring the line up to date" }
            elseif ($NewCommits -eq 0) { "$line has nothing that $stable does not have" }
            elseif ($AttemptedAtHead.Count -and -not $Retry) { "$line has not moved since $($AttemptedAtHead[0]) was tried; run by hand with retry_stable to try again" }
    if ($skip) { return @{ Needed = $false; Line = $line; Reason = $skip } }
    $version = Get-NextPatchVersion $stable
    @{
        Needed = $true; Line = $line; Version = $version; Beta = (Get-NextBetaVersion -Version $version -Tags $Tags)
        Azure = $TemplatesChanged
        Reason = "$line has $NewCommits commit(s) after $stable$(if ($TemplatesChanged) { ', Azure templates included' })"
    }
}

function Get-BetaRoutePlan {
    <#
    .SYNOPSIS
        Whether this run cuts a new beta of main, and whether it gets Azure.
    .PARAMETER ShippedUpdates
        Dependabot commits on main, since the previous beta of this minor (or
        since main and the stable release parted), that change shipped code
        (Test-ShippedDependencyCommit).
    .PARAMETER TemplatesChanged
        The Azure templates differ between that same starting point and main.
    .DESCRIPTION
        Azure runs for the first beta of a minor (the full test a new minor
        gets) and whenever the templates changed since the beta before it.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string[]] $Tags = @(), [int] $ShippedUpdates, [bool] $TemplatesChanged)
    $next = Get-NextMinorBeta $Tags
    $since = if ($next.Previous) { $next.Previous } else { 'the newest stable release' }
    if ($ShippedUpdates -eq 0) { return @{ Needed = $false; Reason = "no Dependabot update of shipped code on main since $since" } }
    $first = -not $next.Previous
    $azure = $first -or $TemplatesChanged
    $why = if ($first) { 'first beta of this minor: full test' } elseif ($TemplatesChanged) { 'Azure templates changed' } else { 'no Azure: templates unchanged' }
    @{ Needed = $true; Version = $next.Version; Azure = $azure; Reason = "$ShippedUpdates Dependabot update(s) since $since; $why" }
}

function Test-DependabotTargetsLine {
    <# True when .github/dependabot.yml points its release-line entries at $Line. #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([string] $Config = '', [Parameter(Mandatory)][string] $Line)
    $targets = @([regex]::Matches($Config, '(?m)^\s*target-branch:\s*"?([^"\s#]+)"?') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    return ($targets.Count -eq 1) -and ($targets[0] -eq $Line)
}

function Set-DependabotReleaseLine {
    <#
    .SYNOPSIS
        .github/dependabot.yml with its release-line entries moved to $Line.
    .DESCRIPTION
        Cut Release calls this for every X.Y.0: only the newest stable minor is
        maintained, so every `target-branch` moves to the new release/X.Y (and
        the section heading with it). Throws when the file has no release-line
        entries, so a reshaped file fails loudly instead of silently keeping the
        old line.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $Config, [Parameter(Mandatory)][string] $Line)
    if ($Line -notmatch '^release/\d+\.\d+$') { throw "'$Line' is not a release line (release/X.Y)." }
    $pattern = '(?m)^(\s*target-branch:\s*)"release/\d+\.\d+"'
    if (-not [regex]::IsMatch($Config, $pattern)) { throw '.github/dependabot.yml has no release-line entries (target-branch: "release/X.Y").' }
    $moved = [regex]::Replace($Config, $pattern, "`${1}`"$Line`"")
    [regex]::Replace($moved, '(The stable release line: )release/\d+\.\d+', "`${1}$Line")
}

# ── Writing the plan out ────────────────────────────────────────────────────

function ConvertTo-RouteOutput {
    <#
    .SYNOPSIS
        One route's $GITHUB_OUTPUT values: <name>_needed, _version, (_beta), _sha, _azure.
    .DESCRIPTION
        A route that is not needed gets empty values and false flags, so no
        later job can pick up a version or a commit from a plan that said no.
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param([Parameter(Mandatory)][string] $Name, [Parameter(Mandatory)][hashtable] $Plan, [string] $Sha = '', [string[]] $Keys = @('Version'))
    $needed = [bool]$Plan['Needed']
    $out = [ordered]@{ "${Name}_needed" = $needed.ToString().ToLower() }
    foreach ($key in $Keys) { $out["${Name}_$($key.ToLower())"] = $(if ($needed) { "$($Plan[$key])" } else { '' }) }
    $out["${Name}_sha"] = $(if ($needed) { $Sha } else { '' })
    $out["${Name}_azure"] = ($needed -and [bool]$Plan['Azure']).ToString().ToLower()
    $out
}

function Format-WeeklySummary {
    <# The run summary's "This run" block: what each route does and why. #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][hashtable] $Stable, [Parameter(Mandatory)][hashtable] $Beta, [Parameter(Mandatory)][hashtable] $Test, [string] $LineWarning = '')
    $azure = { param($p) if ($p['Azure']) { ', with Azure' } else { ', no Azure' } }
    $stableText = if ($Stable['Needed']) { "v$($Stable.Beta) then v$($Stable.Version)$(& $azure $Stable)" } else { 'nothing to do' }
    $betaText = if ($Beta['Needed']) { "v$($Beta.Version)$(& $azure $Beta)" } else { 'nothing to do' }
    $testText = if ($Test['Candidate']) { "``$($Test.Candidate)``$(& $azure $Test)" } else { 'nothing else' }
    $lines = @('## This run', '',
        "- **Stable route:** $stableText. $($Stable.Reason).",
        "- **Beta route:** $betaText. $($Beta.Reason).",
        "- **Test:** $testText. $($Test.Reason).")
    if ($LineWarning) {
        $lines += @('', ('**Warning:** `.github/dependabot.yml` does not point its release-line entries at `' + $LineWarning +
            '`, so that line gets no updates. Cut Release opens a PR for this when it cuts X.Y.0; merge it.'))
    }
    $lines
}
