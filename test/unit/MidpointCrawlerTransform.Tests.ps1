#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the pure record-shaping functions extracted into
    tools/crawlers/midpoint/MidpointCrawler.Transform.ps1.

.DESCRIPTION
    Covers the per-object mapping logic moved verbatim out of
    Start-MidpointCrawler.ps1's phase bodies. These are pure (no HTTP, no
    script-scope writes), so they run against in-memory midPoint fixtures with no
    mocks. Get-MidpointString / Test-MidpointEnabled come from Invoke-MidpointApi.ps1.

.USAGE
    Invoke-Pester -Path test/unit/MidpointCrawlerTransform.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:midpointDir = Join-Path $script:repoRoot 'tools\crawlers\midpoint'

    # midPoint pure helpers used by the transforms (Get-MidpointString,
    # Test-MidpointEnabled, Format-AccountLabel, ...).
    . (Join-Path $script:midpointDir 'Invoke-MidpointApi.ps1')
    # The unit under test.
    . (Join-Path $script:midpointDir 'MidpointCrawler.Transform.ps1')

    # Get-MidpointShadowLabel (MidpointCrawler.Functions.ps1) builds a label from
    # cross-phase script state; stub it so the account-shadow transform stays
    # hermetic. The stub echoes the inputs so the wiring can be asserted.
    function Get-MidpointShadowLabel {
        param($Shadow, $ShadowOid, $ResourceOid)
        "label:$($Shadow.name)@$ResourceOid"
    }
}

Describe 'ConvertTo-MidpointIdentityRecord' {

    It 'maps a user to an identity record, coercing midPoint string fields' {
        $u = [pscustomobject]@{
            oid = 'oid-1'; givenName = 'Alice'; familyName = 'Smith'; emailAddress = 'alice@x.com'
            employeeNumber = 'E1'; title = 'Engineer'; name = 'asmith'; lifecycleState = 'active'
        }
        $rec = ConvertTo-MidpointIdentityRecord -User $u -DisplayName 'Alice Smith' -Department 'IT'
        $rec.id          | Should -Be 'oid-1'
        $rec.externalId  | Should -Be 'oid-1'
        $rec.displayName | Should -Be 'Alice Smith'
        $rec.givenName   | Should -Be 'Alice'
        $rec.surname     | Should -Be 'Smith'
        $rec.email       | Should -Be 'alice@x.com'
        $rec.employeeId  | Should -Be 'E1'
        $rec.department  | Should -Be 'IT'
        $rec.extendedAttributes.name           | Should -Be 'asmith'
        $rec.extendedAttributes.lifecycleState | Should -Be 'active'
    }

    It 'falls back to empty strings for absent fields' {
        $rec = ConvertTo-MidpointIdentityRecord -User ([pscustomobject]@{ oid = 'oid-2' }) -DisplayName 'X'
        $rec.givenName  | Should -Be ''
        $rec.email      | Should -Be ''
        $rec.employeeId | Should -Be ''
    }
}

Describe 'ConvertTo-MidpointFocusPrincipalRecord' {

    It 'maps a user to a focus principal carrying principalType and the focus source flag' {
        $u = [pscustomobject]@{ oid = 'oid-1'; emailAddress = 'a@x.com'; title = 'Eng'; name = 'asmith'; activation = [pscustomobject]@{ effectiveStatus = 'enabled' } }
        $rec = ConvertTo-MidpointFocusPrincipalRecord -User $u -DisplayName 'Alice' -Department 'IT' -PrincipalType 'User'
        $rec.id             | Should -Be 'oid-1'
        $rec.principalType  | Should -Be 'User'
        $rec.accountEnabled | Should -BeTrue
        $rec.department     | Should -Be 'IT'
        $rec.extendedAttributes.source | Should -Be 'midpoint-focus'
    }

    It 'marks accountEnabled false when activation is disabled' {
        $u = [pscustomobject]@{ oid = 'oid-3'; activation = [pscustomobject]@{ effectiveStatus = 'disabled' } }
        (ConvertTo-MidpointFocusPrincipalRecord -User $u -DisplayName 'D' -PrincipalType 'User').accountEnabled | Should -BeFalse
    }
}

