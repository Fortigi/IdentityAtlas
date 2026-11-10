#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    tools/psscriptanalyzer/PSAnalyzerRatchet.ps1: what the PSScriptAnalyzer gate
    scans, and the baseline that lets it switch on the two dead-code rules.

.DESCRIPTION
    Review item A14: PSUseDeclaredVarsMoreThanAssignments and
    PSReviewUnusedParameter were excluded as "too noisy", so dead variables and
    parameters in crawlers accumulated with nothing to stop them. They are on
    now, with their 58 existing hits baselined; these tests pin that a new hit
    fails, a fixed one has to leave the baseline, and the baseline only shrinks.
    Findings are plain objects shaped like Invoke-ScriptAnalyzer's, so no case
    needs the analyzer installed.

.USAGE
    Invoke-Pester -Path test/unit/PSAnalyzerRatchet.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:RepoRoot 'tools' 'psscriptanalyzer' 'PSAnalyzerRatchet.ps1')

    $script:Root = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'psa-root'))
    function New-Finding([string] $Rel, [string] $Rule, [string] $Id, [int] $Line = 1) {
        [pscustomobject] @{
            ScriptPath        = Join-Path $script:Root $Rel
            RuleName          = $Rule
            RuleSuppressionID = $Id
            Line              = $Line
        }
    }
}

Describe 'what the gate scans' {
    It 'runs both dead-code rules: neither is excluded' {
        Get-PSAnalyzerExcludedRule | Should -Not -Contain 'PSUseDeclaredVarsMoreThanAssignments'
        Get-PSAnalyzerExcludedRule | Should -Not -Contain 'PSReviewUnusedParameter'
    }

    It 'still excludes the rules the codebase opts out of on purpose' {
        Get-PSAnalyzerExcludedRule | Should -Contain 'PSAvoidUsingWriteHost'
        @(Get-PSAnalyzerExcludedRule).Count | Should -Be 8
    }

    It 'scans the crawlers, the worker and each SDK folder, as absolute paths' {
        $paths = Get-PSAnalyzerPath -Root $script:RepoRoot
        $paths | Should -Contain (Join-Path $script:RepoRoot 'tools/crawlers')
        $paths | Should -Contain (Join-Path $script:RepoRoot 'setup/docker')
        $paths | Should -Contain (Join-Path $script:RepoRoot 'tools/powershell-sdk' 'helpers')
        $paths | ForEach-Object { [IO.Path]::IsPathRooted($_) | Should -BeTrue }
    }

    It 'lists the fixed roots even where the SDK folder is missing' {
        $paths = @(Get-PSAnalyzerPath -Root (Join-Path $TestDrive 'empty'))
        $paths.Count | Should -Be 5
        $paths[0] | Should -Be (Join-Path $TestDrive 'empty' 'tools/riskscoring')
    }

    It 'is what pr.yml runs, and the workflow no longer lists rules of its own' {
        $yml = Get-Content (Join-Path $script:RepoRoot '.github/workflows/pr.yml') -Raw
        $yml | Should -Match 'pwsh tools/psscriptanalyzer/Invoke-PSAnalyzerGate\.ps1'
        $yml | Should -Not -Match "'PSUseDeclaredVarsMoreThanAssignments'"
    }
}

Describe 'Get-PSAnalyzerKey / Get-PSAnalyzerCount' {
    It 'keys a finding on repo-relative path, rule and name, with forward slashes' {
        $f = New-Finding 'tools\crawlers\csv\Start-CSVCrawler.ps1' 'PSReviewUnusedParameter' 'JobId' 45
        Get-PSAnalyzerKey -Finding $f -Root $script:Root |
            Should -Be 'tools/crawlers/csv/Start-CSVCrawler.ps1|PSReviewUnusedParameter|JobId'
    }

    It 'ignores the line, so an edit above a finding does not make it new' {
        $a = New-Finding 'x.ps1' 'R' 'Id' 10
        $b = New-Finding 'x.ps1' 'R' 'Id' 99
        Get-PSAnalyzerKey -Finding $a -Root $script:Root | Should -Be (Get-PSAnalyzerKey -Finding $b -Root $script:Root)
    }

    It 'counts repeats of a key and keeps different names apart' {
        $counts = Get-PSAnalyzerCount -Root $script:Root -Findings @(
            (New-Finding 'a.ps1' 'R' 'Connection' 1)
            (New-Finding 'a.ps1' 'R' 'Connection' 2)
            (New-Finding 'a.ps1' 'R' 'Paged' 3)
        )
        $counts.Count | Should -Be 2
        $counts['a.ps1|R|Connection'] | Should -Be 2
        $counts['a.ps1|R|Paged'] | Should -Be 1
    }

    It 'counts nothing for a clean run' {
        (Get-PSAnalyzerCount -Root $script:Root).Count | Should -Be 0
    }
}

