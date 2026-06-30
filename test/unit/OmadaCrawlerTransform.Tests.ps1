#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the pure record-shaping functions extracted into
    tools/crawlers/omada/OmadaCrawler.Transform.ps1.

.DESCRIPTION
    Covers the per-entity mapping logic moved verbatim out of
    Start-OmadaCrawler.ps1's Main body. These are pure (no HTTP, no script-scope
    writes), so they run against in-memory OData fixtures with no mocks.
    Get-OmadaRefValue / Get-OmadaRefUid come from Get-OmadaHelpers.ps1.

.USAGE
    Invoke-Pester -Path test/unit/OmadaCrawlerTransform.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:omadaRoot = Join-Path $script:repoRoot 'tools\crawlers\omada'

    # Omada reference helpers used by the transforms.
    . (Join-Path $script:omadaRoot 'Get-OmadaHelpers.ps1')
    # Map-ContextTypeToAtlas (reads $script:TypeMappings) — used by the Orgunit mapper.
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Functions.ps1')
    # The unit under test.
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Transform.ps1')

    # Context-type mapping the Orgunit mapper resolves through, mirroring the
    # Start script's Configuration-region defaults.
    $script:TypeMappings = @{
        contextTypeToIdentityAtlas = @{ 'OrgUnit' = 'OrgUnit'; 'Organisational Unit' = 'OrgUnit'; Department = 'Department' }
    }
}

Describe 'Get-OmadaIdentityType' {

    It 'returns the IDENTITYTYPE set-value label when present' {
        $id = [pscustomobject]@{ IDENTITYTYPE = [pscustomobject]@{ Value = 'Contractor' } }
        Get-OmadaIdentityType -Identity $id | Should -Be 'Contractor'
    }

    It 'defaults to Employee when IDENTITYTYPE is absent' {
        Get-OmadaIdentityType -Identity ([pscustomobject]@{ UId = 'x' }) | Should -Be 'Employee'
    }
}

Describe 'ConvertTo-OmadaIdentityRecord' {

    It 'maps core fields and builds displayName from first + last name' {
        $id = [pscustomobject]@{
            UId = '11111111-1111-1111-1111-111111111111'
            FIRSTNAME = 'Alice'; LASTNAME = 'Smith'; EMAIL = 'alice@contoso.com'
            EMPLOYEEID = 'E1'; JOBTITLE = 'Engineer'
            IDENTITYTYPE = [pscustomobject]@{ Value = 'Employee' }
        }
        $rec = ConvertTo-OmadaIdentityRecord -Identity $id
        $rec.id          | Should -Be '11111111-1111-1111-1111-111111111111'
        $rec.externalId  | Should -Be '11111111-1111-1111-1111-111111111111'
        $rec.displayName | Should -Be 'Alice Smith'
        $rec.givenName   | Should -Be 'Alice'
        $rec.surname     | Should -Be 'Smith'
        $rec.email       | Should -Be 'alice@contoso.com'
        $rec.extendedAttributes.identityType | Should -Be 'Employee'
    }

    It 'falls back to DisplayName when first/last name are empty' {
        $id = [pscustomobject]@{ UId = 'u2'; DisplayName = 'Service Account 7' }
        (ConvertTo-OmadaIdentityRecord -Identity $id).displayName | Should -Be 'Service Account 7'
    }

    It 'resolves reference values (company/country) via Get-OmadaRefValue' {
        $id = [pscustomobject]@{
            UId = 'u3'; FIRSTNAME = 'Bob'
            COMPANY = [pscustomobject]@{ Value = 'Contoso Ltd' }
            COUNTRY = [pscustomobject]@{ UId = 'c-1'; DisplayName = 'Netherlands' }
        }
        $rec = ConvertTo-OmadaIdentityRecord -Identity $id
        $rec.companyName                      | Should -Be 'Contoso Ltd'
        $rec.country                          | Should -Be 'Netherlands'
        $rec.extendedAttributes.countryId     | Should -Be 'c-1'
        $rec.extendedAttributes.countryName   | Should -Be 'Netherlands'
    }

    It 'resolves org-reference UIds into extendedAttributes' {
        $id = [pscustomobject]@{
            UId = 'u4'; FIRSTNAME = 'Carol'
            OUREF = [pscustomobject]@{ UId = 'ou-9'; DisplayName = 'Sales' }
        }
        $rec = ConvertTo-OmadaIdentityRecord -Identity $id
        $rec.extendedAttributes.ouRefId   | Should -Be 'ou-9'
        $rec.extendedAttributes.ouRefName | Should -Be 'Sales'
    }

    It 'joins MANAGER / EXPLICITOWNER display names with a semicolon' {
        $id = [pscustomobject]@{
            UId = 'u5'; FIRSTNAME = 'Dan'
            MANAGER = @([pscustomobject]@{ DisplayName = 'Boss A' }, [pscustomobject]@{ DisplayName = 'Boss B' })
            EXPLICITOWNER = @([pscustomobject]@{ DisplayName = 'Owner X' })
        }
        $rec = ConvertTo-OmadaIdentityRecord -Identity $id
        $rec.extendedAttributes.manager        | Should -Be 'Boss A; Boss B'
        $rec.extendedAttributes.explicitOwners | Should -Be 'Owner X'
    }
}

