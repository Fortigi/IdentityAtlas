<#
.SYNOPSIS
    Emit per-unit cyclomatic AND cognitive complexity for production PowerShell as JSON,
    for the complexity ratchet (tools/complexity/ratchet.py).

.DESCRIPTION
    Measurement is delegated to the published PSComplexity module
    (https://github.com/Fortigi/PSComplexity) -- a faithful, reference-validated
    SonarSource cognitive metric plus classic cyclomatic -- instead of a bundled measurer.
    This script only (a) selects the production PowerShell files (same include/exclude
    scope as before) and (b) maps PSComplexity's output to the ratchet's JSON contract:

        [ { "file": "<repo-relative>", "unit": "<name|<script-body>>", "line": <int>,
            "cc": <int>, "cog": <int> }, ... ]

    Cyclomatic numbers are identical to the previous bundled measurer; cognitive matches
    except where PSComplexity is more faithful (it also counts recursion and labelled
    break/continue). The baselines under .ci/ are generated from this output.

.OUTPUTS
    JSON array to stdout.
#>
[CmdletBinding()]
param(
    # Optional: measure only this file/dir (no production filtering) -- for ad-hoc use.
    [string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Module PSComplexity -ListAvailable | Where-Object Version -ge '0.1.0')) {
    Install-Module PSComplexity -RequiredVersion 0.1.0 -Force -Scope CurrentUser
}
Import-Module PSComplexity

# Production roots only. A path is measured when it matches an include root AND none of
# the exclusion patterns (generated mirror, deps, build output, git worktrees, or
# non-prod scripts). `.claude/` holds gitignored agent git worktrees whose full repo
# copies would otherwise be double-measured locally (they don't exist in CI), so exclude
# it to keep local and CI measurement in agreement.
$includeRx = 'crawlers|powershell-sdk|riskscoring|[\\/]setup[\\/]'
$excludeRx = '[\\/](node_modules|dist|dist-node-launcher|bundled-scripts|\.claude)[\\/]' +
             '|\.Tests\.ps1$|[\\/]Test-[^\\/]*Crawler\.ps1$|[\\/]Seed-|MockODataServer|MockMidpointServer'

if ($Path) {
    $files = @(Get-ChildItem -Path $Path -Recurse -Include *.ps1, *.psm1 -File)
}
else {
    $files = @(Get-ChildItem -Recurse -Include *.ps1, *.psm1 -File |
        Where-Object { $_.FullName -match $includeRx -and $_.FullName -notmatch $excludeRx })
}

$cwd = (Get-Location).Path
$results = if ($files.Count) {
    Measure-PSComplexity -Path $files.FullName | ForEach-Object {
        [pscustomobject]@{
            file = [System.IO.Path]::GetRelativePath($cwd, $_.File).Replace('\', '/')
            unit = $_.Unit
            line = $_.Line
            cc   = $_.Cyclomatic
            cog  = $_.Cognitive
        }
    }
}

@($results) | ConvertTo-Json -Depth 4 -Compress
