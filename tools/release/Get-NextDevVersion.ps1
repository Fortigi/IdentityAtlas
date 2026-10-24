<#
.SYNOPSIS
    Computes the next main dev-build version (Major.Minor.yyyyMMdd.HHmm).

.DESCRIPTION
    bump-version.yml runs this on every PR merge to main. Minor counts merges;
    the timestamp is the build time.

    Major follows the releases. The cut-* workflows stamp a release's version
    only into their own throwaway checkout and never write it back to main, so
    reading Major from the .psd1 alone kept main on 5.x long after v6.0.0 shipped.
    Major is therefore the highest of the .psd1's major and the major of any
    v<major>.<minor>.<patch> tag (pre-releases included: a v7.0.0-beta is cut
    from main, so main already holds 7.x work). When Major moves up, Minor
    restarts so the first build of a new major is X.1.

.EXAMPLE
    pwsh tools/release/Get-NextDevVersion.ps1 -CurrentVersion 5.835.20261022.1333 -Tags v6.0.3,v5.9.2
    # → 6.1.<now>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $CurrentVersion,
    [string[]] $Tags = @(),
    [datetime] $Now = (Get-Date)
)

$ErrorActionPreference = 'Stop'

if ($CurrentVersion -notmatch '^(\d+)\.(\d+)\.\d+\.\d+$') {
    throw "CurrentVersion '$CurrentVersion' is not Major.Minor.Build.Revision."
}
$major = [int]$Matches[1]
$minor = [int]$Matches[2]

$tagMajor = $Tags |
    ForEach-Object { if ($_ -match '^(?:refs/tags/)?v(\d+)\.\d+\.\d+') { [int]$Matches[1] } } |
    Measure-Object -Maximum
if ($tagMajor.Count -gt 0 -and $tagMajor.Maximum -gt $major) {
    $major = [int]$tagMajor.Maximum
    $minor = 0
}

"$major.$($minor + 1).$($Now.ToString('yyyyMMdd.HHmm'))"