Describe 'ConvertTo-OmadaOrgUnitContextRecord' {

    It 'maps an Orgunit to a synced context, resolving type and parent link' {
        $ou = [pscustomobject]@{
            UId = 'ou-1'; NAME = 'Sales'
            OUTYPE = [pscustomobject]@{ Value = 'Organisational Unit' }
            PARENTOU = [pscustomobject]@{ UId = 'ou-root' }
        }
        $rec = ConvertTo-OmadaOrgUnitContextRecord -OrgUnit $ou -DefaultContextType 'OrgUnit'
        $rec.id              | Should -Be 'ou-1'
        $rec.displayName     | Should -Be 'Sales'
        $rec.contextType     | Should -Be 'OrgUnit'
        $rec.variant         | Should -Be 'synced'
        $rec.targetType      | Should -Be 'Identity'
        $rec.parentContextId | Should -Be 'ou-root'
    }

    It 'leaves parentContextId null for a root Orgunit' {
        $ou = [pscustomobject]@{ UId = 'ou-root'; NAME = 'Root' }
        (ConvertTo-OmadaOrgUnitContextRecord -OrgUnit $ou -DefaultContextType 'OrgUnit').parentContextId | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-OmadaFlatContextRecord' {

    It 'maps a flat context entity, falling back to DisplayName when NAME is empty' {
        $rec = ConvertTo-OmadaFlatContextRecord -Item ([pscustomobject]@{ UId = 'l-1'; DisplayName = 'HQ' }) -ContextType 'Location'
        $rec.id          | Should -Be 'l-1'
        $rec.displayName | Should -Be 'HQ'
        $rec.contextType | Should -Be 'Location'
        $rec.targetType  | Should -Be 'Identity'
    }
}

Describe 'Sort-OmadaContextsTopologically' {

    It 'orders parents before their children regardless of input order' {
        $records = @(
            [pscustomobject]@{ id = 'c'; parentContextId = 'b' }
            [pscustomobject]@{ id = 'b'; parentContextId = 'a' }
            [pscustomobject]@{ id = 'a'; parentContextId = $null }
        )
        $sorted = Sort-OmadaContextsTopologically -Records $records
        ($sorted | ForEach-Object { $_.id }) -join '' | Should -Be 'abc'
    }

    It 'still emits every record even when a parent reference forms a cycle' {
        $records = @(
            [pscustomobject]@{ id = 'x'; parentContextId = 'y' }
            [pscustomobject]@{ id = 'y'; parentContextId = 'x' }
        )
        @(Sort-OmadaContextsTopologically -Records $records).Count | Should -Be 2
    }

    It 'returns an empty array for no records' {
        @(Sort-OmadaContextsTopologically -Records @()).Count | Should -Be 0
    }
}
