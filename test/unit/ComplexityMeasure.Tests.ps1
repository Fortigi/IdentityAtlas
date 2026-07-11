#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }
<#
.SYNOPSIS
    Contract test for tools/complexity/measure_ps.ps1 -- the thin shim that delegates
    PowerShell complexity measurement to the published PSComplexity module and maps its
    output to the ratchet's { file, unit, line, cc, cog } JSON contract.

.DESCRIPTION
    PSComplexity's metric is reference-tested upstream; this only pins that our shim
    (a) selects/measures the given file, (b) emits the exact fields ratchet.py consumes,
    and (c) passes the numbers through. Runs measure_ps.ps1 in -Path mode against a small
    fixture; the shim installs PSComplexity on demand.
#>

BeforeAll {
    $repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:measurer = Join-Path $repoRoot 'tools' 'complexity' 'measure_ps.ps1'
    $script:fixture = Join-Path ([System.IO.Path]::GetTempPath()) "cxfix-$([System.Guid]::NewGuid().ToString('N')).ps1"
    @'
function Get-Fixture {
    param($x)
    if ($x -gt 0) { if ($x -gt 10) { return 'big' } }
    return 'small'
}
'@ | Set-Content $script:fixture
    $script:out = & pwsh -NoProfile -File $script:measurer -Path $script:fixture | ConvertFrom-Json
}

AfterAll { Remove-Item $script:fixture -ErrorAction SilentlyContinue }

Describe 'measure_ps.ps1 shim contract' {
    It 'emits the { file, unit, line, cc, cog } fields' {
        $rec = $script:out | Where-Object unit -eq 'Get-Fixture'
        $rec | Should -Not -BeNullOrEmpty
        $rec.PSObject.Properties.Name | Should -Contain 'cc'
        $rec.PSObject.Properties.Name | Should -Contain 'cog'
        $rec.PSObject.Properties.Name | Should -Contain 'line'
        $rec.file | Should -Match 'cxfix'
    }

    It 'passes cyclomatic and cognitive numbers through from PSComplexity' {
        $rec = $script:out | Where-Object unit -eq 'Get-Fixture'
        # two ifs -> cc = 1 + 2 = 3; a nested if -> cog = 1 (outer) + 2 (inner+nesting) = 3
        $rec.cc  | Should -Be 3
        $rec.cog | Should -Be 3
    }

    It 'reports the synthetic script-body unit' {
        ($script:out | Where-Object unit -eq '<script-body>') | Should -Not -BeNullOrEmpty
    }
}