Describe 'New-MidpointIdentityMemberRecord' {

    It 'builds a primary identity-member link keyed on the user OID' {
        $rec = New-MidpointIdentityMemberRecord -Oid 'oid-9'
        $rec.identityId  | Should -Be 'oid-9'
        $rec.principalId | Should -Be 'oid-9'
        $rec.accountType | Should -Be 'Primary'
        $rec.isPrimary   | Should -BeTrue
    }
}

Describe 'ConvertTo-MidpointOrgContextRecord' {

    It 'maps an org to a synced context, defaulting contextType to OrgUnit and resolving the parent ref' {
        $org = [pscustomobject]@{ oid = 'org-1'; displayName = 'Sales'; parentOrgRef = [pscustomobject]@{ oid = 'org-root' } }
        $rec = ConvertTo-MidpointOrgContextRecord -Org $org -OrgContextMapping @() -SystemId 7
        $rec.id              | Should -Be 'org-1'
        $rec.displayName     | Should -Be 'Sales'
        $rec.contextType     | Should -Be 'OrgUnit'
        $rec.variant         | Should -Be 'synced'
        $rec.targetType      | Should -Be 'Identity'
        $rec.scopeSystemId   | Should -Be 7
        $rec.parentContextId | Should -Be 'org-root'
    }

    It 'leaves parentContextId null for a root org' {
        $rec = ConvertTo-MidpointOrgContextRecord -Org ([pscustomobject]@{ oid = 'org-root'; name = 'Root' }) -SystemId 7
        $rec.parentContextId | Should -BeNullOrEmpty
    }
}

Describe 'Get-MidpointContextsInTopologicalOrder' {

    It 'orders parents before children regardless of input order' {
        $records = @(
            [pscustomobject]@{ id = 'c'; parentContextId = 'b' }
            [pscustomobject]@{ id = 'b'; parentContextId = 'a' }
            [pscustomobject]@{ id = 'a'; parentContextId = $null }
        )
        $sorted = Get-MidpointContextsInTopologicalOrder -Records $records
        ($sorted | ForEach-Object { $_.id }) -join '' | Should -Be 'abc'
    }

    It 'nulls out a parent that is outside the synced set (treats it as a root)' {
        $records = @([pscustomobject]@{ id = 'x'; parentContextId = 'not-synced' })
        $sorted = Get-MidpointContextsInTopologicalOrder -Records $records
        $sorted[0].parentContextId | Should -BeNullOrEmpty
    }

    It 'preserves parentContextId for a child whose parent IS in the synced set' {
        $records = @(
            [pscustomobject]@{ id = 'b'; parentContextId = 'a' }
            [pscustomobject]@{ id = 'a'; parentContextId = $null }
        )
        $sorted = Get-MidpointContextsInTopologicalOrder -Records $records
        ($sorted | Where-Object { $_.id -eq 'b' }).parentContextId | Should -Be 'a'
    }

    It 'returns an empty array for no records' {
        @(Get-MidpointContextsInTopologicalOrder -Records @()).Count | Should -Be 0
    }
}

Describe 'ConvertTo-MidpointRoleResourceRecord' {

    It 'maps a role to a Resource carrying the resolved type, archetype and governance flag' {
        $role = [pscustomobject]@{ oid = 'r-1'; displayName = 'Finance Approver'; description = 'd'; subtype = 'business'; identifier = 'FIN-APR' }
        $rec = ConvertTo-MidpointRoleResourceRecord -Role $role -ResourceType 'BusinessRole' -ArchetypeNames @('Business Role', 'Org')
        $rec.id                 | Should -Be 'r-1'
        $rec.resourceType       | Should -Be 'BusinessRole'
        $rec.governanceResource | Should -BeTrue
        $rec.displayName        | Should -Be 'Finance Approver'
        $rec.extendedAttributes.identifier | Should -Be 'FIN-APR'
        $rec.extendedAttributes.archetype  | Should -Be 'Business Role, Org'
    }

    It 'sets governanceResource = $false for a non-BusinessRole type' {
        $role = [pscustomobject]@{ oid = 'r-2'; name = 'app-role' }
        (ConvertTo-MidpointRoleResourceRecord -Role $role -ResourceType 'ApplicationRole').governanceResource | Should -BeFalse
    }
}

