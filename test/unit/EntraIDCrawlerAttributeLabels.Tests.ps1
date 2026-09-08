#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the directory-extension display-name map
    (tools/crawlers/entra-id/EntraIDCrawler.AttributeLabels.ps1).

.DESCRIPTION
    Get-FGAttributeDisplayName / New-FGAttributeDisplayNameMap /
    Get-FGEntraLabelCandidateKeys are pure — they turn the configured custom
    attribute names into the rawKey -> friendly-name map the crawler stamps on
    the System. Sync-EntraAttributeDisplayNames is covered by mocking its one
    boundary (Invoke-IngestAPI) AND asserting the body it actually built, since a
    call-count assertion alone would not notice a wrong or empty map.

    Key names come from the reporter's real tenant (issue #872) so the cases
    discriminate: `sfCostCenterID` would be mangled by a word-splitting label,
    `fgGroupDN_OuPath` by a naive "take everything after the last underscore".
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    # Pull in Invoke-IngestAPI so Mock has a command to intercept — Sync-EntraAttributeDisplayNames
    # calls it, and Pester can only mock a command that already exists in scope.
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:entraDir 'EntraIDCrawler.AttributeLabels.ps1')

    $script:AppA = '8ce8d3db3b314def88d829e15494e83f'
    $script:AppB = '1f2e3d4c5b6a79880011223344556677'
}

Describe 'Get-FGAttributeDisplayName' {

    It 'returns the attribute name after the extension_<appId>_ prefix' {
        Get-FGAttributeDisplayName -Key "extension_${script:AppA}_sAMAccountName" | Should -Be 'sAMAccountName'
    }

    It 'keeps camelCase verbatim rather than word-splitting it' {
        Get-FGAttributeDisplayName -Key "extension_${script:AppA}_sfCostCenterID" | Should -Be 'sfCostCenterID'
    }

    It 'keeps the derived _OuPath tail' {
        Get-FGAttributeDisplayName -Key "extension_${script:AppA}_fgGroupDN_OuPath" | Should -Be 'fgGroupDN_OuPath'
    }

    It 'is case-insensitive about the appId hex' {
        Get-FGAttributeDisplayName -Key "extension_$($script:AppA.ToUpper())_sfTeamID" | Should -Be 'sfTeamID'
    }

    It 'returns $null for a plain attribute name' {
        Get-FGAttributeDisplayName -Key 'userType' | Should -BeNullOrEmpty
    }

    It 'returns $null when the middle segment is not hex' {
        Get-FGAttributeDisplayName -Key 'extension_nothexnothexnothexnothexnothe_foo' | Should -BeNullOrEmpty
    }

    It 'returns $null for a 31-character middle segment' {
        Get-FGAttributeDisplayName -Key "extension_$($script:AppA.Substring(0,31))_foo" | Should -BeNullOrEmpty
    }

    It 'returns $null for a 33-character middle segment' {
        Get-FGAttributeDisplayName -Key "extension_${script:AppA}f_foo" | Should -BeNullOrEmpty
    }

    It 'returns $null when nothing follows the prefix' {
        Get-FGAttributeDisplayName -Key "extension_${script:AppA}_" | Should -BeNullOrEmpty
    }

    It 'returns $null for an empty key' {
        Get-FGAttributeDisplayName -Key '' | Should -BeNullOrEmpty
    }
}

