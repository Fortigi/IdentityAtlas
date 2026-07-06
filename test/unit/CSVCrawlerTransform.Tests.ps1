#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the pure CSV crawler record-shapers
    (CSVCrawler.Transform.ps1).

.DESCRIPTION
    The ConvertTo-Csv*Record functions are pure — every input is an explicit
    parameter, they do no I/O and read no scope — so they are tested directly
    against in-memory rows with zero mocks.

.USAGE
    Invoke-Pester -Path test/unit/CSVCrawlerTransform.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'csv' 'CSVCrawler.Transform.ps1')

    function New-ColSet {
        param([string[]]$Names)
        [System.Collections.Generic.HashSet[string]]::new([string[]]$Names)
    }
}

Describe 'ConvertTo-CsvSystemRecord' {
    It 'returns $null when DisplayName is empty' {
        ConvertTo-CsvSystemRecord -Row ([PSCustomObject]@{ ExternalId = 'x'; DisplayName = '' }) -DefaultSystemType 'CSV' | Should -BeNullOrEmpty
    }

    It 'uses the default system type and null description when those columns are absent' {
        $rec = ConvertTo-CsvSystemRecord -Row ([PSCustomObject]@{ ExternalId = 'e1'; DisplayName = 'HR' }) -DefaultSystemType 'CSV'
        $rec.externalId  | Should -Be 'e1'
        $rec.displayName | Should -Be 'HR'
        $rec.systemType  | Should -Be 'CSV'
        $rec.enabled     | Should -BeTrue
        $rec.syncEnabled | Should -BeTrue
        $rec.description | Should -BeNullOrEmpty
    }

    It 'honours a per-row SystemType and Description when present' {
        $row = [PSCustomObject]@{ ExternalId = 'e1'; DisplayName = 'HR'; SystemType = 'Omada'; Description = 'HR system' }
        $rec = ConvertTo-CsvSystemRecord -Row $row -DefaultSystemType 'CSV'
        $rec.systemType  | Should -Be 'Omada'
        $rec.description | Should -Be 'HR system'
    }

    It 'falls back to default type when SystemType column exists but is blank' {
        $row = [PSCustomObject]@{ ExternalId = 'e1'; DisplayName = 'HR'; SystemType = '' }
        (ConvertTo-CsvSystemRecord -Row $row -DefaultSystemType 'CSV').systemType | Should -Be 'CSV'
    }
}

Describe 'ConvertTo-CsvContextRecord' {
    It 'returns $null when ExternalId is empty' {
        $cols = New-ColSet @('ExternalId', 'DisplayName')
        ConvertTo-CsvContextRecord -Row ([PSCustomObject]@{ ExternalId = ''; DisplayName = 'd' }) -SystemId 2 -Cols $cols | Should -BeNullOrEmpty
    }

    It 'defaults targetType=Identity and contextType=OrgUnit when columns are absent' {
        $cols = New-ColSet @('ExternalId', 'DisplayName')
        $rec = ConvertTo-CsvContextRecord -Row ([PSCustomObject]@{ ExternalId = 'c1'; DisplayName = 'Sales' }) -SystemId 5 -Cols $cols
        $rec._systemId     | Should -Be 5
        $rec.scopeSystemId | Should -Be 5
        $rec.variant       | Should -Be 'synced'
        $rec.targetType    | Should -Be 'Identity'
        $rec.contextType   | Should -Be 'OrgUnit'
        $rec.description   | Should -BeNullOrEmpty
        $rec.parentExternalId | Should -BeNullOrEmpty
    }

    It 'reads targetType/contextType/parent/owner when the columns are present' {
        $cols = New-ColSet @('ExternalId', 'DisplayName', 'TargetType', 'ContextType', 'ParentExternalId', 'OwnerUserId', 'Description')
        $row = [PSCustomObject]@{ ExternalId = 'c1'; DisplayName = 'Sales'; TargetType = 'Resource'; ContextType = 'Department'; ParentExternalId = 'root'; OwnerUserId = 'u1'; Description = 'desc' }
        $rec = ConvertTo-CsvContextRecord -Row $row -SystemId 2 -Cols $cols
        $rec.targetType       | Should -Be 'Resource'
        $rec.contextType      | Should -Be 'Department'
        $rec.parentExternalId | Should -Be 'root'
        $rec.ownerUserId      | Should -Be 'u1'
        $rec.description      | Should -Be 'desc'
    }

    It 'falls back to defaults when TargetType/ContextType columns exist but are blank' {
        $cols = New-ColSet @('ExternalId', 'DisplayName', 'TargetType', 'ContextType')
        $row = [PSCustomObject]@{ ExternalId = 'c1'; DisplayName = 'Sales'; TargetType = ''; ContextType = '' }
        $rec = ConvertTo-CsvContextRecord -Row $row -SystemId 2 -Cols $cols
        $rec.targetType  | Should -Be 'Identity'
        $rec.contextType | Should -Be 'OrgUnit'
    }
}

