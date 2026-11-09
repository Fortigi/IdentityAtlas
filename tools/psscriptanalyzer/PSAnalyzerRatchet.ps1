<#
.SYNOPSIS
    What the PSScriptAnalyzer gate scans, and the baseline ratchet behind it.
    Dot-sourced by Invoke-PSAnalyzerGate.ps1; unit-tested by
    test/unit/PSAnalyzerRatchet.Tests.ps1. No function here calls the analyzer.

.DESCRIPTION
    A finding is identified by file + rule + RuleSuppressionID (for the dead-code
    rules: the variable or parameter name), never by line, so the baseline
    survives edits elsewhere in the file. The baseline holds a COUNT per key: a
    file may keep the unused parameters it had, but not grow another.

    The baseline only ratchets down. A finding that is fixed must also leave the
    baseline (Merge-PSAnalyzerBaseline does that), otherwise the slot it held
    would quietly let a new one of the same name back in.
#>

# Production PowerShell roots, relative to the repository root. test/ is
# harness code; setup/CreatePSD.ps1 is a developer-only tool with local paths.
function Get-PSAnalyzerPath {
    param([Parameter(Mandatory)] [string] $Root)
    $sdk = Join-Path $Root 'tools' 'powershell-sdk'
    @(
        if (Test-Path $sdk) { Get-ChildItem $sdk -Directory | ForEach-Object FullName }
        'tools/riskscoring'
        'tools/crawlers'
        'tools/csv-templates/transforms'
        'setup/docker'
        'setup/IdentityAtlas.psm1'
    ) | ForEach-Object { if ([IO.Path]::IsPathRooted($_)) { $_ } else { Join-Path $Root $_ } }
}

# Rules that are off, each with the reason. PSUseDeclaredVarsMoreThanAssignments
# and PSReviewUnusedParameter are deliberately NOT here (review item A14): they
# are the two that find dead code, and their existing hits sit in the baseline.
function Get-PSAnalyzerExcludedRule {
    @(
        'PSAvoidUsingWriteHost'                        # Write-Host is the intentional logging mechanism
        'PSAvoidGlobalVars'                            # token caching uses globals across function calls
        'PSUseShouldProcessForStateChangingFunctions'  # internal library functions, not interactive cmdlets
        'PSUseBOMForUnicodeEncodedFile'                # Linux-first codebase; a BOM is unnecessary
        'PSUseSingularNouns'                           # internal naming convention; not module exports
        'PSAvoidDefaultValueSwitchParameter'           # crawler phase switches default to $true intentionally
        'PSUseProcessBlockForPipelineCommand'          # these functions are not designed for pipeline use
        'PSAvoidUsingEmptyCatchBlock'                  # empty catches are intentional for non-critical operations
    )
}

function Get-PSAnalyzerKey {
    param([Parameter(Mandatory)] $Finding, [Parameter(Mandatory)] [string] $Root)
    $rel = [IO.Path]::GetRelativePath($Root, $Finding.ScriptPath) -replace '\\', '/'
    '{0}|{1}|{2}' -f $rel, $Finding.RuleName, $Finding.RuleSuppressionID
}

# Findings -> @{ key = count }.
function Get-PSAnalyzerCount {
    param([object[]] $Findings = @(), [Parameter(Mandatory)] [string] $Root)
    $counts = @{}
    foreach ($f in $Findings) {
        $k = Get-PSAnalyzerKey -Finding $f -Root $Root
        $counts[$k] = 1 + [int] $counts[$k]
    }
    $counts
}

# The committed JSON ({ files: { path: { rule: { id: count } } } }) -> @{ key = count }.
function ConvertFrom-PSAnalyzerBaseline {
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Json)
    $counts = @{}
    if (-not $Json.Trim()) { return $counts }
    $doc = $Json | ConvertFrom-Json -AsHashtable
    if (-not $doc.ContainsKey('files')) { throw "PSScriptAnalyzer baseline has no 'files' object" }
    foreach ($path in $doc.files.Keys) {
        foreach ($rule in $doc.files[$path].Keys) {
            foreach ($id in $doc.files[$path][$rule].Keys) {
                $counts["$path|$rule|$id"] = [int] $doc.files[$path][$rule][$id]
            }
        }
    }
    $counts
}

