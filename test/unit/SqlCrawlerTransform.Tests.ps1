#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/sql/SqlCrawler.Transform.ps1 — the pure
    row -> ingest-record shapers and the column contract behind them.

.DESCRIPTION
    No mocks: every function takes its input as a parameter and returns a record,
    so these run on in-memory rows. The inputs are chosen to DISCRIMINATE: the
    contract's matching rule (case- and underscore-insensitive), the fallback
    chains, the enabled/inactive inversion, and which columns must and must not
    reach extendedAttributes.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerTransform.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $sqlDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'sql'
    . (Join-Path $sqlDir 'SqlCrawler.Functions.ps1')   # $script:SqlPrincipalTypes
    . (Join-Path $sqlDir 'SqlCrawler.Transform.ps1')

    # A row + its resolved map, the way a phase builds them from a result set.
    function New-Row {
        param([hashtable]$Cells, [string]$Target)
        $row = [ordered]@{}
        foreach ($k in $Cells.Keys) { $row[$k] = $Cells[$k] }
        return @{ Row = $row; Map = (Resolve-SqlColumnMap -Columns @($row.Keys) -Target $Target) }
    }
    $script:IdentSlot = @{ principalType = 'User' }
    $script:ResSlot   = @{ resourceType = 'Entitlement' }
    $script:AsgnSlot  = @{ assignmentType = 'Direct'; resourceType = 'Entitlement'; governed = $false }
    $script:RelSlot   = @{ relationshipType = 'Contains' }
}

Describe 'ConvertTo-SqlColumnKey' {
    It 'lower-cases and drops underscores so the three spellings collide' {
        ConvertTo-SqlColumnKey 'display_name' | Should -Be 'displayname'
        ConvertTo-SqlColumnKey 'DisplayName'  | Should -Be 'displayname'
        ConvertTo-SqlColumnKey 'DISPLAY_NAME' | Should -Be 'displayname'
    }
    It 'leaves an unrelated name distinct' {
        ConvertTo-SqlColumnKey 'display_names' | Should -Not -Be (ConvertTo-SqlColumnKey 'display_name')
    }
}

