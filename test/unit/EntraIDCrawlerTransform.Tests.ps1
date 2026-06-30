#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the pure record-shaping functions extracted into
    tools/crawlers/entra-id/EntraIDCrawler.Transform.ps1.

.DESCRIPTION
    Covers ConvertTo-EntraPrincipalRecord and ConvertTo-EntraSignInActivityRecord —
    the per-user mapping logic moved verbatim out of Start-EntraIDCrawler.ps1's
    Main body. These are pure (no HTTP, no script-scope writes), so they run
    against in-memory Graph fixtures with no mocks.

    This is the characterization test for the Principals-phase refactor: it pins
    the principal/activity record shape so the extraction can be proven behaviour-
    preserving. Get-UserAttrValue comes from EntraIDCrawler.Functions.ps1;
    Add-FGEntraCalculatedAttributes (a Graph SDK helper with its own tests) is
    stubbed so this unit stays hermetic.

.USAGE
    Invoke-Pester -Path test/unit/EntraIDCrawlerTransform.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    # Get-UserAttrValue (used by ConvertTo-EntraPrincipalRecord for custom attrs).
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Transform.ps1')

    # Get-FGServicePrincipalType (pure SDK classifier) — used by
    # ConvertTo-EntraServicePrincipalRecord.
    . (Join-Path $script:repoRoot 'tools' 'powershell-sdk' 'helpers' 'Get-FGServicePrincipalType.ps1')

    # Add-FGEntraCalculatedAttributes is a Graph SDK helper with its own tests.
    # Stub it so the transform unit stays hermetic; the stub stamps a marker key
    # when the user has a DN, so we can assert the calculated-attrs merge wiring.
    function Add-FGEntraCalculatedAttributes {
        param($Object, $Ext, $Type)
        if ($Object.onPremisesDistinguishedName) { $Ext['_calc'] = $Type }
    }
}

Describe 'ConvertTo-EntraPrincipalRecord' {

    It 'maps core attributes and stamps principalType = User' {
        $user = [pscustomobject]@{
            id = 'u1'; displayName = 'Alice'; mail = 'alice@contoso.com'
            accountEnabled = $true; givenName = 'Alice'; surname = 'A'
            department = 'IT'; jobTitle = 'Eng'; companyName = 'Contoso'
            employeeId = 'E1'; createdDateTime = '2020-01-01T00:00:00Z'
        }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['id']             | Should -Be 'u1'
        $rec['displayName']    | Should -Be 'Alice'
        $rec['email']          | Should -Be 'alice@contoso.com'
        $rec['principalType']  | Should -Be 'User'
        $rec['accountEnabled'] | Should -BeTrue
        $rec['department']     | Should -Be 'IT'
        $rec['employeeId']     | Should -Be 'E1'
    }

    It 'falls back to userPrincipalName when mail is absent' {
        $user = [pscustomobject]@{ id = 'u2'; displayName = 'Bob'; userPrincipalName = 'bob@contoso.com' }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['email'] | Should -Be 'bob@contoso.com'
    }

    It 'coerces accountEnabled to a real boolean' {
        $user = [pscustomobject]@{ id = 'u3'; displayName = 'C'; accountEnabled = $false }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['accountEnabled'] | Should -BeOfType [bool]
        $rec['accountEnabled'] | Should -BeFalse
    }

    It 'adds managerId only when the expanded manager has an id' {
        $withMgr = [pscustomobject]@{ id = 'u4'; displayName = 'D'; manager = [pscustomobject]@{ id = 'm1' } }
        (ConvertTo-EntraPrincipalRecord -User $withMgr)['managerId'] | Should -Be 'm1'

        $noMgr = [pscustomobject]@{ id = 'u5'; displayName = 'E' }
        (ConvertTo-EntraPrincipalRecord -User $noMgr).ContainsKey('managerId') | Should -BeFalse
    }

    It 'puts userType and externalUserState into extendedAttributes when present' {
        $user = [pscustomobject]@{ id = 'u6'; displayName = 'F'; userType = 'Guest'; externalUserState = 'Accepted' }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['extendedAttributes']['userType']          | Should -Be 'Guest'
        $rec['extendedAttributes']['externalUserState'] | Should -Be 'Accepted'
    }

    It 'omits extendedAttributes entirely when there is nothing to add' {
        $user = [pscustomobject]@{ id = 'u7'; displayName = 'G' }
        (ConvertTo-EntraPrincipalRecord -User $user).ContainsKey('extendedAttributes') | Should -BeFalse
    }

    It 'pulls non-empty custom attributes via Get-UserAttrValue, skipping blanks' {
        $user = [pscustomobject]@{ id = 'u8'; displayName = 'H'; officeLocation = 'Bldg 1'; costCenter = '' }
        $rec = ConvertTo-EntraPrincipalRecord -User $user -CustomUserAttributes @('officeLocation','costCenter')
        $rec['extendedAttributes']['officeLocation'] | Should -Be 'Bldg 1'
        $rec['extendedAttributes'].ContainsKey('costCenter') | Should -BeFalse
    }

    It 'merges Add-FGEntraCalculatedAttributes output into extendedAttributes' {
        $user = [pscustomobject]@{ id = 'u9'; displayName = 'I'; onPremisesDistinguishedName = 'CN=I,OU=Staff,DC=x' }
        $rec = ConvertTo-EntraPrincipalRecord -User $user
        $rec['extendedAttributes']['_calc'] | Should -Be 'User'
    }
}