# @{ key = count } -> the committed JSON, sorted so a diff shows only what changed,
# with LF line ends on every OS (ConvertTo-Json writes CRLF on Windows).
function ConvertTo-PSAnalyzerBaseline {
    param([Parameter(Mandatory)] [hashtable] $Counts)
    $files = [ordered] @{}
    foreach ($k in $Counts.Keys | Sort-Object) {
        $path, $rule, $id = $k -split '\|', 3
        if (-not $files.Contains($path)) { $files[$path] = [ordered] @{} }
        if (-not $files[$path].Contains($rule)) { $files[$path][$rule] = [ordered] @{} }
        $files[$path][$rule][$id] = $Counts[$k]
    }
    ([ordered] @{
        _comment = 'PSScriptAnalyzer ratchet baseline: findings that predate the gate, per file, rule and variable/parameter name. Only ever shrinks. Fix one, then run: pwsh tools/psscriptanalyzer/Invoke-PSAnalyzerGate.ps1 -Update. See tools/psscriptanalyzer/PSAnalyzerRatchet.ps1.'
        files    = $files
    } | ConvertTo-Json -Depth 5) -replace "`r`n", "`n"
}

# New = findings over their baselined count; Fixed = baselined slots no longer used.
function Compare-PSAnalyzerBaseline {
    param([Parameter(Mandatory)] [hashtable] $Current, [Parameter(Mandatory)] [hashtable] $Baseline)
    $new = foreach ($k in $Current.Keys | Sort-Object) {
        $over = $Current[$k] - [int] $Baseline[$k]
        if ($over -gt 0) { [pscustomobject] @{ Key = $k; Count = $over } }
    }
    $fixed = foreach ($k in $Baseline.Keys | Sort-Object) {
        $under = $Baseline[$k] - [int] $Current[$k]
        if ($under -gt 0) { [pscustomobject] @{ Key = $k; Count = $under } }
    }
    [pscustomobject] @{ New = @($new); Fixed = @($fixed) }
}

# The baseline -Update writes: each key at the lower of its baselined and current
# count, so fixes leave it and nothing new enters. -AllowIncrease takes the
# current counts as they are, for a reviewed decision to grandfather a finding.
function Merge-PSAnalyzerBaseline {
    param(
        [Parameter(Mandatory)] [hashtable] $Current,
        [Parameter(Mandatory)] [hashtable] $Baseline,
        [switch] $AllowIncrease
    )
    $merged = @{}
    foreach ($k in $Current.Keys) {
        $n = if ($AllowIncrease) { $Current[$k] } else { [Math]::Min($Current[$k], [int] $Baseline[$k]) }
        if ($n -gt 0) { $merged[$k] = $n }
    }
    $merged
}

# The baseline at $Path, or an empty one when the file does not exist yet.
function Read-PSAnalyzerBaseline {
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path $Path)) { return @{} }
    ConvertFrom-PSAnalyzerBaseline -Json (Get-Content $Path -Raw)
}

# One ::error per hit of a new key (all of them: the analyzer cannot say which
# hit is the new one), plus a note when some of those hits are baselined.
function Get-PSAnalyzerNewLine {
    param([Parameter(Mandatory)] $Entry, [object[]] $Findings = @(), [Parameter(Mandatory)] [string] $Root)
    $path, $rule, $id = $Entry.Key -split '\|', 3
    $hits = @($Findings | Where-Object { (Get-PSAnalyzerKey -Finding $_ -Root $Root) -eq $Entry.Key })
    foreach ($h in $hits) { "::error file=$path,line=$($h.Line)::$rule - $($h.Message)" }
    if ($hits.Count -gt $Entry.Count) {
        "  ($($Entry.Count) more '$id' in $path than the $($hits.Count - $Entry.Count) baselined; the analyzer cannot say which is new)"
    }
}

# The gate's annotations for a comparison. Nothing at all means it passes.
function Get-PSAnalyzerVerdictLine {
    param([Parameter(Mandatory)] $Comparison, [object[]] $Findings = @(), [Parameter(Mandatory)] [string] $Root)
    foreach ($n in $Comparison.New) { Get-PSAnalyzerNewLine -Entry $n -Findings $Findings -Root $Root }
    foreach ($f in $Comparison.Fixed) {
        "::error::Fixed, so take it out of the baseline: $($f.Key) (x$($f.Count)). Run: pwsh tools/psscriptanalyzer/Invoke-PSAnalyzerGate.ps1 -Update"
    }
    if ($Comparison.New.Count -or $Comparison.Fixed.Count) {
        "::error::PSScriptAnalyzer gate: $($Comparison.New.Count) new finding key(s), $($Comparison.Fixed.Count) fixed key(s) still in the baseline"
    }
}