Describe 'New-FGAttributeDisplayNameMap' {

    It 'maps only the extension-shaped keys' {
        $map = New-FGAttributeDisplayNameMap -Keys @(
            "extension_${script:AppA}_sfTeamID", 'userType', 'onPremisesSyncEnabled'
        )
        $map.Count | Should -Be 1
        $map["extension_${script:AppA}_sfTeamID"] | Should -Be 'sfTeamID'
    }

    It 'suffixes the appId when two apps define the same attribute name' {
        $keyA = "extension_${script:AppA}_employeeID"
        $keyB = "extension_${script:AppB}_employeeID"
        $map = New-FGAttributeDisplayNameMap -Keys @($keyA, $keyB)

        $map[$keyA] | Should -Be "employeeID ($($script:AppA.Substring(0,8)))"
        $map[$keyB] | Should -Be "employeeID ($($script:AppB.Substring(0,8)))"
        $map[$keyA] | Should -Not -Be $map[$keyB]
    }

    It 'leaves a non-colliding name unsuffixed even when other keys collide' {
        $solo = "extension_${script:AppA}_sfTeamID"
        $map = New-FGAttributeDisplayNameMap -Keys @(
            $solo, "extension_${script:AppA}_employeeID", "extension_${script:AppB}_employeeID"
        )
        $map[$solo] | Should -Be 'sfTeamID'
    }

    It 'keeps every storage key exactly as supplied' {
        $keys = @("extension_${script:AppA}_sfTeamID", "extension_${script:AppB}_sfTeamID")
        $map = New-FGAttributeDisplayNameMap -Keys $keys

        ($map.Keys | Sort-Object) -join '|' | Should -Be (($keys | Sort-Object) -join '|')
    }

    It 'does not double-count a key that appears twice' {
        $key = "extension_${script:AppA}_employeeID"
        $map = New-FGAttributeDisplayNameMap -Keys @($key, $key)

        # A duplicate is the same attribute, not a collision — no appId suffix.
        $map.Count | Should -Be 1
        $map[$key] | Should -Be 'employeeID'
    }

    It 'ignores empty and whitespace entries' {
        $map = New-FGAttributeDisplayNameMap -Keys @('', '   ', "extension_${script:AppA}_sfTeamID")
        $map.Count | Should -Be 1
    }

    It 'returns an empty map for no keys' {
        (New-FGAttributeDisplayNameMap -Keys @()).Count | Should -Be 0
    }
}

Describe 'Get-FGEntraLabelCandidateKeys' {

    It 'emits each configured attribute plus its _OuPath companion' {
        $keys = Get-FGEntraLabelCandidateKeys -CustomUserAttributes @('a') -CustomGroupAttributes @('b')
        $keys | Should -Contain 'a'
        $keys | Should -Contain 'a_OuPath'
        $keys | Should -Contain 'b'
        $keys | Should -Contain 'b_OuPath'
    }

    It 'covers the reporter\''s fgGroupDN_OuPath case end to end' {
        $dn  = "extension_${script:AppA}_fgGroupDN"
        $map = New-FGAttributeDisplayNameMap -Keys (Get-FGEntraLabelCandidateKeys -CustomGroupAttributes @($dn))

        $map[$dn]           | Should -Be 'fgGroupDN'
        $map["${dn}_OuPath"] | Should -Be 'fgGroupDN_OuPath'
    }

    It 'skips blank attribute names' {
        (Get-FGEntraLabelCandidateKeys -CustomUserAttributes @('', '  ')).Count | Should -Be 0
    }

    It 'returns nothing when no custom attributes are configured' {
        (Get-FGEntraLabelCandidateKeys).Count | Should -Be 0
    }
}

Describe 'Sync-EntraAttributeDisplayNames' {

    BeforeEach {
        $script:sent = $null
    }

    It 'posts a delta systems record carrying the map, keyed on systemType + tenantId' {
        Mock Invoke-IngestAPI { $script:sent = $Body; return @{ systemIds = @(1) } }

        $key = "extension_${script:AppA}_sfTeamID"
        Sync-EntraAttributeDisplayNames -TenantId 'tenant-1' -CustomUserAttributes @($key) | Out-Null

        Should -Invoke Invoke-IngestAPI -Times 1 -Exactly
        $script:sent.syncMode                                            | Should -Be 'delta'
        $script:sent.records[0].systemType                               | Should -Be 'EntraID'
        $script:sent.records[0].tenantId                                 | Should -Be 'tenant-1'
        $script:sent.records[0].extendedAttributes.attributeDisplayNames[$key] | Should -Be 'sfTeamID'
    }

    It 'sends nothing at all when no configured attribute is extension-shaped' {
        Mock Invoke-IngestAPI { $script:sent = $Body }

        $map = Sync-EntraAttributeDisplayNames -TenantId 'tenant-1' -CustomUserAttributes @('employeeId', 'costCentre')

        Should -Invoke Invoke-IngestAPI -Times 0 -Exactly
        $map.Count | Should -Be 0
    }

    It 'does not throw when the ingest call fails — labels are cosmetic' {
        Mock Invoke-IngestAPI { throw 'API unreachable' }

        { Sync-EntraAttributeDisplayNames -TenantId 'tenant-1' `
            -CustomUserAttributes @("extension_${script:AppA}_sfTeamID") } | Should -Not -Throw
    }
}
