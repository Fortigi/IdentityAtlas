#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester tests for the PowerShell complexity measurer (tools/complexity/measure_ps.ps1),
    which emits per-unit cyclomatic (cc) + cognitive (cog) complexity for the ratchet.

.DESCRIPTION
    The measurer is run with -Path pointed at a throwaway fixture .ps1, and its JSON
    output is asserted. The cognitive cases mirror the Python ones in
    tools/complexity/test_ratchet.py so both measurers stay in agreement.
#>

BeforeAll {
    $script:measure = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'tools' 'complexity' 'measure_ps.ps1'

    # Write $Code to a fixture file, measure it, return @{ unitName -> @{cc;cog} }.
    function Get-FixtureMetrics {
        param([string]$Code, [string]$Name = 'fixture')
        $file = Join-Path $TestDrive "$Name.ps1"
        Set-Content -Path $file -Value $Code -Encoding utf8
        $raw = & $script:measure -Path $file | Out-String
        $units = @{}
        foreach ($u in @($raw | ConvertFrom-Json)) { $units[$u.unit] = $u }
        return $units
    }
}

Describe 'measure_ps.ps1' {

    It 'reports cc=1, cog=0 for a straight-line function and always emits the script body' {
        $m = Get-FixtureMetrics "function Test-F {`n    Write-Host 'hi'`n}"
        $m['Test-F'].cc  | Should -Be 1
        $m['Test-F'].cog | Should -Be 0
        $m.ContainsKey('<script-body>') | Should -BeTrue   # thin entry point stays visible
    }

    It 'counts an if/elseif/else: cyclomatic by clause, cognitive flat' {
        $m = Get-FixtureMetrics "function Test-F {`n    if (`$a) { } elseif (`$b) { } else { }`n}"
        $m['Test-F'].cc  | Should -Be 3   # 1 + (if + elseif) clauses
        $m['Test-F'].cog | Should -Be 3   # if(1) + elseif(1) + else(1), no nesting penalty
    }

    It 'weights cognitive by nesting depth (which cyclomatic ignores)' {
        $flat   = Get-FixtureMetrics "function F {`n    if (`$a){}`n    if (`$b){}`n    if (`$c){}`n}" 'flat'
        $nested = Get-FixtureMetrics "function F {`n    if (`$a){ if (`$b){ if (`$c){} } }`n}" 'nested'
        $flat['F'].cc  | Should -Be $nested['F'].cc   # both 4 (three ifs)
        $flat['F'].cog | Should -Be 3                 # 1+1+1
        $nested['F'].cog | Should -Be 6               # 1 + 2 + 3
    }

    It 'counts boolean runs once per operator sequence' {
        (Get-FixtureMetrics "function F {`n    `$x = `$a -and `$b -and `$c`n}" 'r1')['F'].cog | Should -Be 1
        (Get-FixtureMetrics "function F {`n    `$x = `$a -and `$b -or `$c`n}" 'r2')['F'].cog | Should -Be 2
    }

    It 'counts a switch once for cognitive but per-clause for cyclomatic' {
        $code = "function F {`n    switch (`$x) { 1 {'a'} 2 {'b'} 3 {'c'} default {'d'} }`n}"
        $m = Get-FixtureMetrics $code 'sw'
        $m['F'].cog | Should -Be 1                 # whole switch = +1
        $m['F'].cc  | Should -BeGreaterThan $m['F'].cog   # cyclomatic counts each case
    }

    It 'matches the cross-language worked example (cc=9, cog=11)' {
        $code = @'
function Test-Cog {
    if ($a) {
        if ($b) {
            foreach ($x in $y) { Write-Host $x }
        } elseif ($c) {
        } else {
        }
    }
    $z = $p -and $q -and $r
    $w = $p -and $q -or $r
}
'@
        $m = Get-FixtureMetrics $code 'worked'
        $m['Test-Cog'].cc  | Should -Be 9
        $m['Test-Cog'].cog | Should -Be 11
    }

    It 'attributes top-level control flow to the script body' {
        $m = Get-FixtureMetrics "if (`$a) { foreach (`$x in `$y) { `$x } }"
        $m['<script-body>'].cc  | Should -Be 3   # 1 + if + foreach
        $m['<script-body>'].cog | Should -Be 3   # if(1) + foreach(1+1 nesting)
    }

    It 'resets nesting for a nested function (its own unit)' {
        $code = "function Outer {`n    if (`$a){}`n    function Inner { if (`$b){ if (`$b){} } }`n}"
        $m = Get-FixtureMetrics $code 'nestfn'
        $m['Outer'].cog | Should -Be 1   # just its own if
        $m['Inner'].cog | Should -Be 3   # if(1) + nested if(2), nesting reset
    }
}
