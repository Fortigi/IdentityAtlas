#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the pure record-shapers in
    tools/crawlers/scim/ScimCrawler.Transform.ps1.

.DESCRIPTION
    Every function under test is pure (no HTTP, no script-scope writes), so these
    run against in-memory SCIM fixtures with zero mocks. The fixtures are chosen to
    DISCRIMINATE — a user whose displayName differs from its userName, an emails
    array where the primary entry is not the first, a member id that exists in both
    id-sets, a nesting cycle — so a shaper that ignored the rule under test would
    produce a visibly different record rather than the same one by luck.

.USAGE
    Invoke-Pester -Path test/unit/ScimCrawlerTransform.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'scim' 'ScimCrawler.Transform.ps1')

    function New-IdSet {
        param([string[]]$Ids)
        $set = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($i in $Ids) { [void]$set.Add($i) }
        return $set
    }
}

Describe 'Get-ScimScalar' {
    It 'passes simple values through unchanged' {
        Get-ScimScalar 'hello' | Should -Be 'hello'
        Get-ScimScalar 42      | Should -Be 42
        Get-ScimScalar $true   | Should -Be $true
        Get-ScimScalar $false  | Should -Be $false
    }

    It 'returns $null for an empty string, so a blank attribute is not stored' {
        Get-ScimScalar '' | Should -BeNullOrEmpty
    }

    It 'returns $null for complex and multi-valued attributes (v1 stores simple values only)' {
        Get-ScimScalar ([pscustomobject]@{ value = 'x' })     | Should -BeNullOrEmpty
        Get-ScimScalar @('a', 'b')                            | Should -BeNullOrEmpty
        Get-ScimScalar $null                                  | Should -BeNullOrEmpty
    }
}

Describe 'Get-ScimPrimaryEmail' {
    It 'prefers the entry flagged primary even when it is not first' {
        $emails = @(
            [pscustomobject]@{ value = 'alias@x.com'; type = 'other' }
            [pscustomobject]@{ value = 'real@x.com';  primary = $true }
        )
        Get-ScimPrimaryEmail -Emails $emails | Should -Be 'real@x.com'
    }

    It 'falls back to the first entry that carries a value when none is primary' {
        $emails = @(
            [pscustomobject]@{ type = 'work' }              # no value — skipped
            [pscustomobject]@{ value = 'first@x.com' }
            [pscustomobject]@{ value = 'second@x.com' }
        )
        Get-ScimPrimaryEmail -Emails $emails | Should -Be 'first@x.com'
    }

    It 'accepts a plain string array (providers that flatten emails)' {
        Get-ScimPrimaryEmail -Emails @('flat@x.com') | Should -Be 'flat@x.com'
    }

    It 'returns $null when there is no usable email' {
        Get-ScimPrimaryEmail -Emails @()   | Should -BeNullOrEmpty
        Get-ScimPrimaryEmail -Emails $null | Should -BeNullOrEmpty
    }
}

Describe 'Get-ScimAttribute' {
    It 'reads a top-level attribute' {
        Get-ScimAttribute -Object ([pscustomobject]@{ department = 'IT' }) -Path 'department' | Should -Be 'IT'
    }

    It 'walks into a complex attribute with a dotted path' {
        $u = [pscustomobject]@{ name = [pscustomobject]@{ givenName = 'Alice' } }
        Get-ScimAttribute -Object $u -Path 'name.givenName' | Should -Be 'Alice'
    }

    It 'returns $null rather than throwing when a path segment is missing' {
        Get-ScimAttribute -Object ([pscustomobject]@{}) -Path 'name.givenName' | Should -BeNullOrEmpty
        Get-ScimAttribute -Object ([pscustomobject]@{}) -Path ''               | Should -BeNullOrEmpty
    }
}