Describe 'ConvertTo-EntraSignInActivityRecord' {

    It 'returns $null when the user has no signInActivity' {
        $user = [pscustomobject]@{ id = 'u1'; displayName = 'Alice' }
        ConvertTo-EntraSignInActivityRecord -User $user | Should -BeNullOrEmpty
    }

    It 'returns $null when signInActivity carries no timestamps' {
        $user = [pscustomobject]@{ id = 'u1'; signInActivity = [pscustomobject]@{} }
        ConvertTo-EntraSignInActivityRecord -User $user | Should -BeNullOrEmpty
    }

    It 'builds an aggregate SignIn record with the timestamps that are present' {
        $user = [pscustomobject]@{
            id = 'u1'
            signInActivity = [pscustomobject]@{
                lastSignInDateTime = '2026-01-01T00:00:00Z'
                lastSuccessfulSignInDateTime = '2026-01-02T00:00:00Z'
            }
        }
        $rec = ConvertTo-EntraSignInActivityRecord -User $user
        $rec['principalId']                  | Should -Be 'u1'
        $rec['activityType']                 | Should -Be 'SignIn'
        $rec['resourceId']                   | Should -Be '00000000-0000-0000-0000-000000000000'
        $rec['lastSignInDateTime']           | Should -Be '2026-01-01T00:00:00Z'
        $rec['lastSuccessfulSignInDateTime'] | Should -Be '2026-01-02T00:00:00Z'
        $rec.ContainsKey('lastNonInteractiveSignInDateTime') | Should -BeFalse
    }
}

Describe 'ConvertTo-EntraServicePrincipalRecord' {

    It 'maps core fields and classifies a plain SP as ServicePrincipal' {
        $sp = [pscustomobject]@{
            id = 'sp1'; displayName = 'Contoso CRM'; accountEnabled = $true
            servicePrincipalType = 'Application'; createdDateTime = '2021-05-05T00:00:00Z'
        }
        $rec = ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp
        $rec['id']              | Should -Be 'sp1'
        $rec['principalType']   | Should -Be 'ServicePrincipal'
        $rec['accountEnabled']  | Should -BeOfType [bool]
        $rec['createdDateTime'] | Should -Be '2021-05-05T00:00:00Z'
    }

    It 'classifies servicePrincipalType=ManagedIdentity as ManagedIdentity' {
        $sp = [pscustomobject]@{ id = 'sp2'; displayName = 'mi-app'; servicePrincipalType = 'ManagedIdentity' }
        (ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp)['principalType'] | Should -Be 'ManagedIdentity'
    }

    It 'classifies a caller-supplied AI name pattern as AIAgent' {
        $sp = [pscustomobject]@{ id = 'sp3'; displayName = 'svc_ai_helper'; servicePrincipalType = 'Application' }
        (ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp -AINamePatterns @('svc_ai_'))['principalType'] | Should -Be 'AIAgent'
    }

    It 'joins tags and servicePrincipalNames arrays into comma strings in extendedAttributes' {
        $sp = [pscustomobject]@{
            id = 'sp4'; displayName = 'Plain App'; servicePrincipalType = 'Application'
            appId = 'app-4'; publisherName = 'Contoso'
            tags = @('foo','bar'); servicePrincipalNames = @('https://a','https://b')
        }
        $rec = ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp
        $rec['extendedAttributes']['appId']                 | Should -Be 'app-4'
        $rec['extendedAttributes']['publisherName']         | Should -Be 'Contoso'
        $rec['extendedAttributes']['tags']                  | Should -Be 'foo,bar'
        $rec['extendedAttributes']['servicePrincipalNames'] | Should -Be 'https://a,https://b'
    }

    It 'omits extendedAttributes when there is nothing to add' {
        # No servicePrincipalType/appId/tags/etc. → classifier defaults to
        # ServicePrincipal and the ext bag stays empty.
        $sp = [pscustomobject]@{ id = 'sp5'; displayName = 'Bare' }
        (ConvertTo-EntraServicePrincipalRecord -ServicePrincipal $sp).ContainsKey('extendedAttributes') | Should -BeFalse
    }
}