Describe 'Resolve-SqlColumnMap' {
    It 'matches contract columns whatever their spelling and records the actual names' {
        $m = Resolve-SqlColumnMap -Columns @('ID', 'Display_Name', 'E_Mail', 'job_title') -Target 'identities'
        $m.id | Should -Be 'ID'
        $m.displayName | Should -Be 'Display_Name'
        $m.jobTitle | Should -Be 'job_title'
        # E_Mail normalises to 'email' and IS a contract column
        $m.email | Should -Be 'E_Mail'
        $m._extended | Should -BeNullOrEmpty
    }

    It 'sends every non-core column to _extended, and keeps aux columns in BOTH roles' {
        $m = Resolve-SqlColumnMap -Columns @('id', 'name', 'inactive', 'hiredate', 'costcenter') -Target 'identities'
        # `name` and `inactive` are consumed as fallbacks/flags but still carry source detail
        $m.name | Should -Be 'name'
        $m.inactive | Should -Be 'inactive'
        @($m._extended) | Should -Be @('name', 'inactive', 'hiredate', 'costcenter')
    }

    It 'resolves a duplicate spelling to the first column in order' {
        (Resolve-SqlColumnMap -Columns @('ID', 'id') -Target 'resources').id | Should -Be 'ID'
    }

    It 'leaves an absent contract column unset rather than guessing' {
        $m = Resolve-SqlColumnMap -Columns @('somethingelse') -Target 'resources'
        $m.ContainsKey('id') | Should -BeFalse
        @($m._extended) | Should -Be @('somethingelse')
    }

    It 'uses a different contract per target: id is core for resources, not for assignments' {
        (Resolve-SqlColumnMap -Columns @('id') -Target 'resources')._extended | Should -BeNullOrEmpty
        @((Resolve-SqlColumnMap -Columns @('id') -Target 'assignments')._extended) | Should -Be @('id')
    }

    It 'throws for a target with no contract' {
        { Resolve-SqlColumnMap -Columns @('id') -Target 'nonsense' } | Should -Throw '*No column contract*'
    }

    Context 'operator column overrides (-ColumnMap)' {
        It 'satisfies a required contract column from a differently-named source column' {
            # The motivating case: SailPoint SQL aliased as IdentityID / EntitlementID,
            # used verbatim instead of being rewritten with contract aliases.
            $m = Resolve-SqlColumnMap -Columns @('IdentityID', 'EntitlementID') -Target 'assignments' `
                -ColumnMap @{ IdentityID = 'principalId'; EntitlementID = 'resourceId' }
            $m.principalId | Should -Be 'IdentityID'
            $m.resourceId | Should -Be 'EntitlementID'
            # both are now consumed, so neither is duplicated into extendedAttributes
            $m._extended | Should -BeNullOrEmpty
        }

        It 'matches the source column case- and underscore-insensitively, like every other column' {
            $m = Resolve-SqlColumnMap -Columns @('entitlement_id') -Target 'resources' -ColumnMap @{ EntitlementID = 'id' }
            $m.id | Should -Be 'entitlement_id'
        }

        It 'lets an override win over a same-named column the result set already carries' {
            $m = Resolve-SqlColumnMap -Columns @('id', 'RoleID') -Target 'resources' -ColumnMap @{ RoleID = 'id' }
            $m.id | Should -Be 'RoleID'
            # the shadowed column is no longer a contract column, so it is source detail
            @($m._extended) | Should -Be @('id')
        }

        It 'ignores an override naming a column the result set does not have' {
            $m = Resolve-SqlColumnMap -Columns @('RoleID') -Target 'resources' -ColumnMap @{ Missing = 'id' }
            $m.ContainsKey('id') | Should -BeFalse
            @($m._extended) | Should -Be @('RoleID')
        }

        It 'maps an aux column too, so a source flag can drive account state' {
            $m = Resolve-SqlColumnMap -Columns @('SuspendedFlag') -Target 'principals' -ColumnMap @{ SuspendedFlag = 'disabled' }
            $m.disabled | Should -Be 'SuspendedFlag'
        }

        It 'behaves exactly as before when no override is supplied' {
            $withEmpty = Resolve-SqlColumnMap -Columns @('id', 'x') -Target 'resources' -ColumnMap @{}
            $without   = Resolve-SqlColumnMap -Columns @('id', 'x') -Target 'resources'
            $withEmpty.id | Should -Be $without.id
            @($withEmpty._extended) | Should -Be @($without._extended)
        }
    }
}

Describe 'Shapers with operator column overrides' {
    It 'shapes an assignment from the user\''s own SailPoint column names, unaltered' {
        $row = New-Row -Cells @{ IdentityID = 'u1'; EntitlementID = 'e1' } -Target 'assignments'
        $map = Resolve-SqlColumnMap -Columns @('IdentityID', 'EntitlementID') -Target 'assignments' `
            -ColumnMap @{ IdentityID = 'principalId'; EntitlementID = 'resourceId' }
        $rec = ConvertTo-SqlAssignmentRecord -Row $row.Row -Map $map -Slot $script:AsgnSlot
        $rec | Should -Not -BeNull
        $rec.principalExternalId | Should -Be 'u1'
        $rec.resourceExternalId | Should -Be 'e1'
    }

    It 'shapes a business role from RoleID / RoleDisplayName without touching the SQL' {
        $cells = @{ RoleID = 'b1'; RoleName = 'finance-role'; RoleDisplayName = 'Finance Role'; RoleType = 'business' }
        $row = New-Row -Cells $cells -Target 'resources'
        $map = Resolve-SqlColumnMap -Columns @($row.Row.Keys) -Target 'resources' `
            -ColumnMap @{ RoleID = 'id'; RoleDisplayName = 'displayName' }
        $rec = ConvertTo-SqlResourceRecord -Row $row.Row -Map $map -Slot @{ resourceType = 'BusinessRole' }
        $rec.externalId | Should -Be 'b1'
        $rec.displayName | Should -Be 'Finance Role'
        $rec.governanceResource | Should -BeTrue
        # unmapped columns still carry through as source detail
        $rec.extendedAttributes.RoleType | Should -Be 'business'
    }

    It 'without the override the same row is skipped — which is what the mapping exists to prevent' {
        $row = New-Row -Cells @{ IdentityID = 'u1'; EntitlementID = 'e1' } -Target 'assignments'
        ConvertTo-SqlAssignmentRecord -Row $row.Row -Map $row.Map -Slot $script:AsgnSlot | Should -BeNull
    }
}

Describe 'ConvertTo-SqlBoolean' {
    It 'reads the true spellings' {
        foreach ($v in @($true, 1, '1', 'Y', 'y', 'true', 'TRUE', 'yes', 't')) { ConvertTo-SqlBoolean -Value $v | Should -BeTrue -Because "'$v' means true" }
    }
    It 'reads the false spellings' {
        foreach ($v in @($false, 0, '0', 'N', 'no', 'false', 'f')) { ConvertTo-SqlBoolean -Value $v -Default $true | Should -BeFalse -Because "'$v' means false" }
    }
    It 'falls back to the default for NULL, blank or an unrecognised value' {
        ConvertTo-SqlBoolean -Value $null -Default $true | Should -BeTrue
        ConvertTo-SqlBoolean -Value '' -Default $true | Should -BeTrue
        ConvertTo-SqlBoolean -Value 'maybe' -Default $false | Should -BeFalse
        ConvertTo-SqlBoolean -Value 'maybe' -Default $true | Should -BeTrue
    }
    It 'treats any non-zero number as true' {
        ConvertTo-SqlBoolean -Value 2 | Should -BeTrue
        ConvertTo-SqlBoolean -Value ([decimal]0) -Default $true | Should -BeFalse
    }
}

Describe 'Get-SqlEnabledFlag' {
    It 'defaults to enabled when the row carries no flag at all' {
        $r = New-Row -Cells @{ id = 'u1' } -Target 'principals'
        Get-SqlEnabledFlag -Row $r.Row -Map $r.Map | Should -BeTrue
    }
    It 'reads a positive flag directly' {
        foreach ($col in 'enabled', 'active') {
            $on  = New-Row -Cells @{ id = 'u1'; $col = 0 } -Target 'principals'
            $off = New-Row -Cells @{ id = 'u1'; $col = 1 } -Target 'principals'
            Get-SqlEnabledFlag -Row $on.Row  -Map $on.Map  | Should -BeFalse -Because "$col=0 is disabled"
            Get-SqlEnabledFlag -Row $off.Row -Map $off.Map | Should -BeTrue
        }
    }
    It 'INVERTS a negative flag — inactive=1 is disabled, inactive=0 is enabled' {
        foreach ($col in 'inactive', 'disabled') {
            $a = New-Row -Cells @{ id = 'u1'; $col = 1 } -Target 'principals'
            $b = New-Row -Cells @{ id = 'u1'; $col = 0 } -Target 'principals'
            Get-SqlEnabledFlag -Row $a.Row -Map $a.Map | Should -BeFalse -Because "$col=1 means disabled"
            Get-SqlEnabledFlag -Row $b.Row -Map $b.Map | Should -BeTrue
        }
    }
    It 'prefers the positive flag when a row carries both' {
        $r = New-Row -Cells @{ id = 'u1'; enabled = 1; inactive = 1 } -Target 'principals'
        Get-SqlEnabledFlag -Row $r.Row -Map $r.Map | Should -BeTrue
    }
    It 'ignores a NULL flag and falls through to the next one' {
        $r = New-Row -Cells @{ id = 'u1'; enabled = $null; inactive = 1 } -Target 'principals'
        Get-SqlEnabledFlag -Row $r.Row -Map $r.Map | Should -BeFalse
    }
}

Describe 'Get-SqlDisplayName' {
    It 'walks displayName -> fallbacks -> id, skipping blank and whitespace-only values' {
        $full = New-Row -Cells @{ id = 'u1'; displayName = ' Ann Smith '; name = 'asmith'; userId = 'u-1' } -Target 'principals'
        Get-SqlDisplayName -Row $full.Row -Map $full.Map -Fallbacks @('name', 'userId') -Id 'u1' | Should -Be 'Ann Smith'
        $blank = New-Row -Cells @{ id = 'u1'; displayName = '   '; name = 'asmith' } -Target 'principals'
        Get-SqlDisplayName -Row $blank.Row -Map $blank.Map -Fallbacks @('name', 'userId') -Id 'u1' | Should -Be 'asmith'
        $second = New-Row -Cells @{ id = 'u1'; name = $null; userId = 'u-1' } -Target 'principals'
        Get-SqlDisplayName -Row $second.Row -Map $second.Map -Fallbacks @('name', 'userId') -Id 'u1' | Should -Be 'u-1'
        $none = New-Row -Cells @{ id = 'u1' } -Target 'principals'
        Get-SqlDisplayName -Row $none.Row -Map $none.Map -Fallbacks @('name', 'userId') -Id 'u1' | Should -Be 'u1'
    }
}

Describe 'Get-SqlPrincipalType' {
    It 'takes a legal value from the row over the slot default' {
        $r = New-Row -Cells @{ id = 'sp1'; principalType = 'ServicePrincipal' } -Target 'principals'
        Get-SqlPrincipalType -Row $r.Row -Map $r.Map -Default 'User' | Should -Be 'ServicePrincipal'
    }
    It 'ignores an illegal or absent value and uses the slot default' {
        $bad = New-Row -Cells @{ id = 'x'; principalType = 'Robot' } -Target 'principals'
        Get-SqlPrincipalType -Row $bad.Row -Map $bad.Map -Default 'ExternalUser' | Should -Be 'ExternalUser'
        $none = New-Row -Cells @{ id = 'x' } -Target 'principals'
        Get-SqlPrincipalType -Row $none.Row -Map $none.Map -Default 'AIAgent' | Should -Be 'AIAgent'
    }
}

Describe 'ConvertTo-SqlIdentityRecord / ConvertTo-SqlPrincipalRecord' {
    BeforeAll {
        $script:PersonCells = [ordered]@{
            id = ' i1 '; display_name = 'Ann Smith'; email = 'ann@x.test'; givenName = 'Ann'; surname = 'Smith'
            department = 'HR'; job_title = 'Analyst'; companyname = 'Acme'; employee_id = 'E42'
            inactive = 0; hiredate = '2020-01-01'; costcenter = 'CC1'
        }
    }

    It 'maps the contract columns onto the identity and everything else to extendedAttributes' {
        $r = New-Row -Cells $script:PersonCells -Target 'identities'
        $rec = ConvertTo-SqlIdentityRecord -Row $r.Row -Map $r.Map
        $rec.externalId | Should -Be 'i1'        # trimmed
        $rec.displayName | Should -Be 'Ann Smith'
        $rec.email | Should -Be 'ann@x.test'
        $rec.givenName | Should -Be 'Ann'
        $rec.surname | Should -Be 'Smith'
        $rec.department | Should -Be 'HR'
        $rec.jobTitle | Should -Be 'Analyst'
        $rec.companyName | Should -Be 'Acme'
        $rec.employeeId | Should -Be 'E42'
        $rec.extendedAttributes.hiredate | Should -Be '2020-01-01'
        $rec.extendedAttributes.costcenter | Should -Be 'CC1'
        $rec.extendedAttributes.inactive | Should -Be 0
        # a contract column must NOT be duplicated into extendedAttributes
        $rec.extendedAttributes.Contains('email') | Should -BeFalse
        $rec.extendedAttributes.Contains('id') | Should -BeFalse
        # an identity carries no account state
        $rec.Contains('accountEnabled') | Should -BeFalse
        $rec.Contains('principalType') | Should -BeFalse
    }

    It 'the principal built from the same row adds the account state and keeps the shared id' {
        $r = New-Row -Cells $script:PersonCells -Target 'identities'
        $rec = ConvertTo-SqlPrincipalRecord -Row $r.Row -Map $r.Map -Slot $script:IdentSlot
        $rec.externalId | Should -Be 'i1'
        $rec.principalType | Should -Be 'User'
        $rec.accountEnabled | Should -BeTrue      # inactive = 0
        $rec.jobTitle | Should -Be 'Analyst'
    }

    It 'omits a person field that is NULL or empty rather than sending an empty string' {
        $r = New-Row -Cells @{ id = 'i2'; displayName = 'B'; email = $null; department = '' } -Target 'identities'
        $rec = ConvertTo-SqlIdentityRecord -Row $r.Row -Map $r.Map
        $rec.Contains('email') | Should -BeFalse
        $rec.Contains('department') | Should -BeFalse
    }

    It 'omits extendedAttributes entirely when every column is a contract column' {
        $r = New-Row -Cells @{ id = 'i3'; displayName = 'C' } -Target 'identities'
        (ConvertTo-SqlIdentityRecord -Row $r.Row -Map $r.Map).Contains('extendedAttributes') | Should -BeFalse
    }

    It 'skips a row with no id, or an id that is blank' {
        foreach ($id in @($null, '', '   ')) {
            $r = New-Row -Cells @{ id = $id; displayName = 'X' } -Target 'identities'
            ConvertTo-SqlIdentityRecord -Row $r.Row -Map $r.Map | Should -BeNull
            ConvertTo-SqlPrincipalRecord -Row $r.Row -Map $r.Map -Slot $script:IdentSlot | Should -BeNull
        }
    }

    It 'takes the row principalType over the slot default on a principals row' {
        $r = New-Row -Cells @{ id = 'sp1'; displayName = 'Svc'; principalType = 'ServicePrincipal' } -Target 'principals'
        (ConvertTo-SqlPrincipalRecord -Row $r.Row -Map $r.Map -Slot @{ principalType = 'User' }).principalType | Should -Be 'ServicePrincipal'
    }
}

Describe 'Identity member records' {
    It 'links an identity to its own account as the primary, by external id' {
        $rec = New-SqlIdentityMemberRecord -IdentityId 'i1' -PrincipalId 'i1'
        $rec.identityExternalId | Should -Be 'i1'
        $rec.principalExternalId | Should -Be 'i1'
        $rec.isPrimary | Should -BeTrue
        $rec.accountType | Should -Be 'Primary'
        # never a UUID field — the API derives those from the external ids
        $rec.Contains('identityId') | Should -BeFalse
    }

    It 'maps an identity-members row, defaulting isPrimary and accountType' {
        $r = New-Row -Cells @{ identity_id = 'i1'; principal_id = ' a1 ' } -Target 'identity-members'
        $rec = ConvertTo-SqlIdentityMemberRecord -Row $r.Row -Map $r.Map
        $rec.identityExternalId | Should -Be 'i1'
        $rec.principalExternalId | Should -Be 'a1'
        $rec.isPrimary | Should -BeTrue
        $rec.accountType | Should -Be 'Primary'
    }

    It 'honours explicit isPrimary and accountType columns' {
        $r = New-Row -Cells @{ identityId = 'i1'; principalId = 'a2'; isPrimary = 'N'; accountType = 'Secondary' } -Target 'identity-members'
        $rec = ConvertTo-SqlIdentityMemberRecord -Row $r.Row -Map $r.Map
        $rec.isPrimary | Should -BeFalse
        $rec.accountType | Should -Be 'Secondary'
    }

    It 'skips a row missing either side' {
        foreach ($cells in @(@{ identityId = 'i1' }, @{ principalId = 'a1' }, @{ identityId = ''; principalId = 'a1' })) {
            $r = New-Row -Cells $cells -Target 'identity-members'
            ConvertTo-SqlIdentityMemberRecord -Row $r.Row -Map $r.Map | Should -BeNull
        }
    }
}

Describe 'ConvertTo-SqlResourceRecord' {
    It 'takes resourceType from the slot, not the row, and falls back displayName -> name -> id' {
        $r = New-Row -Cells @{ id = 'e1'; name = 'AD-Sales'; resourceType = 'IgnoreMe' } -Target 'resources'
        $rec = ConvertTo-SqlResourceRecord -Row $r.Row -Map $r.Map -Slot $script:ResSlot
        $rec.externalId | Should -Be 'e1'
        $rec.displayName | Should -Be 'AD-Sales'
        $rec.resourceType | Should -Be 'Entitlement'
        # the row's own resourceType column is not a contract column — it is source detail
        $rec.extendedAttributes.resourceType | Should -Be 'IgnoreMe'
        $rec.enabled | Should -BeTrue
        $rec.Contains('governanceResource') | Should -BeFalse
    }

    It 'flags a BusinessRole slot as a governance resource' {
        $r = New-Row -Cells @{ id = 'b1'; displayName = 'Finance role' } -Target 'resources'
        (ConvertTo-SqlResourceRecord -Row $r.Row -Map $r.Map -Slot @{ resourceType = 'BusinessRole' }).governanceResource | Should -BeTrue
    }

    It 'carries a description only when the row has one, and reads the disabled flag' {
        $with = New-Row -Cells @{ id = 'e2'; displayName = 'E2'; description = 'desc'; disabled = 1 } -Target 'resources'
        $rec = ConvertTo-SqlResourceRecord -Row $with.Row -Map $with.Map -Slot $script:ResSlot
        $rec.description | Should -Be 'desc'
        $rec.enabled | Should -BeFalse
        $without = New-Row -Cells @{ id = 'e3'; displayName = 'E3'; description = '' } -Target 'resources'
        (ConvertTo-SqlResourceRecord -Row $without.Row -Map $without.Map -Slot $script:ResSlot).Contains('description') | Should -BeFalse
    }

    It 'skips a row with no id' {
        $r = New-Row -Cells @{ displayName = 'orphan' } -Target 'resources'
        ConvertTo-SqlResourceRecord -Row $r.Row -Map $r.Map -Slot $script:ResSlot | Should -BeNull
    }
}

Describe 'ConvertTo-SqlAssignmentRecord' {
    It 'emits an external-id assignment carrying the slot constants' {
        $r = New-Row -Cells @{ principal_id = ' u1 '; resource_id = ' e1 '; idx = 3 } -Target 'assignments'
        $rec = ConvertTo-SqlAssignmentRecord -Row $r.Row -Map $r.Map -Slot $script:AsgnSlot
        $rec.principalExternalId | Should -Be 'u1'
        $rec.resourceExternalId | Should -Be 'e1'
        $rec.assignmentType | Should -Be 'Direct'
        $rec.resourceType | Should -Be 'Entitlement'
        $rec.governed | Should -BeFalse
        $rec.extendedAttributes.idx | Should -Be 3
    }

    It 'accepts identityId as the principal side (an identity row and its account share an id)' {
        $r = New-Row -Cells @{ identityId = 'i1'; resourceId = 'b1' } -Target 'assignments'
        (ConvertTo-SqlAssignmentRecord -Row $r.Row -Map $r.Map -Slot $script:AsgnSlot).principalExternalId | Should -Be 'i1'
    }

    It 'prefers principalId when the row has both' {
        $r = New-Row -Cells @{ principalId = 'p1'; identityId = 'i1'; resourceId = 'b1' } -Target 'assignments'
        (ConvertTo-SqlAssignmentRecord -Row $r.Row -Map $r.Map -Slot $script:AsgnSlot).principalExternalId | Should -Be 'p1'
    }

    It 'carries a governed Eligible slot through verbatim' {
        $r = New-Row -Cells @{ principalId = 'u1'; resourceId = 'b1' } -Target 'assignments'
        $rec = ConvertTo-SqlAssignmentRecord -Row $r.Row -Map $r.Map -Slot @{ assignmentType = 'Eligible'; resourceType = 'BusinessRole'; governed = $true }
        $rec.assignmentType | Should -Be 'Eligible'
        $rec.governed | Should -BeTrue
        $rec.resourceType | Should -Be 'BusinessRole'
    }

    It 'skips a row missing either side' {
        foreach ($cells in @(@{ resourceId = 'e1' }, @{ principalId = 'u1' }, @{ principalId = ' '; resourceId = 'e1' })) {
            $r = New-Row -Cells $cells -Target 'assignments'
            ConvertTo-SqlAssignmentRecord -Row $r.Row -Map $r.Map -Slot $script:AsgnSlot | Should -BeNull
        }
    }

    It 'never emits an assignmentType outside the universal set' {
        foreach ($t in @('Direct', 'Indirect', 'Eligible')) {
            $r = New-Row -Cells @{ principalId = 'u1'; resourceId = 'e1' } -Target 'assignments'
            (ConvertTo-SqlAssignmentRecord -Row $r.Row -Map $r.Map -Slot @{ assignmentType = $t; resourceType = 'Entitlement'; governed = $false }).assignmentType |
                Should -BeIn @('Direct', 'Indirect', 'Eligible')
        }
    }
}

Describe 'ConvertTo-SqlRelationshipRecord' {
    It 'emits a Contains edge by external id with the source detail attached' {
        $r = New-Row -Cells @{ parent_id = 'b1'; child_id = 'e1'; display_value = 'AD-Sales' } -Target 'relationships'
        $rec = ConvertTo-SqlRelationshipRecord -Row $r.Row -Map $r.Map -Slot $script:RelSlot
        $rec.parentExternalId | Should -Be 'b1'
        $rec.childExternalId | Should -Be 'e1'
        $rec.relationshipType | Should -Be 'Contains'
        $rec.extendedAttributes.display_value | Should -Be 'AD-Sales'
    }
    It 'takes the relationship type from the slot' {
        $r = New-Row -Cells @{ parentId = 'b1'; childId = 'e1' } -Target 'relationships'
        (ConvertTo-SqlRelationshipRecord -Row $r.Row -Map $r.Map -Slot @{ relationshipType = 'GrantsAccessTo' }).relationshipType | Should -Be 'GrantsAccessTo'
    }
    It 'skips a row missing either end' {
        foreach ($cells in @(@{ parentId = 'b1' }, @{ childId = 'e1' }, @{ parentId = 'b1'; childId = '' })) {
            $r = New-Row -Cells $cells -Target 'relationships'
            ConvertTo-SqlRelationshipRecord -Row $r.Row -Map $r.Map -Slot $script:RelSlot | Should -BeNull
        }
    }
}