Describe 'Get-ScimSelectedAttributes' {
    It 'copies only the selected attributes (opt-in)' {
        $u = [pscustomobject]@{ department = 'IT'; costCenter = 'CC1'; title = 'Engineer' }
        $out = Get-ScimSelectedAttributes -Object $u -Selected @('department')
        $out.Keys | Should -Be @('department')
        $out['department'] | Should -Be 'IT'
    }

    It 'returns nothing when nothing is selected' {
        $u = [pscustomobject]@{ department = 'IT' }
        (Get-ScimSelectedAttributes -Object $u -Selected @()).Count   | Should -Be 0
        (Get-ScimSelectedAttributes -Object $u -Selected $null).Count | Should -Be 0
    }

    It 'skips a selected attribute the object does not carry, and complex values' {
        $u = [pscustomobject]@{ department = 'IT'; emails = @([pscustomobject]@{ value = 'a@x' }) }
        $out = Get-ScimSelectedAttributes -Object $u -Selected @('department', 'missing', 'emails')
        $out.Count | Should -Be 1
        $out.ContainsKey('missing') | Should -BeFalse
        $out.ContainsKey('emails')  | Should -BeFalse
    }

    It 'resolves a dotted sub-attribute selection' {
        $u = [pscustomobject]@{ name = [pscustomobject]@{ middleName = 'Q' } }
        (Get-ScimSelectedAttributes -Object $u -Selected @('name.middleName'))['name.middleName'] | Should -Be 'Q'
    }
}

Describe 'Resolve-ScimPrincipalType' {
    # Declared in BeforeAll, not the Describe body: Pester 5 runs the Describe body
    # at DISCOVERY time in a different scope, so a variable set there is $null
    # inside every It — and a test asserting the default 'User' would then pass
    # while proving nothing.
    BeforeAll {
        $script:mapping = @(
            @{ userType = 'service'; principalType = 'ServicePrincipal' }
            @{ userType = 'guest';   principalType = 'ExternalUser' }
            @{ userType = '';        principalType = 'User' }
        )
    }

    It 'matches a userType exactly' {
        Resolve-ScimPrincipalType -UserType 'service' -Mapping $script:mapping | Should -Be 'ServicePrincipal'
        Resolve-ScimPrincipalType -UserType 'guest'   -Mapping $script:mapping | Should -Be 'ExternalUser'
    }

    It 'matches case-insensitively (SCIM userType casing is provider-defined)' {
        Resolve-ScimPrincipalType -UserType 'SERVICE' -Mapping $script:mapping | Should -Be 'ServicePrincipal'
    }

    It 'falls back to the blank catch-all row for an unmapped userType' {
        Resolve-ScimPrincipalType -UserType 'employee' -Mapping $script:mapping | Should -Be 'User'
    }

    It 'uses the catch-all even when it is not the last row' {
        $m = @( @{ userType = ''; principalType = 'ExternalUser' }, @{ userType = 'service'; principalType = 'ServicePrincipal' } )
        Resolve-ScimPrincipalType -UserType 'other'   -Mapping $m | Should -Be 'ExternalUser'
        Resolve-ScimPrincipalType -UserType 'service' -Mapping $m | Should -Be 'ServicePrincipal'
    }

    It 'defaults to User when there is no catch-all and no match' {
        $m = @( @{ userType = 'service'; principalType = 'ServicePrincipal' } )
        Resolve-ScimPrincipalType -UserType 'employee' -Mapping $m | Should -Be 'User'
        Resolve-ScimPrincipalType -UserType ''         -Mapping $m | Should -Be 'User'
        Resolve-ScimPrincipalType -UserType 'x'        -Mapping @() | Should -Be 'User'
    }

    It 'ignores a mapping row with no principalType instead of emitting a blank type' {
        $m = @( @{ userType = 'service'; principalType = '' }, @{ userType = ''; principalType = 'User' } )
        Resolve-ScimPrincipalType -UserType 'service' -Mapping $m | Should -Be 'User'
    }
}

Describe 'Get-ScimPrincipalTypeBuckets' {
    It 'always includes User so an unmapped account still reconciles' {
        Get-ScimPrincipalTypeBuckets -Mapping @() | Should -Be @('User')
    }

    It 'collects every distinct mapped principalType exactly once' {
        $m = @(
            @{ userType = 'a'; principalType = 'ServicePrincipal' }
            @{ userType = 'b'; principalType = 'ServicePrincipal' }
            @{ userType = 'c'; principalType = 'ExternalUser' }
            @{ userType = '';  principalType = 'User' }
        )
        (Get-ScimPrincipalTypeBuckets -Mapping $m) | Should -Be @('User', 'ServicePrincipal', 'ExternalUser')
    }
}