Describe 'ConvertTo-CsvContextMemberRecord' {
    It 'returns $null when ContextExternalId or MemberExternalId is missing' {
        ConvertTo-CsvContextMemberRecord -Row ([PSCustomObject]@{ ContextExternalId = ''; MemberExternalId = 'm' }) -SystemId 2 | Should -BeNullOrEmpty
        ConvertTo-CsvContextMemberRecord -Row ([PSCustomObject]@{ ContextExternalId = 'c'; MemberExternalId = '' }) -SystemId 2 | Should -BeNullOrEmpty
    }

    It 'maps a membership row with addedBy=sync' {
        $row = [PSCustomObject]@{ ContextExternalId = 'c1'; MemberExternalId = 'u1'; MemberType = 'Identity' }
        $rec = ConvertTo-CsvContextMemberRecord -Row $row -SystemId 3
        $rec._systemId         | Should -Be 3
        $rec.contextExternalId | Should -Be 'c1'
        $rec.memberExternalId  | Should -Be 'u1'
        $rec.memberType        | Should -Be 'Identity'
        $rec.addedBy           | Should -Be 'sync'
    }
}

Describe 'ConvertTo-CsvResourceRecord' {
    # column layout: ExternalId=0, DisplayName=1, ResourceType=2, Enabled=3, Description=4
    BeforeAll {
        $script:fullIdx = @{ Ext = 0; DN = 1; RT = 2; En = 3; Desc = 4 }
        $script:minIdx  = @{ Ext = 0; DN = 1; RT = -1; En = -1; Desc = -1 }
    }

    It 'returns $null when ExternalId or DisplayName is blank' {
        ConvertTo-CsvResourceRecord -Row @('', 'Name', 'Group', 'true', 'd') -Idx $script:fullIdx -SystemId 2 | Should -BeNullOrEmpty
        ConvertTo-CsvResourceRecord -Row @('r1', '', 'Group', 'true', 'd') -Idx $script:fullIdx -SystemId 2 | Should -BeNullOrEmpty
    }

    It 'defaults resourceType=$null, enabled=$true, description=$null when columns absent' {
        $rec = ConvertTo-CsvResourceRecord -Row @('r1', 'Group One') -Idx $script:minIdx -SystemId 4
        $rec._systemId    | Should -Be 4
        $rec.externalId   | Should -Be 'r1'
        $rec.displayName  | Should -Be 'Group One'
        $rec.resourceType | Should -BeNullOrEmpty
        $rec.enabled      | Should -BeTrue
        $rec.description  | Should -BeNullOrEmpty
    }

    It "normalises 'Business Role' to 'BusinessRole'" {
        $rec = ConvertTo-CsvResourceRecord -Row @('r1', 'HR Role', 'Business Role', 'true', 'desc') -Idx $script:fullIdx -SystemId 2
        $rec.resourceType | Should -Be 'BusinessRole'
        $rec.description  | Should -Be 'desc'
    }

    It 'treats Enabled in {false,False,0} as disabled and everything else as enabled' {
        (ConvertTo-CsvResourceRecord -Row @('r1', 'N', 'T', 'false', 'd') -Idx $script:fullIdx -SystemId 2).enabled | Should -BeFalse
        (ConvertTo-CsvResourceRecord -Row @('r1', 'N', 'T', '0', 'd') -Idx $script:fullIdx -SystemId 2).enabled | Should -BeFalse
        (ConvertTo-CsvResourceRecord -Row @('r1', 'N', 'T', 'true', 'd') -Idx $script:fullIdx -SystemId 2).enabled | Should -BeTrue
    }
}

