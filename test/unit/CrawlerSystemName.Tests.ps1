#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/shared/Get-CrawlerSystemName.ps1.

.DESCRIPTION
    The one rule every pull crawler uses to name the Identity Atlas System it
    registers for its own endpoint: explicit override ▸ crawler name ▸ type
    default, with a stored override that is an exact copy of the type default
    treated as not set (#1240). Pure function — no mocks, no I/O.

.USAGE
    Invoke-Pester -Path test/unit/CrawlerSystemName.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Get-CrawlerSystemName.ps1')
}

Describe 'Get-CrawlerSystemName' {
    It 'names the system after the crawler when no override is configured' {
        Get-CrawlerSystemName -TypeDefault 'SCIM' -ConfigName 'SAP CIS Test' | Should -Be 'SAP CIS Test'
    }

    It 'prefers an explicit override over the crawler name' {
        Get-CrawlerSystemName -TypeDefault 'SCIM' -ConfigName 'SAP CIS Test' -SystemName 'Payroll' |
            Should -Be 'Payroll'
    }

    It 'falls back to the type default when the run carries no crawler name' {
        Get-CrawlerSystemName -TypeDefault 'Entra ID (contoso.onmicrosoft.com)' |
            Should -Be 'Entra ID (contoso.onmicrosoft.com)'
    }

    It 'treats a whitespace-only crawler name as absent rather than naming the system blank' {
        Get-CrawlerSystemName -TypeDefault 'Omada (https://omada.example.com)' -ConfigName "  `t " |
            Should -Be 'Omada (https://omada.example.com)'
    }

    It 'trims the crawler name it returns' {
        Get-CrawlerSystemName -TypeDefault 'SCIM' -ConfigName '  SAP CIS Test  ' | Should -Be 'SAP CIS Test'
    }

    It 'trims the override it returns' {
        Get-CrawlerSystemName -TypeDefault 'SCIM' -SystemName '  Payroll  ' | Should -Be 'Payroll'
    }

    Context 'a stored override that is a copy of the type default' {
        # Configs saved before the crawler name was plumbed through baked the type
        # literal into their stored systemName. Honouring it would shadow the
        # crawler's name on every run, forever (#1240).
        It 'is treated as unset, so the crawler name wins' {
            Get-CrawlerSystemName -TypeDefault 'SCIM' -ConfigName 'SAP CIS Test' -SystemName 'SCIM' |
                Should -Be 'SAP CIS Test'
        }

        It 'is compared after trimming, so a padded copy is stale too' {
            Get-CrawlerSystemName -TypeDefault 'SCIM' -ConfigName 'SAP CIS Test' -SystemName '  SCIM  ' |
                Should -Be 'SAP CIS Test'
        }

        It 'still names the system when there is no crawler name to fall through to' {
            Get-CrawlerSystemName -TypeDefault 'SCIM' -SystemName 'SCIM' | Should -Be 'SCIM'
        }

        It 'only counts an EXACT match — an override that merely contains the default is kept' {
            Get-CrawlerSystemName -TypeDefault 'SCIM' -ConfigName 'SAP CIS Test' -SystemName 'SCIM Test' |
                Should -Be 'SCIM Test'
        }

        It "compares case-sensitively — a differently-cased name is somebody's own label" {
            Get-CrawlerSystemName -TypeDefault 'SCIM' -ConfigName 'SAP CIS Test' -SystemName 'Scim' |
                Should -Be 'Scim'
        }

        It 'applies to a parameterised default too, not just a bare literal' {
            Get-CrawlerSystemName -TypeDefault 'midPoint (mp.example.com)' -ConfigName 'HBR midPoint' `
                -SystemName 'midPoint (mp.example.com)' | Should -Be 'HBR midPoint'
        }
    }
}
