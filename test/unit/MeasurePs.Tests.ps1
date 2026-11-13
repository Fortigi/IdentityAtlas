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

Describe 'measure_ps.ps1 -SarifPath' {
    BeforeAll {
        $tmp = [System.IO.Path]::GetTempPath()
        $script:big = Join-Path $tmp "cxbig-$([System.Guid]::NewGuid().ToString('N')).ps1"
        $script:sarif = Join-Path $tmp "cxbig-$([System.Guid]::NewGuid().ToString('N')).sarif"
        # 17 ifs: cyclomatic 18 and cognitive 17, both over the committed ceilings of 15.
        $ifs = (0..16 | ForEach-Object { "    if (`$x -eq $_) { return $_ }" }) -join "`n"
        "function Get-Big {`n    param(`$x)`n$ifs`n}`nfunction Get-Small { 1 }" | Set-Content $script:big
        $script:raw = & pwsh -NoProfile -File $script:measurer -Path $script:big -SarifPath $script:sarif
        $script:log = Get-Content $script:sarif -Raw | ConvertFrom-Json
    }

    AfterAll { Remove-Item $script:big, $script:sarif -ErrorAction SilentlyContinue }

    It 'leaves stdout as nothing but the JSON the ratchet parses' {
        # The gate warns and prints the config it used; under pwsh -File that would
        # land in stdout ahead of the JSON and break ratchet.py's json.loads.
        { ($script:raw -join "`n") | ConvertFrom-Json } | Should -Not -Throw
        (($script:raw -join "`n") | ConvertFrom-Json).unit | Should -Contain 'Get-Big'
    }

    It 'reports the unit over both ceilings once per metric' {
        $results = @($script:log.runs[0].results | Where-Object { $_.message.text -like 'Get-Big *' })
        $results.ruleId | Sort-Object | Should -Be @('PSCxCognitive', 'PSCxCyclomatic')
    }

    It 'applies the ceilings in .pscomplexity.json' {
        ($script:log.runs[0].results | Where-Object ruleId -eq 'PSCxCyclomatic').message.text | Should -Match 'ceiling of 15'
    }

    It 'reports nothing for a unit under the ceilings' {
        $script:log.runs[0].results | Where-Object { $_.message.text -like 'Get-Small *' } | Should -BeNullOrEmpty
    }
}
