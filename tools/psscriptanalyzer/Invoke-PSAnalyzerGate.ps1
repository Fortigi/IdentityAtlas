<#
.SYNOPSIS
    The 'Lint: PSScriptAnalyzer' gate (pr.yml): Warning and Error findings over
    the production PowerShell, failing on any finding the baseline does not hold.

.DESCRIPTION
    Every finding that predates a rule being switched on sits in
    .ci/psscriptanalyzer-baseline.json. The gate fails when a key (file + rule +
    variable/parameter name) has more findings than its baselined count, and
    also when it has FEWER: a fix has to take its slot out of the baseline too,
    with -Update, or a new finding of the same name would slip back in.

.PARAMETER Update
    Rewrite the baseline, shrinking only: fixed findings leave it, nothing enters.

.PARAMETER AllowIncrease
    With -Update: also record findings the baseline does not hold. Only for a
    reviewed decision that a finding is intended.

.EXAMPLE
    pwsh tools/psscriptanalyzer/Invoke-PSAnalyzerGate.ps1
    pwsh tools/psscriptanalyzer/Invoke-PSAnalyzerGate.ps1 -Update
#>
[CmdletBinding()]
param(
    [switch] $Update,
    [switch] $AllowIncrease
)
$ErrorActionPreference = 'Stop'

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $PSScriptRoot 'PSAnalyzerRatchet.ps1')
$baselinePath = Join-Path $root '.ci' 'psscriptanalyzer-baseline.json'

if ($AllowIncrease -and -not $Update) { throw '-AllowIncrease only means something with -Update' }

$exclude = Get-PSAnalyzerExcludedRule
$results = @(foreach ($p in Get-PSAnalyzerPath -Root $root) {
    if (Test-Path $p) {
        Invoke-ScriptAnalyzer -Path $p -Recurse -Severity Warning, Error -ExcludeRule $exclude
    }
})
$current = Get-PSAnalyzerCount -Findings $results -Root $root
$baseline = Read-PSAnalyzerBaseline -Path $baselinePath

if ($Update) {
    $merged = Merge-PSAnalyzerBaseline -Current $current -Baseline $baseline -AllowIncrease:$AllowIncrease
    (ConvertTo-PSAnalyzerBaseline -Counts $merged) + "`n" | Set-Content $baselinePath -NoNewline -Encoding utf8NoBOM
    Write-Host "Wrote $baselinePath : $(($merged.Values | Measure-Object -Sum).Sum) baselined finding(s)."
    (Compare-PSAnalyzerBaseline -Current $current -Baseline $merged).New |
        ForEach-Object { Write-Host "  NOT baselined: $($_.Key) (x$($_.Count)) - fix it, or re-run with -AllowIncrease" }
    exit 0
}

Write-Host "PSScriptAnalyzer: $($results.Count) finding(s), $(($baseline.Values | Measure-Object -Sum).Sum) baselined."
$lines = @(Get-PSAnalyzerVerdictLine -Comparison (Compare-PSAnalyzerBaseline -Current $current -Baseline $baseline) -Findings $results -Root $root)
$lines | ForEach-Object { Write-Host $_ }
if ($lines.Count) { exit 1 }
Write-Host 'PSScriptAnalyzer: no new findings' -ForegroundColor Green