Describe 'ConvertTo-EntraSpActivityRecord' {

    It 'returns $null when there is no matched activity row' {
        $sp = [pscustomobject]@{ id = 'sp1' }
        ConvertTo-EntraSpActivityRecord -ServicePrincipal $sp -Activity $null | Should -BeNullOrEmpty
    }

    It 'builds a ServicePrincipalSignIn record from primary timestamps' {
        $sp = [pscustomobject]@{ id = 'sp1' }
        $act = [pscustomobject]@{
            lastSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-02-01T00:00:00Z' }
            lastNonInteractiveSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-02-02T00:00:00Z' }
        }
        $rec = ConvertTo-EntraSpActivityRecord -ServicePrincipal $sp -Activity $act -AggregateResourceId 'agg'
        $rec['principalId']                     | Should -Be 'sp1'
        $rec['activityType']                    | Should -Be 'ServicePrincipalSignIn'
        $rec['resourceId']                      | Should -Be 'agg'
        $rec['lastSignInDateTime']              | Should -Be '2026-02-01T00:00:00Z'
        $rec['lastNonInteractiveSignInDateTime']| Should -Be '2026-02-02T00:00:00Z'
    }

    It 'emits only the client-variant timestamps into extendedAttributes when no primary timestamps exist' {
        $sp = [pscustomobject]@{ id = 'sp1' }
        $act = [pscustomobject]@{
            applicationAuthenticationClientSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-03-01T00:00:00Z' }
            delegatedClientSignInActivity = [pscustomobject]@{ lastSignInDateTime = '2026-03-02T00:00:00Z' }
        }
        $rec = ConvertTo-EntraSpActivityRecord -ServicePrincipal $sp -Activity $act
        $rec.ContainsKey('lastSignInDateTime') | Should -BeFalse
        $rec['extendedAttributes']['lastApplicationAuthSignInDateTime'] | Should -Be '2026-03-01T00:00:00Z'
        $rec['extendedAttributes']['lastDelegatedClientSignInDateTime'] | Should -Be '2026-03-02T00:00:00Z'
    }

    It 'returns $null when the activity row carries no usable timestamp' {
        $sp = [pscustomobject]@{ id = 'sp1' }
        ConvertTo-EntraSpActivityRecord -ServicePrincipal $sp -Activity ([pscustomobject]@{}) | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-EntraGroupResourceRecord' {

    It 'maps a group to an EntraGroup resource with joined groupTypes' {
        $group = [pscustomobject]@{
            id = 'g1'; displayName = 'Sales'; description = 'Sales team'; mail = 'sales@contoso.com'
            visibility = 'Private'; createdDateTime = '2019-01-01T00:00:00Z'
            groupTypes = @('Unified'); securityEnabled = $false; mailEnabled = $true
        }
        $rec = ConvertTo-EntraGroupResourceRecord -Group $group
        $rec['id']                            | Should -Be 'g1'
        $rec['resourceType']                  | Should -Be 'EntraGroup'
        $rec['enabled']                       | Should -BeTrue
        $rec['mail']                          | Should -Be 'sales@contoso.com'
        $rec['extendedAttributes']['groupTypes']      | Should -Be 'Unified'
        $rec['extendedAttributes']['securityEnabled'] | Should -BeFalse
        $rec['extendedAttributes']['mailEnabled']     | Should -BeTrue
    }

    It 'joins multiple groupTypes into a comma string' {
        $group = [pscustomobject]@{ id = 'g2'; displayName = 'X'; groupTypes = @('Unified','DynamicMembership') }
        (ConvertTo-EntraGroupResourceRecord -Group $group)['extendedAttributes']['groupTypes'] | Should -Be 'Unified,DynamicMembership'
    }

    It 'copies non-null custom group attributes into extendedAttributes' {
        $group = [pscustomobject]@{ id = 'g3'; displayName = 'Y'; fgGroupDN = 'CN=Y,OU=Groups'; emptyAttr = $null }
        $rec = ConvertTo-EntraGroupResourceRecord -Group $group -CustomGroupAttributes @('fgGroupDN','emptyAttr')
        $rec['extendedAttributes']['fgGroupDN'] | Should -Be 'CN=Y,OU=Groups'
        $rec['extendedAttributes'].ContainsKey('emptyAttr') | Should -BeFalse
    }
}

Describe 'ConvertTo-EntraGroupOwnership' {

    It 'emits one GroupOwnership resource + HasOwnership relationship per owned group, and a Direct assignment per owner' {
        $rawOwners = @(
            @{ groupId = 'g1'; principalId = 'u1' }
            @{ groupId = 'g1'; principalId = 'u2' }   # second owner of the same group
            @{ groupId = 'g2'; principalId = 'u1' }
        )
        $out = ConvertTo-EntraGroupOwnership -RawOwners $rawOwners -GroupNameById @{ g1 = 'Sales'; g2 = 'Eng' }

        # One resource and one relationship per distinct owned group (g1, g2).
        $out.resources.Count     | Should -Be 2
        $out.relationships.Count | Should -Be 2
        # One assignment per owner pair (3).
        $out.assignments.Count   | Should -Be 3

        $out.resources | ForEach-Object { $_.resourceType | Should -Be 'GroupOwnership' }
        ($out.resources | Where-Object { $_.displayName -eq 'Owner @ Sales' }) | Should -Not -BeNullOrEmpty
        $out.relationships | ForEach-Object { $_.relationshipType | Should -Be 'HasOwnership' }
        $out.assignments | ForEach-Object {
            $_.assignmentType | Should -Be 'Direct'
            $_.resourceType   | Should -Be 'GroupOwnership'
        }
    }

    It 'falls back to "(group)" when the group name is unknown' {
        $out = ConvertTo-EntraGroupOwnership -RawOwners @(@{ groupId = 'gX'; principalId = 'u1' }) -GroupNameById @{}
        $out.resources[0].displayName | Should -Be 'Owner @ (group)'
        $out.resources[0].externalId  | Should -Be 'entraid-ownership:gX'
    }

    It 'returns empty collections for no owners' {
        $out = ConvertTo-EntraGroupOwnership -RawOwners @() -GroupNameById @{}
        $out.resources.Count     | Should -Be 0
        $out.relationships.Count | Should -Be 0
        $out.assignments.Count   | Should -Be 0
    }
}

Describe 'Add-EntraSignInEventToAggregate' {

    It 'returns $false and leaves the aggregate untouched when userId/appId is missing' {
        $agg = @{}
        Add-EntraSignInEventToAggregate -SignInEvent ([pscustomobject]@{ appId = 'a1' }) -Aggregate $agg -AppIdToSpId @{ a1 = 'sp1' } | Should -BeFalse
        $agg.Count | Should -Be 0
    }

    It 'returns $false when the appId is not in the SP index' {
        $agg = @{}
        $ev = [pscustomobject]@{ userId = 'u1'; appId = 'unknown'; createdDateTime = '2026-01-01T00:00:00Z' }
        Add-EntraSignInEventToAggregate -SignInEvent $ev -Aggregate $agg -AppIdToSpId @{ a1 = 'sp1' } | Should -BeFalse
        $agg.Count | Should -Be 0
    }

    It 'creates a per-(user, app) entry keyed by userId|spId and counts the sign-in' {
        $agg = @{}
        $ev = [pscustomobject]@{ userId = 'u1'; appId = 'a1'; createdDateTime = '2026-01-01T00:00:00Z'; status = [pscustomobject]@{ errorCode = 0 } }
        Add-EntraSignInEventToAggregate -SignInEvent $ev -Aggregate $agg -AppIdToSpId @{ a1 = 'sp1' } | Should -BeTrue
        $agg['u1|sp1'].principalId  | Should -Be 'u1'
        $agg['u1|sp1'].resourceId   | Should -Be 'sp1'
        $agg['u1|sp1'].activityType | Should -Be 'SignInPerApp'
        $agg['u1|sp1'].signInCount  | Should -Be 1
        $agg['u1|sp1'].lastSuccessfulSignInDateTime | Should -Be '2026-01-01T00:00:00Z'
    }

    It 'accumulates a second event into the same entry and advances lastSignInDateTime' {
        $agg = @{}
        $map = @{ a1 = 'sp1' }
        Add-EntraSignInEventToAggregate -SignInEvent ([pscustomobject]@{ userId='u1'; appId='a1'; createdDateTime='2026-01-01T00:00:00Z'; status=[pscustomobject]@{ errorCode=0 } }) -Aggregate $agg -AppIdToSpId $map | Out-Null
        Add-EntraSignInEventToAggregate -SignInEvent ([pscustomobject]@{ userId='u1'; appId='a1'; createdDateTime='2026-02-01T00:00:00Z'; status=[pscustomobject]@{ errorCode=0 } }) -Aggregate $agg -AppIdToSpId $map | Out-Null
        $agg['u1|sp1'].signInCount        | Should -Be 2
        $agg['u1|sp1'].lastSignInDateTime | Should -Be '2026-02-01T00:00:00Z'
    }

    It 'records a non-zero errorCode as a failed sign-in, not a successful one' {
        $agg = @{}
        $ev = [pscustomobject]@{ userId='u1'; appId='a1'; createdDateTime='2026-03-01T00:00:00Z'; status=[pscustomobject]@{ errorCode = 50126 } }
        Add-EntraSignInEventToAggregate -SignInEvent $ev -Aggregate $agg -AppIdToSpId @{ a1 = 'sp1' } | Should -BeTrue
        $agg['u1|sp1'].lastFailedSignInDateTime     | Should -Be '2026-03-01T00:00:00Z'
        $agg['u1|sp1'].lastSuccessfulSignInDateTime | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-EntraPimRecord' {

    It 'maps an eligibility row to an Eligible EntraGroup assignment, carrying state/expiry' {
        $row = [pscustomobject]@{
            resourceId = 'g1'; principalId = 'u1'; principalType = 'User'
            assignmentType = 'Eligible'; state = 'Provisioned'; expirationDateTime = '2026-12-31T00:00:00Z'
        }
        $rec = ConvertTo-EntraPimRecord -EligibilityRow $row
        $rec['resourceId']         | Should -Be 'g1'
        $rec['principalId']        | Should -Be 'u1'
        $rec['assignmentType']     | Should -Be 'Eligible'
        $rec['resourceType']       | Should -Be 'EntraGroup'
        $rec['state']              | Should -Be 'Provisioned'
        $rec['expirationDateTime'] | Should -Be '2026-12-31T00:00:00Z'
    }
}

Describe 'ConvertTo-EntraGovernanceCatalogRecord' {

    It 'maps a catalog and derives enabled from isPublished' {
        $cat = [pscustomobject]@{ id = 'c1'; displayName = 'General'; description = 'd'; catalogType = 'UserManaged'; isPublished = $true; createdDateTime = '2020-01-01T00:00:00Z'; modifiedDateTime = '2021-01-01T00:00:00Z' }
        $rec = ConvertTo-EntraGovernanceCatalogRecord -Catalog $cat
        $rec['id']      | Should -Be 'c1'
        $rec['enabled'] | Should -BeTrue
        $rec['catalogType'] | Should -Be 'UserManaged'
    }

    It 'maps enabled = $false for an unpublished catalog' {
        $cat = [pscustomobject]@{ id = 'c2'; displayName = 'Draft'; isPublished = $false }
        (ConvertTo-EntraGovernanceCatalogRecord -Catalog $cat)['enabled'] | Should -BeFalse
    }
}

Describe 'ConvertTo-EntraAccessPackageRecord' {

    It 'maps an access package to a governance BusinessRole resource' {
        $ap = [pscustomobject]@{ id = 'ap1'; displayName = 'Finance Access'; description = 'd'; catalogId = 'c1'; isHidden = $false; createdDateTime = '2022-01-01T00:00:00Z'; modifiedDateTime = '2022-06-01T00:00:00Z' }
        $rec = ConvertTo-EntraAccessPackageRecord -AccessPackage $ap
        $rec['resourceType']       | Should -Be 'BusinessRole'
        $rec['governanceResource'] | Should -BeTrue
        $rec['enabled']            | Should -BeTrue
        $rec['catalogId']          | Should -Be 'c1'
        $rec['isHidden']           | Should -BeFalse
    }
}

Describe 'ConvertTo-EntraAssignmentPolicyRecord' {

    It 'resolves apId from the expanded accessPackage and reads auto/review flags' {
        $pol = [pscustomobject]@{
            id = 'p1'; displayName = 'Auto policy'; description = 'd'; allowedTargetScope = 'allMemberUsers'
            accessPackage = [pscustomobject]@{ id = 'ap1' }
            automaticRequestSettings = [pscustomobject]@{ requestAccessForAllowedTargets = $true; removeAccessWhenTargetLeavesAllowedTargets = $true }
            reviewSettings = [pscustomobject]@{ isEnabled = $true }
        }
        $rec = ConvertTo-EntraAssignmentPolicyRecord -Policy $pol
        $rec['resourceId']        | Should -Be 'ap1'
        $rec['hasAutoAddRule']    | Should -BeTrue
        $rec['hasAutoRemoveRule'] | Should -BeTrue
        $rec['hasAccessReview']   | Should -BeTrue
    }

    It 'falls back to accessPackageId and defaults flags to $false when settings are absent' {
        $pol = [pscustomobject]@{ id = 'p2'; accessPackageId = 'ap2' }
        $rec = ConvertTo-EntraAssignmentPolicyRecord -Policy $pol
        $rec['resourceId']        | Should -Be 'ap2'
        $rec['hasAutoAddRule']    | Should -BeFalse
        $rec['hasAccessReview']   | Should -BeFalse
    }

    It 'returns $null when no access-package id can be resolved' {
        ConvertTo-EntraAssignmentPolicyRecord -Policy ([pscustomobject]@{ id = 'p3' }) | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-EntraAccessPackageScopeRelationship' {

    It 'maps a role scope to a Contains relationship with role name/origin' {
        $rrs = [pscustomobject]@{
            accessPackageResourceScope = [pscustomobject]@{ originId = 'g1' }
            accessPackageResourceRole  = [pscustomobject]@{ displayName = 'Owner'; originSystem = 'AadGroup' }
        }
        $rel = ConvertTo-EntraAccessPackageScopeRelationship -RoleScope $rrs -AccessPackageId 'ap1'
        $rel['parentResourceId'] | Should -Be 'ap1'
        $rel['childResourceId']  | Should -Be 'g1'
        $rel['relationshipType'] | Should -Be 'Contains'
        $rel['roleName']         | Should -Be 'Owner'
    }

    It 'defaults roleName/roleOriginSystem when the role is absent' {
        $rrs = [pscustomobject]@{ accessPackageResourceScope = [pscustomobject]@{ originId = 'g2' } }
        $rel = ConvertTo-EntraAccessPackageScopeRelationship -RoleScope $rrs -AccessPackageId 'ap1'
        $rel['roleName']         | Should -Be 'Member'
        $rel['roleOriginSystem'] | Should -Be 'AadGroup'
    }

    It 'returns $null when the scope has no originId' {
        $rrs = [pscustomobject]@{ accessPackageResourceScope = [pscustomobject]@{} }
        ConvertTo-EntraAccessPackageScopeRelationship -RoleScope $rrs -AccessPackageId 'ap1' | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-EntraAccessPackageAssignmentRecord' {

    It 'maps an active assignment to a governed Direct BusinessRole assignment' {
        $a = [pscustomobject]@{
            accessPackage = [pscustomobject]@{ id = 'ap1' }
            target = [pscustomobject]@{ objectId = 'u1' }
            assignmentState = 'Delivered'; assignmentStatus = 'Delivered'; expiredDateTime = $null
        }
        $rec = ConvertTo-EntraAccessPackageAssignmentRecord -Assignment $a
        $rec['resourceId']     | Should -Be 'ap1'
        $rec['principalId']    | Should -Be 'u1'
        $rec['assignmentType'] | Should -Be 'Direct'
        $rec['resourceType']   | Should -Be 'BusinessRole'
        $rec['governed']       | Should -BeTrue
    }

    It 'returns $null for an inactive assignment state' {
        $a = [pscustomobject]@{ accessPackage = [pscustomobject]@{ id = 'ap1' }; target = [pscustomobject]@{ objectId = 'u1' }; assignmentState = 'Expired' }
        ConvertTo-EntraAccessPackageAssignmentRecord -Assignment $a | Should -BeNullOrEmpty
    }

    It 'returns $null when the package or target is missing' {
        ConvertTo-EntraAccessPackageAssignmentRecord -Assignment ([pscustomobject]@{ target = [pscustomobject]@{ objectId = 'u1' } }) | Should -BeNullOrEmpty
        ConvertTo-EntraAccessPackageAssignmentRecord -Assignment ([pscustomobject]@{ accessPackage = [pscustomobject]@{ id = 'ap1' } }) | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-EntraOAuth2ClientResource' {

    It 'maps a client SP to an Application resource with appId/publisher in extendedAttributes' {
        $rec = ConvertTo-EntraOAuth2ClientResource -ClientId 'c1' -SpInfo @{ displayName = 'My App'; appId = 'app-1'; publisherName = 'Contoso' }
        $rec['id']           | Should -Be 'c1'
        $rec['displayName']  | Should -Be 'My App'
        $rec['resourceType'] | Should -Be 'Application'
        $rec['enabled']      | Should -BeTrue
        $rec['extendedAttributes']['appId']         | Should -Be 'app-1'
        $rec['extendedAttributes']['publisherName'] | Should -Be 'Contoso'
    }

    It 'omits extendedAttributes when appId and publisher are absent' {
        $rec = ConvertTo-EntraOAuth2ClientResource -ClientId 'c2' -SpInfo @{ displayName = 'Bare' }
        $rec.ContainsKey('extendedAttributes') | Should -BeFalse
    }
}

Describe 'ConvertTo-EntraOAuth2ScopeGraph' {

    It 'splits a multi-scope grant into one resource/relationship/assignment per scope' {
        $grant = [pscustomobject]@{ id = 'gr1'; clientId = 'c1'; resourceId = 'api1'; principalId = 'u1'; scope = 'Mail.Read User.Read' }
        $out = ConvertTo-EntraOAuth2ScopeGraph -UserGrants @($grant) -SpInfo @{ c1 = @{ displayName = 'Client' }; api1 = @{ displayName = 'Graph' } }
        $out.resources.Count     | Should -Be 2
        $out.relationships.Count | Should -Be 2
        $out.assignments.Count   | Should -Be 2
        $out.resources     | ForEach-Object { $_.resourceType | Should -Be 'DelegatedPermission' }
        $out.relationships | ForEach-Object { $_.relationshipType | Should -Be 'DelegatesScope'; $_.parentResourceId | Should -Be 'c1' }
        $out.assignments   | ForEach-Object { $_.assignmentType | Should -Be 'Direct'; $_.principalId | Should -Be 'u1' }
        ($out.assignments.extendedAttributes.scope | Sort-Object) -join ',' | Should -Be 'Mail.Read,User.Read'
    }

    It 'dedups the resource/relationship across users but keeps one assignment per user' {
        $grants = @(
            [pscustomobject]@{ id = 'g1'; clientId = 'c1'; resourceId = 'api1'; principalId = 'u1'; scope = 'Mail.Read' }
            [pscustomobject]@{ id = 'g2'; clientId = 'c1'; resourceId = 'api1'; principalId = 'u2'; scope = 'Mail.Read' }
        )
        $out = ConvertTo-EntraOAuth2ScopeGraph -UserGrants $grants -SpInfo @{ c1 = @{ displayName = 'Client' }; api1 = @{ displayName = 'Graph' } }
        $out.resources.Count     | Should -Be 1
        $out.relationships.Count | Should -Be 1
        $out.assignments.Count   | Should -Be 2
    }

    It 'skips grants missing client/target/user, and grants with no scope' {
        $grants = @(
            [pscustomobject]@{ id = 'g1'; clientId = 'c1'; resourceId = 'api1'; principalId = $null; scope = 'Mail.Read' }   # no user
            [pscustomobject]@{ id = 'g2'; clientId = 'c1'; resourceId = 'api1'; principalId = 'u1'; scope = '' }              # no scope
        )
        $out = ConvertTo-EntraOAuth2ScopeGraph -UserGrants $grants -SpInfo @{}
        $out.resources.Count   | Should -Be 0
        $out.assignments.Count | Should -Be 0
    }
}

Describe 'ConvertTo-EntraAppRoleApplicationResource' {

    It 'maps an enterprise app SP to an Application resource with flags in ext' {
        $sp = [pscustomobject]@{ id = 'sp1'; displayName = 'CRM'; appId = 'app-1'; appRoleAssignmentRequired = $true; servicePrincipalType = 'Application' }
        $rec = ConvertTo-EntraAppRoleApplicationResource -ServicePrincipal $sp
        $rec['resourceType'] | Should -Be 'Application'
        $rec['extendedAttributes']['appId']                     | Should -Be 'app-1'
        $rec['extendedAttributes']['appRoleAssignmentRequired'] | Should -BeTrue
    }
}

Describe 'Get-EntraAppRoleCatalog' {

    It 'indexes appRoles by id and always adds the Default Access role' {
        $sp = [pscustomobject]@{ appRoles = @([pscustomobject]@{ id = 'r1'; displayName = 'Reader' }) }
        $cat = Get-EntraAppRoleCatalog -ServicePrincipal $sp -DefaultRoleId '0000'
        $cat['r1'].displayName   | Should -Be 'Reader'
        $cat['0000'].displayName | Should -Be 'Default Access'
    }

    It 'synthesizes only the default role for an SP with no appRoles' {
        $cat = Get-EntraAppRoleCatalog -ServicePrincipal ([pscustomobject]@{ appRoles = @() }) -DefaultRoleId '0000'
        $cat.Count | Should -Be 1
        $cat.ContainsKey('0000') | Should -BeTrue
    }
}

Describe 'New-EntraAppRoleResourceRecord' {

    It 'builds an AppRole resource named "<role> on <app>" with role detail in ext' {
        $sp   = [pscustomobject]@{ id = 'sp1'; displayName = 'CRM' }
        $role = [pscustomobject]@{ id = 'r1'; displayName = 'Reader'; value = 'Reader.Role' }
        $rec  = New-EntraAppRoleResourceRecord -ServicePrincipal $sp -Role $role -RoleResourceId 'res-1'
        $rec['id']           | Should -Be 'res-1'
        $rec['displayName']  | Should -Be 'Reader on CRM'
        $rec['resourceType'] | Should -Be 'AppRole'
        $rec['extendedAttributes']['appRoleId']    | Should -Be 'r1'
        $rec['extendedAttributes']['appRoleValue'] | Should -Be 'Reader.Role'
    }

    It 'falls back to "Default Access" when the role has no displayName' {
        $rec = New-EntraAppRoleResourceRecord -ServicePrincipal ([pscustomobject]@{ id = 'sp1'; displayName = 'CRM' }) -Role ([pscustomobject]@{ id = '0000' }) -RoleResourceId 'res-0'
        $rec['displayName'] | Should -Be 'Default Access on CRM'
    }
}

Describe 'New-EntraAppRoleRelationshipRecord' {

    It 'builds a HasAppRole relationship from app to role' {
        $rec = New-EntraAppRoleRelationshipRecord -ServicePrincipal ([pscustomobject]@{ id = 'sp1' }) -RoleResourceId 'res-1' -RoleName 'Reader'
        $rec['parentResourceId'] | Should -Be 'sp1'
        $rec['childResourceId']  | Should -Be 'res-1'
        $rec['relationshipType'] | Should -Be 'HasAppRole'
        $rec['roleOriginSystem'] | Should -Be 'EntraID'
    }
}

Describe 'New-EntraAppRoleAssignmentRecord' {

    It 'builds a Direct AppRole assignment carrying the requested principalType' {
        $a = [pscustomobject]@{ id = 'asn1'; principalId = 'u1'; createdDateTime = '2026-01-01T00:00:00Z' }
        $rec = New-EntraAppRoleAssignmentRecord -RoleResourceId 'res-1' -Assignment $a -RoleId 'r1' -PrincipalType 'User' -AppDisplayName 'CRM'
        $rec['resourceId']     | Should -Be 'res-1'
        $rec['principalId']    | Should -Be 'u1'
        $rec['principalType']  | Should -Be 'User'
        $rec['assignmentType'] | Should -Be 'Direct'
        $rec['resourceType']   | Should -Be 'AppRole'
        $rec['extendedAttributes']['appRoleAssignmentId'] | Should -Be 'asn1'
        $rec['extendedAttributes']['resourceDisplayName'] | Should -Be 'CRM'
    }

    It 'stamps principalType Group when asked' {
        $a = [pscustomobject]@{ id = 'asn2'; principalId = 'g1' }
        (New-EntraAppRoleAssignmentRecord -RoleResourceId 'res-1' -Assignment $a -RoleId 'r1' -PrincipalType 'Group')['principalType'] | Should -Be 'Group'
    }
}

Describe 'ConvertTo-EntraAppRoleIndirectAssignments' {

    It 'produces one Indirect row per (role assignment x member user)' {
        $roleAssns = @(
            @{ roleResId = 'res-1'; roleId = 'r1'; sourceAssignmentId = 's1'; appName = 'CRM' }
            @{ roleResId = 'res-2'; roleId = 'r2'; sourceAssignmentId = 's2'; appName = 'CRM' }
        )
        $rows = ConvertTo-EntraAppRoleIndirectAssignments -RoleAssignments $roleAssns -UserIds @('u1','u2','u3') -GroupId 'g1'
        @($rows).Count | Should -Be 6   # 2 roles x 3 users
        $rows | ForEach-Object {
            $_.assignmentType | Should -Be 'Indirect'
            $_.resourceType   | Should -Be 'AppRole'
            $_.extendedAttributes.viaGroupId | Should -Be 'g1'
        }
    }

    It 'produces nothing when the group has no transitive users' {
        $rows = ConvertTo-EntraAppRoleIndirectAssignments -RoleAssignments @(@{ roleResId = 'res-1'; roleId = 'r1' }) -UserIds @() -GroupId 'g1'
        @($rows).Count | Should -Be 0
    }
}

Describe 'ConvertTo-EntraRoleResourceRecord' {

    It 'maps a roleDefinition to an EntraRole and flattens + dedups allowedResourceActions' {
        $rd = [pscustomobject]@{
            id = 'rd1'; displayName = 'Global Administrator'; description = 'd'; isEnabled = $true
            templateId = 't1'; isBuiltIn = $true; version = '1'
            rolePermissions = @(
                [pscustomobject]@{ allowedResourceActions = @('a/read', 'a/write') }
                [pscustomobject]@{ allowedResourceActions = @('a/read', 'b/read') }   # a/read duplicated
            )
        }
        $rec = ConvertTo-EntraRoleResourceRecord -RoleDefinition $rd
        $rec['resourceType'] | Should -Be 'EntraRole'
        $rec['enabled']      | Should -BeTrue
        @($rec['extendedAttributes']['allowedResourceActions']).Count | Should -Be 3
        $rec['extendedAttributes']['permissionCount'] | Should -Be 3
        $rec['extendedAttributes']['isBuiltIn']       | Should -BeTrue
    }
}

Describe 'ConvertTo-EntraDirectoryRoleAssignment' {

    It 'maps an active assignment to a Direct EntraRole assignment with resolved principalType' {
        $ra = [pscustomobject]@{ id = 'ra1'; roleDefinitionId = 'rd1'; principalId = 'u1'; directoryScopeId = '/'; principal = [pscustomobject]@{ '@odata.type' = '#microsoft.graph.user' } }
        $rec = ConvertTo-EntraDirectoryRoleAssignment -RoleAssignment $ra
        $rec['resourceId']     | Should -Be 'rd1'
        $rec['assignmentType'] | Should -Be 'Direct'
        $rec['resourceType']   | Should -Be 'EntraRole'
        $rec['principalType']  | Should -Be 'User'
        $rec['extendedAttributes']['roleAssignmentId'] | Should -Be 'ra1'
    }

    It 'resolves a servicePrincipal principal type' {
        $ra = [pscustomobject]@{ id = 'ra2'; roleDefinitionId = 'rd1'; principalId = 'sp1'; principal = [pscustomobject]@{ '@odata.type' = '#microsoft.graph.servicePrincipal' } }
        (ConvertTo-EntraDirectoryRoleAssignment -RoleAssignment $ra)['principalType'] | Should -Be 'ServicePrincipal'
    }

    It 'returns $null when principal or role is missing' {
        ConvertTo-EntraDirectoryRoleAssignment -RoleAssignment ([pscustomobject]@{ roleDefinitionId = 'rd1' }) | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-EntraDirectoryRoleEligibility' {

    It 'maps an eligibility instance to an Eligible EntraRole assignment carrying expiry' {
        $e = [pscustomobject]@{ roleDefinitionId = 'rd1'; principalId = 'u1'; endDateTime = '2026-12-31T00:00:00Z'; memberType = 'Direct'; directoryScopeId = '/'; principal = [pscustomobject]@{ '@odata.type' = '#microsoft.graph.user' } }
        $rec = ConvertTo-EntraDirectoryRoleEligibility -Eligibility $e
        $rec['assignmentType']     | Should -Be 'Eligible'
        $rec['resourceType']       | Should -Be 'EntraRole'
        $rec['expirationDateTime'] | Should -Be '2026-12-31T00:00:00Z'
        $rec['extendedAttributes']['memberType'] | Should -Be 'Direct'
    }

    It 'returns $null when principal or role is missing' {
        ConvertTo-EntraDirectoryRoleEligibility -Eligibility ([pscustomobject]@{ principalId = 'u1' }) | Should -BeNullOrEmpty
    }
}
