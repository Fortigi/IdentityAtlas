<#
.SYNOPSIS
    Emit per-unit cyclomatic AND cognitive complexity for production PowerShell,
    as JSON, for the complexity ratchet (tools/complexity/ratchet.py).

.DESCRIPTION
    Parses every production .ps1/.psm1 with the PowerShell AST and reports, per UNIT
    (every function/filter body, plus a synthetic '<script-body>' unit per file for
    the top-level code), two numbers:

    * cc  — CYCLOMATIC complexity = 1 + decision points, where a decision point is
      each if/elseif clause, each switch clause, each foreach/for/while/do loop, each
      catch/trap, each ternary, and each -and/-or. Counts every branch equally.

    * cog — COGNITIVE complexity (SonarSource model): how hard the code is to *follow*,
      not just how many paths it has. Three rules:
        1. +1 for each break in linear flow (if, else, elseif, ternary, switch, loop,
           catch/trap).
        2. Structures that introduce nesting (if/ternary/switch/loop/catch, and each
           lambda scriptblock) add +1 for EACH enclosing nesting level — so a branch
           three levels deep costs 4, not 1.
        3. else / elseif get a flat +1 with NO nesting penalty (an else-if chain reads
           linearly, so it isn't punished like re-nesting would be); switch counts once
           for the whole statement, not per case; and a run of the same boolean
           operator counts once (a -and b -and c = +1; a -and b -or c = +2).
      A straight-line function is cog 0. Nesting is measured relative to the unit, so
      nested functions reset to 0 and are counted independently.

    Excludes generated mirrors (bundled-scripts), dependencies, build output, and
    non-production scripts (tests, CI test harnesses, mock servers, dev seeders).

.OUTPUTS
    JSON array to stdout: [ { "file": "<repo-relative>", "unit": "<name|<script-body>>",
    "line": <int>, "cc": <int>, "cog": <int> }, ... ]
#>
[CmdletBinding()]
param(
    # Optional: measure only this file or directory, with NO production include/exclude
    # filtering — used by tools/complexity's tests. Omitted, it scans the whole repo
    # (production roots only), exactly as the ratchet invokes it.
    [string]$Path
)

$ErrorActionPreference = 'Stop'

# AST node types that introduce a nesting level for the cognitive nesting penalty.
$script:NestingTypeNames = @(
    'IfStatementAst', 'ForEachStatementAst', 'ForStatementAst', 'WhileStatementAst',
    'DoWhileStatementAst', 'DoUntilStatementAst', 'SwitchStatementAst', 'CatchClauseAst',
    'TrapStatementAst', 'TernaryExpressionAst', 'ScriptBlockExpressionAst'
)

function Get-NearestFunction {
    param($Node)
    $p = $Node.Parent
    while ($p) {
        if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return $p }
        $p = $p.Parent
    }
    return $null
}

# Cognitive nesting depth of a node: count of enclosing nesting-introducing structures
# up to (but not through) the unit boundary (the nearest function). The node's own type
# is not counted for itself — only its ancestors.
function Get-CogNesting {
    param($Node)
    $depth = 0
    $p = $Node.Parent
    while ($p) {
        if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { break }
        if ($p.GetType().Name -in $script:NestingTypeNames) { $depth++ }
        $p = $p.Parent
    }
    return $depth
}

# Production roots only. A path is measured when it matches an include root AND none
# of the exclusion patterns (generated mirror, deps, build output, or non-prod scripts).
$includeRx = 'crawlers|powershell-sdk|riskscoring|[\\/]setup[\\/]'
$excludeRx = '[\\/](node_modules|dist|dist-node-launcher|bundled-scripts)[\\/]' +
             '|\.Tests\.ps1$|[\\/]Test-[^\\/]*Crawler\.ps1$|[\\/]Seed-|MockODataServer|MockMidpointServer'

$results = [System.Collections.Generic.List[object]]::new()

if ($Path) {
    # Test/ad-hoc mode: measure exactly what's under $Path, no production filtering.
    $repoRoot = (Resolve-Path $Path).Path
    $files = @(Get-ChildItem -Path $Path -Recurse -Include *.ps1, *.psm1 -File)
}
else {
    $repoRoot = (Resolve-Path '.').Path
    $files = Get-ChildItem -Recurse -Include *.ps1, *.psm1 -File |
        Where-Object { $_.FullName -match $includeRx -and $_.FullName -notmatch $excludeRx }
}