Describe 'ConvertTo-ScimPrincipalRecord' {
    BeforeAll {
        $script:mapping = @( @{ userType = 'service'; principalType = 'ServicePrincipal' }, @{ userType = ''; principalType = 'User' } )
    }

    It 'maps the always-synced core attributes' {
        $u = [pscustomobject]@{
            id = 'u-1'; userName = 'alice'; displayName = 'Alice Smith'; active = $true; userType = 'employee'
            emails = @([pscustomobject]@{ value = 'alice@x.com'; primary = $true })
            name = [pscustomobject]@{ givenName = 'Alice'; familyName = 'Smith' }
            title = 'Engineer'
        }
        $rec = ConvertTo-ScimPrincipalRecord -User $u -Mapping $script:mapping -SelectedAttributes @()
        $rec.externalId     | Should -Be 'u-1'
        $rec.displayName    | Should -Be 'Alice Smith'
        $rec.userName       | Should -Be 'alice'
        $rec.email          | Should -Be 'alice@x.com'
        $rec.givenName      | Should -Be 'Alice'
        $rec.surname        | Should -Be 'Smith'
        $rec.jobTitle       | Should -Be 'Engineer'
        $rec.principalType  | Should -Be 'User'
        $rec.accountEnabled | Should -BeTrue
    }

    It 'falls back to userName, then to the SCIM id, when displayName is absent' {
        $rec = ConvertTo-ScimPrincipalRecord -User ([pscustomobject]@{ id = 'u-2'; userName = 'bob' }) -Mapping $script:mapping -SelectedAttributes @()
        $rec.displayName | Should -Be 'bob'
        $rec2 = ConvertTo-ScimPrincipalRecord -User ([pscustomobject]@{ id = 'u-3' }) -Mapping $script:mapping -SelectedAttributes @()
        $rec2.displayName | Should -Be 'u-3'
    }

    It 'maps active:false to a disabled account and a missing active to enabled' {
        (ConvertTo-ScimPrincipalRecord -User ([pscustomobject]@{ id = 'u'; active = $false }) -Mapping $script:mapping -SelectedAttributes @()).accountEnabled | Should -BeFalse
        (ConvertTo-ScimPrincipalRecord -User ([pscustomobject]@{ id = 'u' })                  -Mapping $script:mapping -SelectedAttributes @()).accountEnabled | Should -BeTrue
    }

    It 'drives principalType from the userType mapping' {
        $rec = ConvertTo-ScimPrincipalRecord -User ([pscustomobject]@{ id = 'sp-1'; userType = 'service' }) -Mapping $script:mapping -SelectedAttributes @()
        $rec.principalType | Should -Be 'ServicePrincipal'
    }

    It 'adds only the opt-in attributes and never an unselected one' {
        $u = [pscustomobject]@{ id = 'u-4'; userName = 'c'; department = 'IT'; costCenter = 'CC9' }
        $rec = ConvertTo-ScimPrincipalRecord -User $u -Mapping $script:mapping -SelectedAttributes @('department')
        $rec.department | Should -Be 'IT'
        $rec.ContainsKey('costCenter') | Should -BeFalse
    }

    It 'omits optional core fields entirely when the source has none' {
        $rec = ConvertTo-ScimPrincipalRecord -User ([pscustomobject]@{ id = 'u-5'; userName = 'd' }) -Mapping $script:mapping -SelectedAttributes @()
        $rec.ContainsKey('email')     | Should -BeFalse
        $rec.ContainsKey('givenName') | Should -BeFalse
        $rec.ContainsKey('jobTitle')  | Should -BeFalse
    }

    It 'skips a user with no id — there would be nothing to key the row on' {
        ConvertTo-ScimPrincipalRecord -User ([pscustomobject]@{ userName = 'ghost' }) -Mapping $script:mapping -SelectedAttributes @() | Should -BeNullOrEmpty
        ConvertTo-ScimPrincipalRecord -User $null -Mapping $script:mapping -SelectedAttributes @() | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-ScimGroupRecord' {
    It 'maps a group to a Group resource' {
        $rec = ConvertTo-ScimGroupRecord -Group ([pscustomobject]@{ id = 'g-1'; displayName = 'Finance' }) -SelectedAttributes @()
        $rec.externalId   | Should -Be 'g-1'
        $rec.displayName  | Should -Be 'Finance'
        $rec.resourceType | Should -Be 'Group'
        $rec.enabled      | Should -BeTrue
    }

    It 'falls back to the SCIM id when displayName is absent' {
        (ConvertTo-ScimGroupRecord -Group ([pscustomobject]@{ id = 'g-2' }) -SelectedAttributes @()).displayName | Should -Be 'g-2'
    }

    It 'adds only the opt-in group attributes' {
        $g = [pscustomobject]@{ id = 'g-3'; displayName = 'HR'; description = 'People'; externalRef = 'X' }
        $rec = ConvertTo-ScimGroupRecord -Group $g -SelectedAttributes @('description')
        $rec.description | Should -Be 'People'
        $rec.ContainsKey('externalRef') | Should -BeFalse
    }

    It 'skips a group with no id' {
        ConvertTo-ScimGroupRecord -Group ([pscustomobject]@{ displayName = 'X' }) -SelectedAttributes @() | Should -BeNullOrEmpty
        ConvertTo-ScimGroupRecord -Group $null -SelectedAttributes @() | Should -BeNullOrEmpty
    }
}

Describe 'Resolve-ScimMemberKind' {
    BeforeAll {
        $script:users  = New-IdSet @('u-1', 'u-2', 'both')
        $script:groups = New-IdSet @('g-1', 'both')
    }

    It 'classifies by id-set membership, not by the type hint' {
        # The hint LIES: it says Group, but the id is only in the user set. The
        # id-set wins, because `type` is optional in SCIM 2.0 and often wrong.
        $r = Resolve-ScimMemberKind -Member ([pscustomobject]@{ value = 'u-1'; type = 'Group' }) -UserIds $script:users -GroupIds $script:groups
        $r.kind | Should -Be 'user'
    }

    It 'classifies a nested group member' {
        (Resolve-ScimMemberKind -Member ([pscustomobject]@{ value = 'g-1' }) -UserIds $script:users -GroupIds $script:groups).kind | Should -Be 'group'
    }

    It 'uses the type hint only to break a tie when the id is in BOTH sets' {
        (Resolve-ScimMemberKind -Member ([pscustomobject]@{ value = 'both'; type = 'Group' }) -UserIds $script:users -GroupIds $script:groups).kind | Should -Be 'group'
        (Resolve-ScimMemberKind -Member ([pscustomobject]@{ value = 'both'; type = 'User' })  -UserIds $script:users -GroupIds $script:groups).kind | Should -Be 'user'
        (Resolve-ScimMemberKind -Member ([pscustomobject]@{ value = 'both' })                 -UserIds $script:users -GroupIds $script:groups).kind | Should -Be 'user'
    }

    It 'reports an id in neither set as unknown, keeping the value for the log' {
        $r = Resolve-ScimMemberKind -Member ([pscustomobject]@{ value = 'dev-9'; type = 'Device' }) -UserIds $script:users -GroupIds $script:groups
        $r.kind  | Should -Be 'unknown'
        $r.value | Should -Be 'dev-9'
    }

    It 'accepts a bare string member id' {
        (Resolve-ScimMemberKind -Member 'u-2' -UserIds $script:users -GroupIds $script:groups).kind | Should -Be 'user'
    }

    It 'reports a member with no value as unknown' {
        (Resolve-ScimMemberKind -Member ([pscustomobject]@{ display = 'x' }) -UserIds $script:users -GroupIds $script:groups).kind | Should -Be 'unknown'
    }
}

Describe 'ConvertTo-ScimGroupMembership' {
    BeforeAll {
        $script:users  = New-IdSet @('u-1', 'u-2')
        $script:groups = New-IdSet @('g-1', 'g-2')
        $script:types  = @{ 'u-1' = 'User'; 'u-2' = 'ServicePrincipal' }
    }

    It 'emits a Direct assignment per user member, stamped with that account principalType' {
        $g = [pscustomobject]@{ id = 'g-1'; members = @(
            [pscustomobject]@{ value = 'u-1' }, [pscustomobject]@{ value = 'u-2' }) }
        $out = ConvertTo-ScimGroupMembership -Group $g -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $out.assignments.Count | Should -Be 2
        $out.assignments[0].resourceExternalId  | Should -Be 'g-1'
        $out.assignments[0].principalExternalId | Should -Be 'u-1'
        $out.assignments[0].assignmentType      | Should -Be 'Direct'
        $out.assignments[0].resourceType        | Should -Be 'Group'
        $out.assignments[0].principalType       | Should -Be 'User'
        $out.assignments[1].principalType       | Should -Be 'ServicePrincipal'
    }

    It 'emits a Contains relationship for a nested group, never an assignment' {
        $g = [pscustomobject]@{ id = 'g-1'; members = @([pscustomobject]@{ value = 'g-2' }) }
        $out = ConvertTo-ScimGroupMembership -Group $g -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $out.assignments.Count   | Should -Be 0
        $out.relationships.Count | Should -Be 1
        $out.relationships[0].parentExternalId | Should -Be 'g-1'
        $out.relationships[0].childExternalId  | Should -Be 'g-2'
        $out.relationships[0].relationshipType | Should -Be 'Contains'
    }

    It 'counts an unresolvable member instead of dropping it silently' {
        $g = [pscustomobject]@{ id = 'g-1'; members = @([pscustomobject]@{ value = 'u-1' }, [pscustomobject]@{ value = 'device-1' }) }
        $out = ConvertTo-ScimGroupMembership -Group $g -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $out.assignments.Count | Should -Be 1
        $out.unresolved        | Should -Be @('device-1')
    }

    It 'defaults an unknown account principalType to User rather than emitting a blank' {
        $g = [pscustomobject]@{ id = 'g-1'; members = @([pscustomobject]@{ value = 'u-1' }) }
        $out = ConvertTo-ScimGroupMembership -Group $g -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById @{}
        $out.assignments[0].principalType | Should -Be 'User'
    }

    It 'returns empty results for a group with no id or no members' {
        $none = ConvertTo-ScimGroupMembership -Group ([pscustomobject]@{ members = @() }) -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $none.assignments.Count | Should -Be 0
        $empty = ConvertTo-ScimGroupMembership -Group ([pscustomobject]@{ id = 'g-1' }) -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $empty.assignments.Count   | Should -Be 0
        $empty.relationships.Count | Should -Be 0
    }

    It 'records one edge per resolved member for the nesting expansion' {
        $g = [pscustomobject]@{ id = 'g-1'; members = @([pscustomobject]@{ value = 'u-1' }, [pscustomobject]@{ value = 'g-2' }, [pscustomobject]@{ value = 'nope' }) }
        $out = ConvertTo-ScimGroupMembership -Group $g -UserIds $script:users -GroupIds $script:groups -PrincipalTypeById $script:types
        $out.edges.Count | Should -Be 2
        ($out.edges | Where-Object { $_.memberKind -eq 'group' }).memberId | Should -Be 'g-2'
    }
}

Describe 'ConvertTo-ScimNestedGroupIndirectAssignments' {
    It 'materialises an Indirect row for each user of a nested group on the outer group' {
        # A contains B; B contains u-2. u-2 must appear as Indirect on A.
        $edges = @(
            @{ groupId = 'A'; memberId = 'B';   memberKind = 'group' }
            @{ groupId = 'B'; memberId = 'u-2'; memberKind = 'user' }
        )
        $out = ConvertTo-ScimNestedGroupIndirectAssignments -Edges $edges -PrincipalTypeById @{ 'u-2' = 'User' }
        $out.Count | Should -Be 1
        $out[0].resourceExternalId  | Should -Be 'A'
        $out[0].principalExternalId | Should -Be 'u-2'
        $out[0].assignmentType      | Should -Be 'Indirect'
        $out[0].resourceType        | Should -Be 'Group'
    }

    It 'walks more than one level down' {
        $edges = @(
            @{ groupId = 'A'; memberId = 'B';   memberKind = 'group' }
            @{ groupId = 'B'; memberId = 'C';   memberKind = 'group' }
            @{ groupId = 'C'; memberId = 'u-3'; memberKind = 'user' }
        )
        $out = ConvertTo-ScimNestedGroupIndirectAssignments -Edges $edges -PrincipalTypeById @{}
        ($out | Where-Object { $_.resourceExternalId -eq 'A' }).principalExternalId | Should -Be 'u-3'
        ($out | Where-Object { $_.resourceExternalId -eq 'B' }).principalExternalId | Should -Be 'u-3'
    }

    It 'does not emit an Indirect row for a user who is ALSO a direct member' {
        # u-1 is direct on A and reachable through B — the Direct row wins.
        $edges = @(
            @{ groupId = 'A'; memberId = 'B';   memberKind = 'group' }
            @{ groupId = 'A'; memberId = 'u-1'; memberKind = 'user' }
            @{ groupId = 'B'; memberId = 'u-1'; memberKind = 'user' }
            @{ groupId = 'B'; memberId = 'u-2'; memberKind = 'user' }
        )
        $out = ConvertTo-ScimNestedGroupIndirectAssignments -Edges $edges -PrincipalTypeById @{}
        $out.Count | Should -Be 1
        $out[0].principalExternalId | Should -Be 'u-2'
    }

    It 'survives a membership cycle without looping or double-counting' {
        $edges = @(
            @{ groupId = 'A'; memberId = 'B';   memberKind = 'group' }
            @{ groupId = 'B'; memberId = 'A';   memberKind = 'group' }
            @{ groupId = 'B'; memberId = 'u-9'; memberKind = 'user' }
        )
        $out = ConvertTo-ScimNestedGroupIndirectAssignments -Edges $edges -PrincipalTypeById @{}
        @($out | Where-Object { $_.resourceExternalId -eq 'A' }).Count | Should -Be 1
        # B already has u-9 directly, so the cycle must not add an Indirect row there.
        @($out | Where-Object { $_.resourceExternalId -eq 'B' }).Count | Should -Be 0
    }

    It 'carries the nested account principalType onto the Indirect row' {
        $edges = @(
            @{ groupId = 'A'; memberId = 'B';    memberKind = 'group' }
            @{ groupId = 'B'; memberId = 'sp-1'; memberKind = 'user' }
        )
        $out = ConvertTo-ScimNestedGroupIndirectAssignments -Edges $edges -PrincipalTypeById @{ 'sp-1' = 'ServicePrincipal' }
        $out[0].principalType | Should -Be 'ServicePrincipal'
    }

    It 'emits nothing when there is no nesting at all' {
        $edges = @( @{ groupId = 'A'; memberId = 'u-1'; memberKind = 'user' } )
        (ConvertTo-ScimNestedGroupIndirectAssignments -Edges $edges -PrincipalTypeById @{}).Count | Should -Be 0
        (ConvertTo-ScimNestedGroupIndirectAssignments -Edges @() -PrincipalTypeById @{}).Count    | Should -Be 0
    }
}

Describe 'Get-ScimGroupAdjacency' {
    It 'splits edges into nested-group children and direct user members' {
        $edges = @(
            @{ groupId = 'A'; memberId = 'B';   memberKind = 'group' }
            @{ groupId = 'A'; memberId = 'u-1'; memberKind = 'user' }
        )
        $adj = Get-ScimGroupAdjacency -Edges $edges
        $adj.ChildGroups['A'] | Should -Be @('B')
        $adj.DirectUsers['A'].Contains('u-1') | Should -BeTrue
        $adj.ChildGroups.ContainsKey('B')     | Should -BeFalse
    }

    It 'ignores an edge missing a group or member id' {
        $adj = Get-ScimGroupAdjacency -Edges @( @{ groupId = ''; memberId = 'u-1'; memberKind = 'user' }, @{ groupId = 'A'; memberId = '' } )
        $adj.ChildGroups.Count | Should -Be 0
        $adj.DirectUsers.Count | Should -Be 0
    }
}
