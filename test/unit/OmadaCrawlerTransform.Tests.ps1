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
    # ConvertTo-AtlasContextType (reads $script:TypeMappings) — used by the Orgunit mapper.
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Functions.ps1')
    # The unit under test.
    . (Join-Path $script:omadaRoot 'OmadaCrawler.Transform.ps1')

    # Context-type mapping the Orgunit mapper resolves through, mirroring the
    # Start script's Configuration-region defaults.
    $script:TypeMappings = @{
        contextTypeToIdentityAtlas  = @{ 'OrgUnit' = 'OrgUnit'; 'Organisational Unit' = 'OrgUnit'; Department = 'Department' }
        identityTypeToIdentityAtlas = @{ Employee = 'User'; Contractor = 'ExternalUser'; 'Service Account' = 'ServicePrincipal' }
    }
    # ConvertTo-AtlasResourceCategory iterates this ordered list; '' is the catch-all.
    $script:ResourceCategoryMapping = @(
        @{ category = 'Business Role'; resourceType = 'BusinessRole' }
        @{ category = '';             resourceType = 'Resource' }
    )
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

Describe 'Get-OmadaContextsInTopologicalOrder' {

    It 'orders parents before their children regardless of input order' {
        $records = @(
            [pscustomobject]@{ id = 'c'; parentContextId = 'b' }
            [pscustomobject]@{ id = 'b'; parentContextId = 'a' }
            [pscustomobject]@{ id = 'a'; parentContextId = $null }
        )
        $sorted = Get-OmadaContextsInTopologicalOrder -Records $records
        ($sorted | ForEach-Object { $_.id }) -join '' | Should -Be 'abc'
    }

    It 'still emits every record even when a parent reference forms a cycle' {
        $records = @(
            [pscustomobject]@{ id = 'x'; parentContextId = 'y' }
            [pscustomobject]@{ id = 'y'; parentContextId = 'x' }
        )
        @(Get-OmadaContextsInTopologicalOrder -Records $records).Count | Should -Be 2
    }

    It 'returns an empty array for no records' {
        @(Get-OmadaContextsInTopologicalOrder -Records @()).Count | Should -Be 0
    }
}

Describe 'ConvertTo-OmadaAccountRecord' {

    It 'maps an account and resolves principalType from the linked identity' {
        $lookup = @{ 'ID-1' = @{ uid = 'idu-1'; identityType = 'Contractor' } }
        $acc = [pscustomobject]@{
            UId = 'acc-1'; FIRSTNAME = 'Eve'; LASTNAME = 'Jones'; EMAIL = 'eve@contoso.com'
            JOBTITLE = 'Consultant'; UserName = 'evej'
            IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' }
        }
        $rec = ConvertTo-OmadaAccountRecord -Account $acc -IdentityLookup $lookup
        $rec.id             | Should -Be 'acc-1'
        $rec.displayName    | Should -Be 'Eve Jones'
        $rec.principalType  | Should -Be 'ExternalUser'   # Contractor -> ExternalUser
        $rec.accountEnabled | Should -BeTrue
        $rec.extendedAttributes.userName | Should -Be 'evej'
    }

    It 'defaults principalType to User when the identity is not in the lookup' {
        $acc = [pscustomobject]@{ UId = 'acc-2'; FIRSTNAME = 'No'; LASTNAME = 'Link' }
        (ConvertTo-OmadaAccountRecord -Account $acc -IdentityLookup @{}).principalType | Should -Be 'User'
    }
}