foreach ($f in $files) {
    $errs = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
    if ($errs) { continue }
    $rel = $f.FullName.Substring($repoRoot.Length).TrimStart('\', '/').Replace('\', '/')

    $cc   = @{}   # unitKey -> cyclomatic decision-point count
    $cog  = @{}   # unitKey -> cognitive point count
    $meta = @{}   # unitKey -> @{ name; line }
    $script:cc = $cc; $script:cog = $cog; $script:meta = $meta

    function Resolve-UnitKey {
        param($Node)
        $fn = Get-NearestFunction $Node
        if ($fn) {
            $k = $fn.Name + '@' + $fn.Extent.StartLineNumber
            if (-not $script:meta.ContainsKey($k)) { $script:meta[$k] = @{ name = $fn.Name; line = $fn.Extent.StartLineNumber } }
        }
        else {
            $k = '<script-body>'
            if (-not $script:meta.ContainsKey($k)) { $script:meta[$k] = @{ name = '<script-body>'; line = 1 } }
        }
        if (-not $script:cc.ContainsKey($k)) { $script:cc[$k] = 0; $script:cog[$k] = 0 }
        return $k
    }
    function Add-Cc  { param($Node, [int]$Amount) $k = Resolve-UnitKey $Node; $script:cc[$k]  += $Amount }
    function Add-Cog { param($Node, [int]$Amount) $k = Resolve-UnitKey $Node; $script:cog[$k] += $Amount }

    # ── Cyclomatic (unchanged: every branch counts equally) ──────────────────────
    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.IfStatementAst] }, $true)) { Add-Cc $n $n.Clauses.Count }
    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.SwitchStatementAst] }, $true)) { Add-Cc $n $n.Clauses.Count }
    foreach ($tn in 'ForEachStatementAst', 'ForStatementAst', 'WhileStatementAst', 'DoWhileStatementAst', 'DoUntilStatementAst', 'CatchClauseAst', 'TrapStatementAst', 'TernaryExpressionAst') {
        foreach ($n in $ast.FindAll({ param($x) $x.GetType().Name -eq $tn }.GetNewClosure(), $true)) { Add-Cc $n 1 }
    }
    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.BinaryExpressionAst] }, $true)) {
        if ($n.Operator -in 'And', 'Or') { Add-Cc $n 1 }
    }

    # ── Cognitive (nesting-weighted; else-if flat; switch once; boolean runs) ─────
    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.IfStatementAst] }, $true)) {
        # First clause = the `if`: +1 + nesting. Each extra clause = an `elseif`: flat +1.
        Add-Cog $n (1 + (Get-CogNesting $n))
        if ($n.Clauses.Count -gt 1) { Add-Cog $n ($n.Clauses.Count - 1) }
        if ($n.ElseClause) { Add-Cog $n 1 }   # else: flat +1
    }
    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.SwitchStatementAst] }, $true)) {
        Add-Cog $n (1 + (Get-CogNesting $n))   # once for the whole switch
    }
    foreach ($tn in 'ForEachStatementAst', 'ForStatementAst', 'WhileStatementAst', 'DoWhileStatementAst', 'DoUntilStatementAst', 'CatchClauseAst', 'TrapStatementAst', 'TernaryExpressionAst') {
        foreach ($n in $ast.FindAll({ param($x) $x.GetType().Name -eq $tn }.GetNewClosure(), $true)) { Add-Cog $n (1 + (Get-CogNesting $n)) }
    }
    # Boolean operators: +1 per maximal run of the SAME operator (count only the run's top node).
    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.BinaryExpressionAst] }, $true)) {
        if ($n.Operator -in 'And', 'Or') {
            $parent = $n.Parent
            $sameRun = ($parent -is [System.Management.Automation.Language.BinaryExpressionAst]) -and ($parent.Operator -eq $n.Operator)
            if (-not $sameRun) { Add-Cog $n 1 }
        }
    }

    # Register every function (incl. nested), so a straight-line cc=1/cog=0 function is
    # still reported — decision-point loops above only create a key when a branch exists.
    foreach ($fn in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
        $k = $fn.Name + '@' + $fn.Extent.StartLineNumber
        if (-not $meta.ContainsKey($k)) { $meta[$k] = @{ name = $fn.Name; line = $fn.Extent.StartLineNumber }; $cc[$k] = 0; $cog[$k] = 0 }
    }

    # Always emit the script body, even at cc 1 / cog 0 (a thin entry point should be visible).
    if (-not $meta.ContainsKey('<script-body>')) { $meta['<script-body>'] = @{ name = '<script-body>'; line = 1 }; $cc['<script-body>'] = 0; $cog['<script-body>'] = 0 }

    foreach ($k in $cc.Keys) {
        $results.Add([pscustomobject]@{ file = $rel; unit = $meta[$k].name; line = $meta[$k].line; cc = ($cc[$k] + 1); cog = $cog[$k] })
    }
}

$results | ConvertTo-Json -Depth 4 -Compress