Describe 'ConvertTo-CsvRelationshipRecord' {
    It 'returns $null when Parent or Child is missing' {
        $cols = New-ColSet @('ParentExternalId', 'ChildExternalId')
        ConvertTo-CsvRelationshipRecord -Row ([PSCustomObject]@{ ParentExternalId = ''; ChildExternalId = 'c' }) -SystemId 2 -Cols $cols | Should -BeNullOrEmpty
    }

    It 'defaults relationshipType to Contains when the column is absent' {
        $cols = New-ColSet @('ParentExternalId', 'ChildExternalId')
        $rec = ConvertTo-CsvRelationshipRecord -Row ([PSCustomObject]@{ ParentExternalId = 'p'; ChildExternalId = 'c' }) -SystemId 5 -Cols $cols
        $rec._systemId        | Should -Be 5
        $rec.parentExternalId | Should -Be 'p'
        $rec.childExternalId  | Should -Be 'c'
        $rec.relationshipType | Should -Be 'Contains'
    }

    It 'defaults relationshipType to Contains when the column is present but empty' {
        $cols = New-ColSet @('ParentExternalId', 'ChildExternalId', 'RelationshipType')
        $row = [PSCustomObject]@{ ParentExternalId = 'p'; ChildExternalId = 'c'; RelationshipType = '' }
        (ConvertTo-CsvRelationshipRecord -Row $row -SystemId 2 -Cols $cols).relationshipType | Should -Be 'Contains'
    }

    It 'reads an explicit RelationshipType when present' {
        $cols = New-ColSet @('ParentExternalId', 'ChildExternalId', 'RelationshipType')
        $row = [PSCustomObject]@{ ParentExternalId = 'p'; ChildExternalId = 'c'; RelationshipType = 'GrantsAccessTo' }
        (ConvertTo-CsvRelationshipRecord -Row $row -SystemId 2 -Cols $cols).relationshipType | Should -Be 'GrantsAccessTo'
    }
}

Describe 'ConvertTo-CsvUserRecord' {
    It 'returns $null when ExternalId or DisplayName is blank' {
        $cols = New-ColSet @('ExternalId', 'DisplayName')
        ConvertTo-CsvUserRecord -Row ([PSCustomObject]@{ ExternalId = ''; DisplayName = 'A' }) -SystemId 2 -Cols $cols | Should -BeNullOrEmpty
    }

    It 'defaults principalType=User, accountEnabled=$true, optional fields null' {
        $cols = New-ColSet @('ExternalId', 'DisplayName')
        $rec = ConvertTo-CsvUserRecord -Row ([PSCustomObject]@{ ExternalId = 'u1'; DisplayName = 'Alice' }) -SystemId 7 -Cols $cols
        $rec._systemId      | Should -Be 7
        $rec.principalType  | Should -Be 'User'
        $rec.accountEnabled | Should -BeTrue
        $rec.email          | Should -BeNullOrEmpty
        $rec.jobTitle       | Should -BeNullOrEmpty
    }

    It 'accepts a valid principalType and reads email/jobTitle/department' {
        $cols = New-ColSet @('ExternalId', 'DisplayName', 'PrincipalType', 'Email', 'JobTitle', 'Department', 'Enabled')
        $row = [PSCustomObject]@{ ExternalId = 'sp1'; DisplayName = 'Svc'; PrincipalType = 'ServicePrincipal'; Email = 's@x'; JobTitle = 'Bot'; Department = 'IT'; Enabled = 'true' }
        $rec = ConvertTo-CsvUserRecord -Row $row -SystemId 2 -Cols $cols
        $rec.principalType | Should -Be 'ServicePrincipal'
        $rec.email         | Should -Be 's@x'
        $rec.jobTitle      | Should -Be 'Bot'
        $rec.department    | Should -Be 'IT'
        $rec.accountEnabled | Should -BeTrue   # Enabled='true' must stay enabled (guards the -and)
    }

    It 'rejects an invalid principalType, falling back to User' {
        $cols = New-ColSet @('ExternalId', 'DisplayName', 'PrincipalType')
        $row = [PSCustomObject]@{ ExternalId = 'u1'; DisplayName = 'A'; PrincipalType = 'Wizard' }
        (ConvertTo-CsvUserRecord -Row $row -SystemId 2 -Cols $cols).principalType | Should -Be 'User'
    }

    It 'treats Enabled in {false,False,0} as disabled' {
        $cols = New-ColSet @('ExternalId', 'DisplayName', 'Enabled')
        $row = [PSCustomObject]@{ ExternalId = 'u1'; DisplayName = 'A'; Enabled = 'False' }
        (ConvertTo-CsvUserRecord -Row $row -SystemId 2 -Cols $cols).accountEnabled | Should -BeFalse
    }
}

