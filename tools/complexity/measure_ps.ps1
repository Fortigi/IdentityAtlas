<#
.SYNOPSIS
    Emit per-unit cyclomatic AND cognitive complexity for all repository PowerShell as JSON,
    for the complexity ratchet (tools/complexity/ratchet.py).

.DESCRIPTION
    Measurement is delegated to the published PSComplexity module
    (https://github.com/Fortigi/PSComplexity) -- a faithful, reference-validated
    SonarSource cognitive metric plus classic cyclomatic -- instead of a bundled measurer.
    This script only (a) selects the in-scope PowerShell files (all repository PowerShell
    except generated mirrors, dependencies, build output and non-source test scaffolding)
    and (b) maps PSComplexity's output to the ratchet's JSON contract:

        [ { "file": "<repo-relative>", "unit": "<name|<script-body>>", "line": <int>,
            "cc": <int>, "cog": <int> }, ... ]

    As of PSComplexity 0.3.0 both metrics also score the branching PowerShell expresses
    through its own flow constructs -- ForEach-Object / Where-Object (and aliases), the
    && / || pipeline chains, and the ?? / ??= operators -- which earlier versions read as
    straight-line code. A pipeline body now costs exactly what the equivalent keyword form
    costs. The baselines under .ci/ are generated from this output.

.OUTPUTS
    JSON array to stdout.
#>
[CmdletBinding()]
param(
    # Optional: measure only this file/dir (no production filtering) -- for ad-hoc use.
    [string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Module PSComplexity -ListAvailable | Where-Object Version -ge '0.5.1')) {
    Install-Module PSComplexity -RequiredVersion 0.5.1 -Force -Scope CurrentUser
}
Import-Module PSComplexity

# All repository PowerShell is in scope. A path is measured unless it matches one of the
# exclusion patterns (generated mirror, deps, build output, git worktrees, or non-source
# test scaffolding). `.claude/` holds gitignored agent git worktrees whose full repo
# copies would otherwise be double-measured locally (they don't exist in CI), so exclude
# it to keep local and CI measurement in agreement. Pester files (*.Tests.ps1), crawler
# test harnesses (Test-*Crawler.ps1), data seeders (Seed-*) and the mock servers are
# test-support scaffolding, not measured source.
$excludeRx = '[\\/](node_modules|dist|dist-node-launcher|bundled-scripts|\.claude)[\\/]' +
             '|\.Tests\.ps1$|[\\/]Test-[^\\/]*Crawler\.ps1$|[\\/]Seed-|MockODataServer|MockMidpointServer'

if ($Path) {
    $files = @(Get-ChildItem -Path $Path -Recurse -Include *.ps1, *.psm1 -File)
}
else {
    $files = @(Get-ChildItem -Recurse -Include *.ps1, *.psm1 -File |
        Where-Object { $_.FullName -notmatch $excludeRx })
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
