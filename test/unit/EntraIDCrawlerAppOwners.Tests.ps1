#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the app-ownership lookup index
    (tools/crawlers/entra-id/EntraIDCrawler.AppOwners.ps1 :: Get-EntraAppOwnerIndex).

.DESCRIPTION
    Get-EntraAppOwnerIndex is pure — it turns the service-principal list into the
    appId->spId, spId->sp, and spId->displayName maps the owner phases key off of.
    The ConvertTo-EntraAppOwnershipGraph shaper is covered in
    EntraIDCrawlerTransform.Tests.ps1.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.AppOwners.ps1')
}

Describe 'Get-EntraAppOwnerIndex' {

    It 'maps appId->spId, spId->sp, and spId->displayName' {
        $sps = @(
            [pscustomobject]@{ id = 'sp1'; appId = 'app-1'; displayName = 'Payroll App' },
            [pscustomobject]@{ id = 'sp2'; appId = 'app-2'; displayName = 'Reporting API' }
        )
        $idx = Get-EntraAppOwnerIndex -Sps $sps

        $idx.appIdToSpId['app-1']      | Should -Be 'sp1'
        $idx.appIdToSpId['app-2']      | Should -Be 'sp2'
        $idx.appNameById['sp1']        | Should -Be 'Payroll App'
        $idx.spById['sp2'].displayName | Should -Be 'Reporting API'
    }

    It 'omits the appId->spId entry for an SP with no appId (e.g. a managed identity)' {
        $sps = @(
            [pscustomobject]@{ id = 'sp1'; appId = 'app-1'; displayName = 'Has AppId' },
            [pscustomobject]@{ id = 'mi1'; displayName = 'Managed Identity' }   # no appId
        )
        $idx = Get-EntraAppOwnerIndex -Sps $sps

        $idx.appIdToSpId.Count           | Should -Be 1
        $idx.appIdToSpId.ContainsKey('') | Should -BeFalse
        # still indexed by spId even without an appId
        $idx.spById['mi1'].displayName   | Should -Be 'Managed Identity'
        $idx.appNameById['mi1']          | Should -Be 'Managed Identity'
    }

    It 'returns empty maps for no service principals' {
        $idx = Get-EntraAppOwnerIndex -Sps @()
        $idx.appIdToSpId.Count | Should -Be 0
        $idx.spById.Count      | Should -Be 0
        $idx.appNameById.Count | Should -Be 0
    }
}
