<#
.SYNOPSIS
    Splits the Pester unit suite into parallel shards and merges their coverage back
    into one number, so PR Checks can run the suite on several runners and still
    enforce a single coverage floor.

.DESCRIPTION
    Dot-source this file; it defines functions only. It must not change session state:
    the shard job dot-sources it into the scope that then runs the whole suite, so a
    top-level Set-StrictMode here would switch strict mode on for every test file.

    Sharding: files are assigned greedily, heaviest first, to the currently lightest
    shard (longest-processing-time first). Weights are seconds measured in CI and kept
    in test/unit/pester-weights.json. A file missing from that list gets the default
    weight, so a new test file is never dropped, only possibly mis-balanced.

    Coverage: every shard measures the SAME product files (Get-PesterCoverageTarget), so
    each one analyzes the same commands. A shard records which commands it analyzed and
    which it executed; the merged result counts a command covered when ANY shard
    executed it. That is exactly what a single run over all files would report.
    Merging JaCoCo XML instead would be lossy: its per-line counters can't tell which
    commands on a line were hit.
#>


function Get-PesterShardFile {
    <#
    .SYNOPSIS  The test files of shard $Index (1-based) out of $Count.
    .PARAMETER TestFile       Test file paths; their leaf names key into $Weight.
    .PARAMETER Weight         Leaf name → seconds.
    .PARAMETER DefaultWeight  Weight of a file not in $Weight.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [string[]] $TestFile,
        [Parameter(Mandatory)] [hashtable] $Weight,
        [Parameter(Mandatory)] [ValidateRange(1, 64)] [int] $Count,
        [Parameter(Mandatory)] [int] $Index,
        [double] $DefaultWeight = 0.3
    )
    if ($Index -lt 1 -or $Index -gt $Count) {
        throw "Shard index $Index is outside 1..$Count."
    }
    $weighted = $TestFile | ForEach-Object {
        $leaf = Split-Path $_ -Leaf
        $w = if ($Weight.ContainsKey($leaf)) { [double]$Weight[$leaf] } else { $DefaultWeight }
        [pscustomobject]@{ Path = $_; Leaf = $leaf; Weight = $w }
    }
    # Heaviest first; leaf name breaks ties so every runner computes the same split.
    $ordered = $weighted | Sort-Object -Property @{ Expression = 'Weight'; Descending = $true }, Leaf
    $load = [double[]]::new($Count)
    $mine = [System.Collections.Generic.List[string]]::new()
    foreach ($f in $ordered) {
        $target = [array]::IndexOf($load, ($load | Measure-Object -Minimum).Minimum)
        $load[$target] += $f.Weight
        if ($target -eq $Index - 1) { $mine.Add($f.Path) }
    }
    # Callers wrap the result in @(): an empty shard yields nothing.
    $mine.ToArray()
}

function Get-PesterCoverageTarget {
    <#
    .SYNOPSIS  The product .ps1 files whose coverage the PR Pester floor measures.
    .DESCRIPTION
        PRODUCT code only: the SDK, risk scoring and every crawler folder (one with a
        crawler.json). Tooling inside those dirs is dropped — self-test harnesses
        (Test-*Crawler.ps1), data seeders (Seed-*), dev-only scripts and tests — the
        same rationale as excluding *.test.js on the JS side.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [string] $Root)
    $crawlerDirs = Get-ChildItem (Join-Path $Root 'tools' 'crawlers') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'crawler.json') }
    $candidates = @(
        Get-ChildItem (Join-Path $Root 'tools' 'powershell-sdk'), (Join-Path $Root 'tools' 'riskscoring') -Recurse -Filter '*.ps1' -File
        $crawlerDirs | ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter '*.ps1' -File }
    )
    $candidates | Where-Object {
        $_.Name -notlike '*.Tests.ps1' -and
        $_.Name -notlike 'Test-*Crawler.ps1' -and
        $_.Name -notlike 'Seed-*' -and
        $_.FullName -notmatch '[\\/]dev[\\/]'
    } | Select-Object -ExpandProperty FullName | Sort-Object
}

function Get-CoverageCommandKey {
    <#
    .SYNOPSIS  A position key for one Pester coverage command, relative to $Root.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] $Command,
        [Parameter(Mandatory)] [string] $Root
    )
    $file = [System.IO.Path]::GetRelativePath($Root, $Command.File) -replace '\\', '/'
    '{0}:{1}:{2}-{3}:{4}' -f $file, $Command.StartLine, $Command.StartColumn, $Command.EndLine, $Command.EndColumn
}

function ConvertTo-PesterShardRecord {
    <#
    .SYNOPSIS  What one shard hands to the merge: its test counts and coverage keys.
    .PARAMETER Result  The PassThru object from Invoke-Pester.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] $Result,
        [Parameter(Mandatory)] [string] $Root
    )
    $cc = $Result.CodeCoverage
    $executed = @($cc.CommandsExecuted | ForEach-Object { Get-CoverageCommandKey $_ $Root })
    $missed = @($cc.CommandsMissed | ForEach-Object { Get-CoverageCommandKey $_ $Root })
    [pscustomobject]@{
        TotalCount  = [int]$Result.TotalCount
        FailedCount = [int]$Result.FailedCount
        Analyzed    = @($executed + $missed | Sort-Object)
        Executed    = @($executed | Sort-Object)
    }
}

function Merge-PesterShardRecord {
    <#
    .SYNOPSIS  One coverage figure from every shard's record.
    .DESCRIPTION
        Throws when the shards did not analyze the same commands: their coverage then
        can't be combined, and guessing would publish a number for different code.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [object[]] $Record)
    $reference = ($Record[0].Analyzed) -join "`n"
    foreach ($r in $Record) {
        if ((($r.Analyzed) -join "`n") -ne $reference) {
            throw 'Pester shards analyzed different command sets — every shard must measure the same files (Get-PesterCoverageTarget).'
        }
    }
    $analyzed = @($Record[0].Analyzed)
    $covered = [System.Collections.Generic.HashSet[string]]::new([string[]]@($Record | ForEach-Object { $_.Executed }))
    $hit = @($analyzed | Where-Object { $covered.Contains($_) }).Count
    $percent = if ($analyzed.Count) { 100.0 * $hit / $analyzed.Count } else { 0.0 }
    [pscustomobject]@{
        Shards      = $Record.Count
        Tests       = ($Record | Measure-Object -Property TotalCount -Sum).Sum
        Failed      = ($Record | Measure-Object -Property FailedCount -Sum).Sum
        Analyzed    = $analyzed.Count
        Covered     = $hit
        Percent     = $percent
    }
}