Describe 'the baseline file' {
    It 'round-trips through the committed JSON shape' {
        $counts = @{ 'b.ps1|R|Y' = 1; 'a.ps1|R|X' = 2; 'a.ps1|S|X' = 1 }
        $json = ConvertTo-PSAnalyzerBaseline -Counts $counts
        $back = ConvertFrom-PSAnalyzerBaseline -Json $json
        $back.Count | Should -Be 3
        $back['a.ps1|R|X'] | Should -Be 2
        $back['a.ps1|S|X'] | Should -Be 1
    }

    It 'writes files in sorted order, nested by rule then name' {
        $json = ConvertTo-PSAnalyzerBaseline -Counts @{ 'b.ps1|R|Y' = 1; 'a.ps1|R|X' = 2 }
        $doc = $json | ConvertFrom-Json -AsHashtable
        @($doc.files.Keys) | Should -Be @('a.ps1', 'b.ps1')
        $doc.files['a.ps1']['R']['X'] | Should -Be 2
        $json.IndexOf('"a.ps1"') | Should -BeLessThan $json.IndexOf('"b.ps1"')
        $doc._comment | Should -Match 'Invoke-PSAnalyzerGate\.ps1 -Update'
    }

    It 'writes LF line ends on every OS' {
        $json = ConvertTo-PSAnalyzerBaseline -Counts @{ 'a.ps1|R|X' = 1 }
        $json | Should -Not -Match "`r"
        $json | Should -Match "`n"
    }

    It 'reads an empty file as an empty baseline' {
        (ConvertFrom-PSAnalyzerBaseline -Json "  `n").Count | Should -Be 0
    }

    It 'refuses a file without a files object rather than baselining nothing' {
        { ConvertFrom-PSAnalyzerBaseline -Json '{"other":{}}' } | Should -Throw '*no ''files'' object*'
    }

    It 'the committed baseline parses and holds only the two dead-code rules' {
        $path = Join-Path $script:RepoRoot '.ci/psscriptanalyzer-baseline.json'
        $counts = ConvertFrom-PSAnalyzerBaseline -Json (Get-Content $path -Raw)
        $counts.Count | Should -BeGreaterThan 0
        $rules = $counts.Keys | ForEach-Object { ($_ -split '\|')[1] } | Sort-Object -Unique
        $rules | Should -Be @('PSReviewUnusedParameter', 'PSUseDeclaredVarsMoreThanAssignments')
    }
}

Describe 'Compare-PSAnalyzerBaseline' {
    It 'reports a finding the baseline does not hold as new' {
        $cmp = Compare-PSAnalyzerBaseline -Current @{ 'a|R|X' = 1 } -Baseline @{}
        $cmp.New.Count | Should -Be 1
        $cmp.New[0].Key | Should -Be 'a|R|X'
        $cmp.New[0].Count | Should -Be 1
        $cmp.Fixed.Count | Should -Be 0
    }

    It 'reports only the excess when a baselined name appears once more' {
        $cmp = Compare-PSAnalyzerBaseline -Current @{ 'a|R|X' = 3 } -Baseline @{ 'a|R|X' = 2 }
        $cmp.New[0].Count | Should -Be 1
    }

    It 'passes a run that matches the baseline exactly' {
        $cmp = Compare-PSAnalyzerBaseline -Current @{ 'a|R|X' = 2; 'b|R|Y' = 1 } -Baseline @{ 'a|R|X' = 2; 'b|R|Y' = 1 }
        $cmp.New.Count | Should -Be 0
        $cmp.Fixed.Count | Should -Be 0
    }

    It 'reports a baselined slot no longer used as fixed, by how many' {
        $cmp = Compare-PSAnalyzerBaseline -Current @{ 'a|R|X' = 1 } -Baseline @{ 'a|R|X' = 3; 'b|R|Y' = 1 }
        $cmp.New.Count | Should -Be 0
        $cmp.Fixed.Count | Should -Be 2
        ($cmp.Fixed | Where-Object Key -EQ 'a|R|X').Count | Should -Be 2
        ($cmp.Fixed | Where-Object Key -EQ 'b|R|Y').Count | Should -Be 1
    }

    It 'does not let a fix in one file pay for a new finding in another' {
        $cmp = Compare-PSAnalyzerBaseline -Current @{ 'b|R|X' = 1 } -Baseline @{ 'a|R|X' = 1 }
        $cmp.New[0].Key | Should -Be 'b|R|X'
        $cmp.Fixed[0].Key | Should -Be 'a|R|X'
    }
}