Describe 'ConvertTo-CsvAssignmentRecord' {
    BeforeAll {
        $script:aIdxFull = @{ Res = 0; User = 1; Type = 2 }
        $script:aIdxMin  = @{ Res = 0; User = 1; Type = -1 }
    }

    It 'returns $null when resource or user id is blank' {
        ConvertTo-CsvAssignmentRecord -Row @('', 'u1', 'Direct') -Idx $script:aIdxFull -SystemId 2 | Should -BeNullOrEmpty
        ConvertTo-CsvAssignmentRecord -Row @('r1', '', 'Direct') -Idx $script:aIdxFull -SystemId 2 | Should -BeNullOrEmpty
    }

    It 'defaults assignmentType=Direct when the column is absent' {
        $rec = ConvertTo-CsvAssignmentRecord -Row @('r1', 'u1') -Idx $script:aIdxMin -SystemId 3
        $rec._systemId           | Should -Be 3
        $rec.resourceExternalId  | Should -Be 'r1'
        $rec.principalExternalId | Should -Be 'u1'
        $rec.assignmentType      | Should -Be 'Direct'
    }

    It 'reads an explicit AssignmentType but falls back to Direct when blank' {
        (ConvertTo-CsvAssignmentRecord -Row @('r1', 'u1', 'Eligible') -Idx $script:aIdxFull -SystemId 2).assignmentType | Should -Be 'Eligible'
        (ConvertTo-CsvAssignmentRecord -Row @('r1', 'u1', '') -Idx $script:aIdxFull -SystemId 2).assignmentType | Should -Be 'Direct'
    }
}

Describe 'ConvertTo-CsvIdentityRecord' {
    It 'returns $null when ExternalId or DisplayName is blank' {
        $cols = New-ColSet @('ExternalId', 'DisplayName')
        ConvertTo-CsvIdentityRecord -Row ([PSCustomObject]@{ ExternalId = ''; DisplayName = 'A' }) -SystemId 2 -Cols $cols | Should -BeNullOrEmpty
    }

    It 'maps optional email/employeeId/department/jobTitle when present, null otherwise' {
        $cols = New-ColSet @('ExternalId', 'DisplayName', 'Email', 'EmployeeId')
        $row = [PSCustomObject]@{ ExternalId = 'i1'; DisplayName = 'Alice'; Email = 'a@x'; EmployeeId = 'E7' }
        $rec = ConvertTo-CsvIdentityRecord -Row $row -SystemId 5 -Cols $cols
        $rec._systemId  | Should -Be 5
        $rec.email      | Should -Be 'a@x'
        $rec.employeeId | Should -Be 'E7'
        $rec.department | Should -BeNullOrEmpty
        $rec.jobTitle   | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-CsvIdentityMemberRecord' {
    It 'returns $null when IdentityExternalId or UserExternalId is missing' {
        $cols = New-ColSet @('IdentityExternalId', 'UserExternalId')
        ConvertTo-CsvIdentityMemberRecord -Row ([PSCustomObject]@{ IdentityExternalId = 'i'; UserExternalId = '' }) -SystemId 2 -Cols $cols | Should -BeNullOrEmpty
    }

    It 'maps the member and reads AccountType when present' {
        $cols = New-ColSet @('IdentityExternalId', 'UserExternalId', 'AccountType')
        $row = [PSCustomObject]@{ IdentityExternalId = 'i1'; UserExternalId = 'u1'; AccountType = 'Primary' }
        $rec = ConvertTo-CsvIdentityMemberRecord -Row $row -SystemId 3 -Cols $cols
        $rec.identityExternalId  | Should -Be 'i1'
        $rec.principalExternalId | Should -Be 'u1'
        $rec.accountType         | Should -Be 'Primary'
    }
}

Describe 'ConvertTo-CsvCertificationRecord' {
    BeforeAll {
        $script:cIdxFull = @{ Ext = 0; Res = 1; UDN = 2; Dec = 3; RDN = 4; RDT = 5 }
        $script:cIdxMin  = @{ Ext = 0; Res = -1; UDN = -1; Dec = -1; RDN = -1; RDT = -1 }
    }

    It 'returns $null when ExternalId is blank' {
        ConvertTo-CsvCertificationRecord -Row @('', 'r', 'u', 'Approve', 'rev', 'd') -Idx $script:cIdxFull -SystemId 2 | Should -BeNullOrEmpty
    }

    It 'maps only the ExternalId when optional columns are absent' {
        $rec = ConvertTo-CsvCertificationRecord -Row @('cert1') -Idx $script:cIdxMin -SystemId 6
        $rec._systemId            | Should -Be 6
        $rec.externalId           | Should -Be 'cert1'
        $rec.resourceExternalId   | Should -BeNullOrEmpty
        $rec.decision             | Should -BeNullOrEmpty
    }

    It 'maps all optional decision fields when present' {
        $rec = ConvertTo-CsvCertificationRecord -Row @('cert1', 'r1', 'Alice', 'Approve', 'Bob', '2026-01-01') -Idx $script:cIdxFull -SystemId 2
        $rec.resourceExternalId    | Should -Be 'r1'
        $rec.principalDisplayName  | Should -Be 'Alice'
        $rec.decision              | Should -Be 'Approve'
        $rec.reviewedByDisplayName | Should -Be 'Bob'
        $rec.reviewedDateTime      | Should -Be '2026-01-01'
    }
}
