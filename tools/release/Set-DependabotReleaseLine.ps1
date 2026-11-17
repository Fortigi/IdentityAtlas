<#
.SYNOPSIS
    Points .github/dependabot.yml's release-line entries at release/X.Y.

.DESCRIPTION
    Run by Cut Release after it cuts X.Y.0, on a branch from main, before it
    opens the pull request that moves Dependabot to the new line. The rewrite
    is Set-DependabotReleaseLine (ReleaseNightly.Functions.ps1).

.EXAMPLE
    pwsh tools/release/Set-DependabotReleaseLine.ps1 -Line release/6.2
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Line,
    [string] $Path = '.github/dependabot.yml'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'ReleaseNightly.Functions.ps1')

$before = Get-Content -Raw $Path
$after = Set-DependabotReleaseLine -Config $before -Line $Line
Set-Content -Path $Path -Value $after -NoNewline
if ($before -eq $after) { Write-Output "$Path already targets $Line." } else { Write-Output "$Path now targets $Line." }