Describe 'Merge-PSAnalyzerBaseline (-Update)' {
    It 'shrinks: a fixed finding leaves and a reduced count is recorded' {
        $m = Merge-PSAnalyzerBaseline -Current @{ 'a|R|X' = 1 } -Baseline @{ 'a|R|X' = 3; 'b|R|Y' = 1 }
        $m.Count | Should -Be 1
        $m['a|R|X'] | Should -Be 1
    }

    It 'does not grandfather a new finding or raise a count' {
        $m = Merge-PSAnalyzerBaseline -Current @{ 'a|R|X' = 4; 'c|R|Z' = 1 } -Baseline @{ 'a|R|X' = 2 }
        $m.Count | Should -Be 1
        $m['a|R|X'] | Should -Be 2
    }

    It 'with -AllowIncrease takes the current findings as they are' {
        $m = Merge-PSAnalyzerBaseline -Current @{ 'a|R|X' = 4; 'c|R|Z' = 1 } -Baseline @{ 'a|R|X' = 2; 'b|R|Y' = 1 } -AllowIncrease
        $m.Count | Should -Be 2
        $m['a|R|X'] | Should -Be 4
        $m['c|R|Z'] | Should -Be 1
    }
}

Describe 'Read-PSAnalyzerBaseline' {
    It 'reads a missing file as an empty baseline, so the first run can create it' {
        (Read-PSAnalyzerBaseline -Path (Join-Path $TestDrive 'none.json')).Count | Should -Be 0
    }

    It 'reads the counts from a file' {
        $p = Join-Path $TestDrive "$([guid]::NewGuid()).json"
        ConvertTo-PSAnalyzerBaseline -Counts @{ 'a.ps1|R|X' = 2 } | Set-Content $p
        (Read-PSAnalyzerBaseline -Path $p)['a.ps1|R|X'] | Should -Be 2
    }
}

Describe 'Get-PSAnalyzerVerdictLine' {
    BeforeAll {
        $script:Hits = @(
            (New-Finding 'tools/a.ps1' 'PSReviewUnusedParameter' 'JobId' 7) | Add-Member -PassThru Message 'unused JobId at 7'
            (New-Finding 'tools/a.ps1' 'PSReviewUnusedParameter' 'JobId' 30) | Add-Member -PassThru Message 'unused JobId at 30'
            (New-Finding 'tools/b.ps1' 'PSReviewUnusedParameter' 'Other' 3) | Add-Member -PassThru Message 'unused Other'
        )
    }

    It 'says nothing when the gate passes' {
        $cmp = [pscustomobject] @{ New = @(); Fixed = @() }
        @(Get-PSAnalyzerVerdictLine -Comparison $cmp -Findings $script:Hits -Root $script:Root).Count | Should -Be 0
    }

    It 'annotates every hit of a new key at its file and line, and no other key' {
        $cmp = [pscustomobject] @{ New = @([pscustomobject] @{ Key = 'tools/a.ps1|PSReviewUnusedParameter|JobId'; Count = 2 }); Fixed = @() }
        $lines = @(Get-PSAnalyzerVerdictLine -Comparison $cmp -Findings $script:Hits -Root $script:Root)
        $lines[0] | Should -Be '::error file=tools/a.ps1,line=7::PSReviewUnusedParameter - unused JobId at 7'
        $lines[1] | Should -Be '::error file=tools/a.ps1,line=30::PSReviewUnusedParameter - unused JobId at 30'
        $lines[2] | Should -Be '::error::PSScriptAnalyzer gate: 1 new finding key(s), 0 fixed key(s) still in the baseline'
        $lines.Count | Should -Be 3
    }

    It 'notes when some hits of a new key are baselined' {
        $cmp = [pscustomobject] @{ New = @([pscustomobject] @{ Key = 'tools/a.ps1|PSReviewUnusedParameter|JobId'; Count = 1 }); Fixed = @() }
        $lines = @(Get-PSAnalyzerVerdictLine -Comparison $cmp -Findings $script:Hits -Root $script:Root)
        $lines[2] | Should -Be "  (1 more 'JobId' in tools/a.ps1 than the 1 baselined; the analyzer cannot say which is new)"
    }

    It 'tells a fix to update the baseline, with the command' {
        $cmp = [pscustomobject] @{ New = @(); Fixed = @([pscustomobject] @{ Key = 'tools/c.ps1|R|Gone'; Count = 1 }) }
        $lines = @(Get-PSAnalyzerVerdictLine -Comparison $cmp -Findings @() -Root $script:Root)
        $lines[0] | Should -Be '::error::Fixed, so take it out of the baseline: tools/c.ps1|R|Gone (x1). Run: pwsh tools/psscriptanalyzer/Invoke-PSAnalyzerGate.ps1 -Update'
        $lines[1] | Should -Match '0 new finding key\(s\), 1 fixed key\(s\)'
    }
}