Describe 'ConvertTo-MidpointServiceResourceRecord' {

    It 'maps a service to a Service resource (no governance flag)' {
        $svc = [pscustomobject]@{ oid = 's-1'; displayName = 'Payroll'; description = 'd'; identifier = 'PAY'; activation = [pscustomobject]@{ effectiveStatus = 'enabled' } }
        $rec = ConvertTo-MidpointServiceResourceRecord -Service $svc
        $rec.id           | Should -Be 's-1'
        $rec.resourceType | Should -Be 'Service'
        $rec.enabled      | Should -BeTrue
        $rec.extendedAttributes.identifier | Should -Be 'PAY'
        $rec.PSObject.Properties.Name | Should -Not -Contain 'governanceResource'
    }
}

Describe 'ConvertTo-MidpointAccountShadowRecord' {

    It 'maps an account shadow to a User principal with the shadow label and ext attrs' {
        $s = [pscustomobject]@{ name = 'jdoe'; objectClass = 'inetOrgPerson'; intent = 'default'; activation = [pscustomobject]@{ effectiveStatus = 'enabled' } }
        $rec = ConvertTo-MidpointAccountShadowRecord -Shadow $s -ShadowOid 'sh-1' -ResourceOid 'res-ad' -Kind 'account'
        $rec.id             | Should -Be 'sh-1'
        $rec.principalType  | Should -Be 'User'
        $rec.accountEnabled | Should -BeTrue
        $rec.displayName    | Should -Be 'label:jdoe@res-ad'
        $rec.extendedAttributes.accountName | Should -Be 'jdoe'
        $rec.extendedAttributes.resourceOid | Should -Be 'res-ad'
        $rec.extendedAttributes.kind        | Should -Be 'account'
        $rec.extendedAttributes.source      | Should -Be 'midpoint-shadow'
    }
}

Describe 'ConvertTo-MidpointEntitlementResourceRecord' {

    It 'maps an entitlement shadow to an Entitlement resource' {
        $s = [pscustomobject]@{ name = 'CN=Finance,OU=Groups'; objectClass = 'group'; intent = 'default' }
        $rec = ConvertTo-MidpointEntitlementResourceRecord -Shadow $s -ShadowOid 'ent-1' -ResourceOid 'res-ad'
        $rec.id           | Should -Be 'ent-1'
        $rec.resourceType | Should -Be 'Entitlement'
        $rec.extendedAttributes.resourceOid | Should -Be 'res-ad'
        $rec.extendedAttributes.source      | Should -Be 'midpoint-entitlement'
    }
}

Describe 'New-MidpointEntitlementAssignmentRecord' {

    It 'builds a Direct entitlement assignment recording the source account' {
        $rec = New-MidpointEntitlementAssignmentRecord -EntitlementOid 'ent-1' -OwnerOid 'usr-1' -ViaAccount 'sh-9'
        $rec.resourceId     | Should -Be 'ent-1'
        $rec.principalId    | Should -Be 'usr-1'
        $rec.assignmentType | Should -Be 'Direct'
        $rec.resourceType   | Should -Be 'Entitlement'
        $rec.extendedAttributes.viaAccount | Should -Be 'sh-9'
    }
}

Describe 'New-MidpointGovernanceAssignmentRecord' {

    It 'builds a governed Direct assignment with the grant marker (direct)' {
        $rec = New-MidpointGovernanceAssignmentRecord -ResourceId 'r-1' -PrincipalId 'u-1' -ResourceType 'BusinessRole' -Grant 'direct'
        $rec.resourceId     | Should -Be 'r-1'
        $rec.principalId    | Should -Be 'u-1'
        $rec.assignmentType | Should -Be 'Direct'
        $rec.governed       | Should -BeTrue
        $rec.resourceType   | Should -Be 'BusinessRole'
        $rec.extendedAttributes.grant | Should -Be 'direct'
    }

    It 'carries grant = inherited for roleMembershipRef-derived links' {
        (New-MidpointGovernanceAssignmentRecord -ResourceId 'r-2' -PrincipalId 'u-2' -ResourceType 'Service' -Grant 'inherited').extendedAttributes.grant | Should -Be 'inherited'
    }
}