Describe 'ConvertTo-OmadaIdentityMemberRecord' {

    It 'links an account to its identity when the identity type is person-stored' {
        $lookup = @{ 'ID-1' = @{ uid = 'idu-1'; identityType = 'Employee' } }
        $acc = [pscustomobject]@{ UId = 'acc-1'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' } }
        $rec = ConvertTo-OmadaIdentityMemberRecord -Account $acc -IdentityLookup $lookup -IdentityTypesForIdentityTable @('Employee')
        $rec.identityId  | Should -Be 'idu-1'
        $rec.principalId | Should -Be 'acc-1'
        $rec.accountType | Should -Be 'Primary'
    }

    It 'returns $null for inactive accounts, unknown identities, or non-person types' {
        $lookup = @{ 'ID-1' = @{ uid = 'idu-1'; identityType = 'Machine' } }
        $person = @('Employee')
        ConvertTo-OmadaIdentityMemberRecord -Account ([pscustomobject]@{ UId = 'a'; Inactive = $true }) -IdentityLookup $lookup -IdentityTypesForIdentityTable $person | Should -BeNullOrEmpty
        ConvertTo-OmadaIdentityMemberRecord -Account ([pscustomobject]@{ UId = 'a' }) -IdentityLookup $lookup -IdentityTypesForIdentityTable $person | Should -BeNullOrEmpty
        ConvertTo-OmadaIdentityMemberRecord -Account ([pscustomobject]@{ UId = 'a'; IDENTITYREF = [pscustomobject]@{ IDENTITYID = 'ID-1' } }) -IdentityLookup $lookup -IdentityTypesForIdentityTable $person | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-OmadaResourceRecord' {

    It 'maps a resource, resolves category, owners and usergroup name' {
        $res = [pscustomobject]@{
            UId = 'res-1'; NAME = 'Finance Role'; DESCRIPTION = 'd'
            ROLECATEGORY = [pscustomobject]@{ Value = 'Business Role' }
            USERGROUPREF = [pscustomobject]@{ UId = 'ug-1' }
            EXPLICITOWNER = @([pscustomobject]@{ DisplayName = 'Owner A' })
            RESOURCESTATUS = [pscustomobject]@{ Value = 'Active' }
        }
        $rec = ConvertTo-OmadaResourceRecord -Resource $res -UserGroupMap @{ 'ug-1' = 'Finance Group' }
        $rec.id                 | Should -Be 'res-1'
        $rec.resourceType       | Should -Be 'BusinessRole'
        $rec.governanceResource | Should -BeTrue
        $rec.enabled            | Should -BeTrue
        $rec.extendedAttributes.userGroupName | Should -Be 'Finance Group'
        $rec.extendedAttributes.explicitOwner | Should -Be 'Owner A'
    }

    It 'marks resources with an inactive status as disabled' {
        $res = [pscustomobject]@{ UId = 'res-2'; NAME = 'Old'; RESOURCESTATUS = [pscustomobject]@{ Value = 'Disabled' } }
        (ConvertTo-OmadaResourceRecord -Resource $res).enabled | Should -BeFalse
    }

    It 'returns $null when the resource has no UId or name' {
        ConvertTo-OmadaResourceRecord -Resource ([pscustomobject]@{ NAME = 'No id' }) | Should -BeNullOrEmpty
    }

    It 'carries skipProvisioning through, defaulting to $false when unset' {
        $on  = ConvertTo-OmadaResourceRecord -Resource ([pscustomobject]@{ UId = 'res-sp1'; NAME = 'SP on'; SKIPPROVISIONING = $true })
        $off = ConvertTo-OmadaResourceRecord -Resource ([pscustomobject]@{ UId = 'res-sp2'; NAME = 'SP off' })
        $on.extendedAttributes.skipProvisioning  | Should -BeTrue
        $off.extendedAttributes.skipProvisioning | Should -BeFalse
    }

    It 'leaves userGroupName empty when the usergroup ref is absent from the map' {
        $res = [pscustomobject]@{ UId = 'res-ug'; NAME = 'UG'; USERGROUPREF = [pscustomobject]@{ UId = 'ug-missing' } }
        $rec = ConvertTo-OmadaResourceRecord -Resource $res -UserGroupMap @{ 'ug-1' = 'Finance Group' }
        $rec.extendedAttributes.userGroupName | Should -Be ''
    }
}

Describe 'ConvertTo-OmadaEntitlementRelationships' {

    It 'emits one Contains relationship per CHILDROLES child' {
        $res = [pscustomobject]@{
            UId = 'parent-1'
            CHILDROLES = @([pscustomobject]@{ UId = 'child-1' }, [pscustomobject]@{ UId = 'child-2' })
        }
        $rels = ConvertTo-OmadaEntitlementRelationships -Resource $res
        @($rels).Count | Should -Be 2
        $rels | ForEach-Object {
            $_.parentResourceId | Should -Be 'parent-1'
            $_.relationshipType | Should -Be 'Contains'
        }
        ($rels | ForEach-Object { $_.childResourceId } | Sort-Object) -join ',' | Should -Be 'child-1,child-2'
    }

    It 'returns an empty array when the resource has no CHILDROLES' {
        @(ConvertTo-OmadaEntitlementRelationships -Resource ([pscustomobject]@{ UId = 'p' })).Count | Should -Be 0
    }
}

Describe 'New-OmadaRoleAssignmentRecord' {

    It 'builds a governed Direct assignment with validity in extendedAttributes' {
        $item = [pscustomobject]@{ VALIDFROM = '2026-01-01'; VALIDTO = '2026-12-31' }
        $rec = New-OmadaRoleAssignmentRecord -ResourceUid 'res-1' -PrincipalId 'usr-1' -RoleAssignment $item
        $rec.resourceId     | Should -Be 'res-1'
        $rec.principalId    | Should -Be 'usr-1'
        $rec.assignmentType | Should -Be 'Direct'
        $rec.governed       | Should -BeTrue
        $rec.extendedAttributes.validFrom | Should -Be '2026-01-01'
    }
}

Describe 'ConvertTo-OmadaCraPrincipalRecord' {

    It 'derives a connected-system principal, building displayName from CRA attributes' {
        $cra = [pscustomobject]@{
            Status = $true
            Attributes = [pscustomobject]@{ FIRSTNAME = @('Frank'); LASTNAME = @('Ng'); EMAIL = @('frank@x.com') }
        }
        $rec = ConvertTo-OmadaCraPrincipalRecord -CalculatedAssignment $cra -AccountKey 'acct-key' -AccountName 'frankng' -ResType 'AD Account'
        $rec.id             | Should -Be 'acct-key'
        $rec.externalId     | Should -Be 'frankng'
        $rec.displayName    | Should -Be 'Frank Ng'
        $rec.email          | Should -Be 'frank@x.com'
        $rec.accountEnabled | Should -BeTrue
        $rec.extendedAttributes.accountType | Should -Be 'AD Account'
    }

    It 'falls back to AccountName when no name attributes are present' {
        $cra = [pscustomobject]@{ Status = $false; Attributes = [pscustomobject]@{} }
        (ConvertTo-OmadaCraPrincipalRecord -CalculatedAssignment $cra -AccountKey 'k' -AccountName 'svc_acct').displayName | Should -Be 'svc_acct'
    }
}

Describe 'ConvertTo-OmadaCraAssignmentRecord' {

    It 'builds a governed Direct assignment, flattening reasons and status' {
        $cra = [pscustomobject]@{
            ValidFrom = '2026-01-01'; ValidTo = '2026-12-31'; Status = $true; IsManaged = $true
            Reasons = @([pscustomobject]@{ Description = 'Role X' }, [pscustomobject]@{ Description = 'Policy Y' })
        }
        $rec = ConvertTo-OmadaCraAssignmentRecord -CalculatedAssignment $cra -ResourceUid 'res-9' -PrincipalId 'prn-9' -ResType 'AD' -AccountName 'a'
        $rec.assignmentType | Should -Be 'Direct'
        $rec.governed       | Should -BeTrue
        $rec.extendedAttributes.status    | Should -Be 'Enabled'
        $rec.extendedAttributes.reasons   | Should -Be 'Role X; Policy Y'
        $rec.extendedAttributes.isManaged | Should -BeTrue
    }

    It 'records status Disabled when the CRA status is false' {
        $cra = [pscustomobject]@{ Status = $false }
        (ConvertTo-OmadaCraAssignmentRecord -CalculatedAssignment $cra -ResourceUid 'r' -PrincipalId 'p').extendedAttributes.status | Should -Be 'Disabled'
    }
}

Describe 'New-OmadaContextMemberRecord' {

    It 'builds an Identity context-member link' {
        $rec = New-OmadaContextMemberRecord -ContextId 'ctx-1' -MemberId 'idu-1'
        $rec.contextId  | Should -Be 'ctx-1'
        $rec.memberId   | Should -Be 'idu-1'
        $rec.memberType | Should -Be 'Identity'
        $rec.addedBy    | Should -Be 'sync'
    }
}
