<#
.SYNOPSIS
    Emit per-unit cyclomatic complexity for production PowerShell, as JSON, for the
    complexity ratchet (tools/complexity/ratchet.py).

.DESCRIPTION
    Parses every production .ps1/.psm1 with the PowerShell AST and reports the
    cyclomatic complexity of each UNIT: every function/filter body, plus a synthetic
    '<script-body>' unit per file for the top-level code (the part that is NOT inside
    any function — this is what makes a monolithic Start-*Crawler.ps1 body visible as
    one high-CC unit instead of hiding between its helpers).

    Cyclomatic complexity = 1 + decision points, where a decision point is: each
    if/elseif clause, each switch clause, each foreach/for/while/do loop, each
    catch/trap, each ternary, and each -and/-or in a boolean expression. Each
    decision point is attributed to its NEAREST enclosing function (or the script
    body), so nested functions are counted independently.

    Excludes generated mirrors (bundled-scripts), dependencies, build output, and
    non-production scripts (tests, CI test harnesses, mock servers, dev seeders) —
    the ratchet gates production code only.

.OUTPUTS
    JSON array to stdout: [ { "file": "<repo-relative, forward-slash>", "unit":
    "<name|<script-body>>", "line": <int>, "cc": <int> }, ... ]
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-NearestFunction {
    param($Node)
    $p = $Node.Parent
    while ($p) {
        if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return $p }
        $p = $p.Parent
    }
    return $null
}

# Production roots only. A path is measured when it matches an include root AND none
# of the exclusion patterns (generated mirror, deps, build output, or non-prod scripts).
$includeRx = 'crawlers|powershell-sdk|riskscoring|[\\/]setup[\\/]'
$excludeRx = '[\\/](node_modules|dist|dist-node-launcher|bundled-scripts)[\\/]' +
             '|\.Tests\.ps1$|[\\/]Test-[^\\/]*Crawler\.ps1$|[\\/]Seed-|MockODataServer|MockMidpointServer'

$repoRoot = (Resolve-Path '.').Path
$results  = [System.Collections.Generic.List[object]]::new()

$files = Get-ChildItem -Recurse -Include *.ps1, *.psm1 -File |
    Where-Object { $_.FullName -match $includeRx -and $_.FullName -notmatch $excludeRx }

foreach ($f in $files) {
    $errs = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
    if ($errs) { continue }
    $rel = $f.FullName.Substring($repoRoot.Length).TrimStart('\', '/').Replace('\', '/')

    $dp   = @{}   # unitKey -> decision-point count
    $meta = @{}   # unitKey -> @{ name; line }
    $script:dp = $dp; $script:meta = $meta

    function Add-Dp {
        param($Node, [int]$Amount)
        $fn = Get-NearestFunction $Node
        if ($fn) {
            $k = $fn.Name + '@' + $fn.Extent.StartLineNumber
            if (-not $script:meta.ContainsKey($k)) { $script:meta[$k] = @{ name = $fn.Name; line = $fn.Extent.StartLineNumber } }
        }
        else {
            $k = '<script-body>'
            if (-not $script:meta.ContainsKey($k)) { $script:meta[$k] = @{ name = '<script-body>'; line = 1 } }
        }
        if (-not $script:dp.ContainsKey($k)) { $script:dp[$k] = 0 }
        $script:dp[$k] += $Amount
    }

    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.IfStatementAst] }, $true)) { Add-Dp $n $n.Clauses.Count }
    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.SwitchStatementAst] }, $true)) { Add-Dp $n $n.Clauses.Count }
    foreach ($tn in 'ForEachStatementAst', 'ForStatementAst', 'WhileStatementAst', 'DoWhileStatementAst', 'DoUntilStatementAst', 'CatchClauseAst', 'TrapStatementAst', 'TernaryExpressionAst') {
        foreach ($n in $ast.FindAll({ param($x) $x.GetType().Name -eq $tn }.GetNewClosure(), $true)) { Add-Dp $n 1 }
    }
    foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.BinaryExpressionAst] }, $true)) {
        if ($n.Operator -in 'And', 'Or') { Add-Dp $n 1 }
    }

    # Always emit the script body, even at CC 1 (a thin entry point should be visible).
    if (-not $meta.ContainsKey('<script-body>')) { $meta['<script-body>'] = @{ name = '<script-body>'; line = 1 }; $dp['<script-body>'] = 0 }

    foreach ($k in $dp.Keys) {
        $results.Add([pscustomobject]@{ file = $rel; unit = $meta[$k].name; line = $meta[$k].line; cc = ($dp[$k] + 1) })
    }
}

$results | ConvertTo-Json -Depth 4 -Compress