Describe 'New-MidpointContainsRelationship' {

    It 'builds a Contains relationship from parent to child resource' {
        $rec = New-MidpointContainsRelationship -ParentResourceId 'role-1' -ChildResourceId 'ent-1'
        $rec.parentResourceId | Should -Be 'role-1'
        $rec.childResourceId  | Should -Be 'ent-1'
        $rec.relationshipType | Should -Be 'Contains'
    }
}

Describe 'ConvertTo-MidpointCertificationDecision' {

    It 'maps a case to a decision, pulling the work-item comment and reviewer when synced' {
        $case = [pscustomobject]@{
            outcome = 'accept'
            workItem = [pscustomobject]@{ output = [pscustomobject]@{ comment = 'looks fine' }; assigneeRef = [pscustomobject]@{ oid = 'rev-1' } }
        }
        $rec = ConvertTo-MidpointCertificationDecision -Case $case -CaseKey 'camp-1|c-1' -CaseId 'c-1' `
            -PrincipalOid 'u-1' -TargetOid 'r-1' -CampaignName 'Q1 Review' -CampaignOid 'camp-1' -CampaignState 'inReview' `
            -UserOidToName @{ 'u-1' = 'Alice'; 'rev-1' = 'Bob' }
        $rec.resourceId             | Should -Be 'r-1'
        $rec.principalId            | Should -Be 'u-1'
        $rec.justification          | Should -Be 'looks fine'
        $rec.reviewInstanceStatus   | Should -Be 'inReview'
        $rec.principalDisplayName   | Should -Be 'Alice'
        $rec.reviewedBy             | Should -Be 'rev-1'
        $rec.reviewedByDisplayName  | Should -Be 'Bob'
        $rec.extendedAttributes.campaign | Should -Be 'Q1 Review'
        $rec.extendedAttributes.caseId   | Should -Be 'c-1'
    }

    It 'takes only the first work item from an array (a later item does not leak in)' {
        # The first work item has no output; a later one does. First-item-wins means the
        # comment stays empty — proving exactly one work item (the first) is consulted.
        $case = [pscustomobject]@{
            outcome  = 'accept'
            workItem = @(
                [pscustomobject]@{ assigneeRef = [pscustomobject]@{ oid = 'rev-1' } }
                [pscustomobject]@{ output = [pscustomobject]@{ comment = 'second reviewer note' }; assigneeRef = [pscustomobject]@{ oid = 'rev-2' } }
            )
        }
        $rec = ConvertTo-MidpointCertificationDecision -Case $case -CaseKey 'camp-1|c-3' -CaseId 'c-3' `
            -PrincipalOid 'u-1' -TargetOid 'r-1' -CampaignName 'Q1' -CampaignOid 'camp-1' -CampaignState 'inReview' `
            -UserOidToName @{ 'u-1' = 'Alice'; 'rev-1' = 'Bob'; 'rev-2' = 'Carol' }
        $rec.justification | Should -Be ''
        $rec.reviewedBy    | Should -Be 'rev-1'
    }

    It 'omits display names and reviewedBy when the OIDs are not synced principals' {
        $case = [pscustomobject]@{ outcome = 'revoke' }
        $rec = ConvertTo-MidpointCertificationDecision -Case $case -CaseKey 'camp-1|c-2' -CaseId 'c-2' `
            -PrincipalOid 'u-x' -TargetOid 'r-1' -CampaignName 'Q1' -CampaignOid 'camp-1' -CampaignState 'open' -UserOidToName @{}
        $rec.PSObject.Properties.Name | Should -Not -Contain 'principalDisplayName'
        $rec.PSObject.Properties.Name | Should -Not -Contain 'reviewedBy'
        $rec.justification | Should -Be ''
    }
}
