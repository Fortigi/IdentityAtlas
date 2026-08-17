#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Unit tests for the tools/riskscoring PowerShell functions.

.DESCRIPTION
    The risk scoring + account correlation feature was disabled during the
    postgres migration. All 17 functions under tools/riskscoring/ are currently
    v5 placeholder stubs: each is a parameterless function that emits a single
    "not yet implemented in v5 (postgres)" warning and returns no output.

    These tests pin that contract — every stub loads, takes no parameters, emits
    its warning, and produces no pipeline output — so coverage of the directory
    is exercised and any future real implementation that changes the public
    shape will be caught.

.USAGE
    Invoke-Pester -Path test/unit/RiskScoring.Tests.ps1 -Output Detailed
#>

BeforeDiscovery {
    $script:repoRoot     = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:riskScoreDir = Join-Path $script:repoRoot 'tools' 'riskscoring'

    # The full set of stub function names, derived from the file names so the
    # data-driven cases stay in sync with the directory.
    $script:riskFnNames = Get-ChildItem -Path $script:riskScoreDir -Filter '*.ps1' |
        ForEach-Object { $_.BaseName }
}

BeforeAll {
    $script:repoRoot     = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:riskScoreDir = Join-Path $script:repoRoot 'tools' 'riskscoring'

    # Dot-source every stub into the current scope (these are not module exports).
    Get-ChildItem -Path $script:riskScoreDir -Filter '*.ps1' | ForEach-Object {
        . $_.FullName
    }
}

Describe 'tools/riskscoring stub functions' {

    Context 'directory shape' {
        It 'contains exactly 17 stub scripts' {
            (Get-ChildItem -Path $script:riskScoreDir -Filter '*.ps1').Count |
                Should -Be 17
        }
    }

    Context 'every stub: <_>' -ForEach $script:riskFnNames {

        BeforeAll {
            # $_ from -ForEach is exposed as the automatic var; capture it.
            $script:fnName = $_
            $script:cmd    = Get-Command $script:fnName -ErrorAction SilentlyContinue
        }

        It 'is defined as a function' {
            $script:cmd | Should -Not -BeNullOrEmpty
            $script:cmd.CommandType | Should -Be 'Function'
        }

        It 'declares no mandatory/custom parameters (parameterless stub)' {
            # CmdletBinding adds the common parameters; none of the stubs add
            # any of their own.
            $common = [System.Management.Automation.PSCmdlet]::CommonParameters +
                      [System.Management.Automation.PSCmdlet]::OptionalCommonParameters
            $own = $script:cmd.Parameters.Keys | Where-Object { $_ -notin $common }
            $own | Should -BeNullOrEmpty
        }

        It 'emits a single "not yet implemented" warning naming itself' {
            $warnings = & $script:fnName 3>&1
            $text = ($warnings | Out-String)
            $text | Should -Match 'not yet implemented in v5'
            $text | Should -Match ([regex]::Escape($script:fnName))
        }

        It 'returns no pipeline output' {
            # Swallow the warning stream; only the success stream is captured.
            $out = & $script:fnName 3>$null
            $out | Should -BeNullOrEmpty
        }

        It 'does not throw' {
            { & $script:fnName -WarningAction SilentlyContinue } | Should -Not -Throw
        }
    }
}

Describe 'tools/riskscoring representative functions' {

    # A couple of explicit, named cases so failures read clearly per "family":
    # builders, JSON-ish persisters, and the HTTP/LLM entrypoints. They all
    # share the stub contract today.

    Context 'builder stubs' {
        It 'New-FGRiskProfile warns and returns nothing' {
            $out = New-FGRiskProfile -WarningVariable w -WarningAction SilentlyContinue
            $out | Should -BeNullOrEmpty
            ($w | Out-String) | Should -Match 'Risk scoring is currently disabled'
        }

        It 'New-FGRiskClassifiers warns and returns nothing' {
            $out = New-FGRiskClassifiers -WarningVariable w -WarningAction SilentlyContinue
            $out | Should -BeNullOrEmpty
            ($w | Out-String) | Should -Match 'Risk scoring is currently disabled'
        }

        It 'New-FGCorrelationRuleset warns and returns nothing' {
            $out = New-FGCorrelationRuleset -WarningVariable w -WarningAction SilentlyContinue
            $out | Should -BeNullOrEmpty
            ($w | Out-String) | Should -Match 'Risk scoring is currently disabled'
        }
    }

    Context 'persistence stubs' {
        It 'Save-FGRiskProfile warns and returns nothing' {
            Save-FGRiskProfile -WarningVariable w -WarningAction SilentlyContinue | Should -BeNullOrEmpty
            ($w | Out-String) | Should -Match 'not yet implemented'
        }

        It 'Save-FGResourceClusters warns and returns nothing' {
            Save-FGResourceClusters -WarningVariable w -WarningAction SilentlyContinue | Should -BeNullOrEmpty
            ($w | Out-String) | Should -Match 'not yet implemented'
        }

        It 'Export-FGRiskProfile / Import-FGRiskProfile round-trip both warn' {
            Export-FGRiskProfile -WarningVariable we -WarningAction SilentlyContinue | Should -BeNullOrEmpty
            Import-FGRiskProfile -WarningVariable wi -WarningAction SilentlyContinue | Should -BeNullOrEmpty
            ($we | Out-String) | Should -Match 'Export-FGRiskProfile'
            ($wi | Out-String) | Should -Match 'Import-FGRiskProfile'
        }
    }

    Context 'HTTP / LLM entrypoint stubs' {
        It 'Invoke-FGLLMRequest is a no-op stub that makes no HTTP call' {
            # If a real implementation ever lands, this guards that the stub
            # version never reached out over the network.
            Mock Invoke-RestMethod { throw 'unexpected HTTP call' }
            $out = Invoke-FGLLMRequest -WarningVariable w -WarningAction SilentlyContinue
            $out | Should -BeNullOrEmpty
            ($w | Out-String) | Should -Match 'not yet implemented'
            Should -Invoke Invoke-RestMethod -Exactly 0
        }

        It 'Invoke-FGRiskScoring is a no-op stub that makes no HTTP call' {
            Mock Invoke-RestMethod { throw 'unexpected HTTP call' }
            Invoke-FGRiskScoring -WarningVariable w -WarningAction SilentlyContinue | Should -BeNullOrEmpty
            ($w | Out-String) | Should -Match 'not yet implemented'
            Should -Invoke Invoke-RestMethod -Exactly 0
        }

        It 'Invoke-FGAccountCorrelation is a no-op stub that makes no HTTP call' {
            Mock Invoke-RestMethod { throw 'unexpected HTTP call' }
            Invoke-FGAccountCorrelation -WarningVariable w -WarningAction SilentlyContinue | Should -BeNullOrEmpty
            ($w | Out-String) | Should -Match 'not yet implemented'
            Should -Invoke Invoke-RestMethod -Exactly 0
        }
    }
}
