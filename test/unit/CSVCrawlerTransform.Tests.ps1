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
        New-CsvColumnSet -Names $Names   # the phases' own (case-insensitive) set
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

Describe 'ConvertTo-CsvContextMemberRecordSet' {
    BeforeAll { $script:cmIdx = @{ Ctx = 0; Mem = 1; Type = 2 } }

    It 'skips a row missing the context or the member, keeping the rows around it' {
        $recs = ConvertTo-CsvContextMemberRecordSet -Rows @(@('', 'm1', 'Resource'), @('c2', 'm2', 'Resource'), @('c3', '', 'Resource')) -Idx $script:cmIdx -SystemId 2
        @($recs).Count | Should -Be 1
        $recs[0].contextExternalId | Should -Be 'c2'
    }

    It 'maps a membership row with addedBy=sync and the given system' {
        $recs = ConvertTo-CsvContextMemberRecordSet -Rows @(, @('m9', 'Resource', 'c1')) -Idx @{ Ctx = 2; Mem = 0; Type = 1 } -SystemId 3
        $recs[0]._systemId         | Should -Be 3
        $recs[0].contextExternalId | Should -Be 'c1'
        $recs[0].memberExternalId  | Should -Be 'm9'
        $recs[0].memberType        | Should -Be 'Resource'
        $recs[0].addedBy           | Should -Be 'sync'
    }

    It 'returns an empty array — not $null — for a batch with no valid rows' {
        $recs = ConvertTo-CsvContextMemberRecordSet -Rows @(, @('', '', '')) -Idx $script:cmIdx -SystemId 2
        $null -eq $recs | Should -BeFalse
        $recs.Count | Should -Be 0
    }
}

Describe 'ConvertTo-CsvResourceRecordSet' {
    It 'shapes a system''s rows without a _systemId, counting the skipped ones' {
        $idx = @{ Ext = 0; DN = 1; RT = 2; Desc = -1; En = -1 }
        $set = ConvertTo-CsvResourceRecordSet -Rows @(@('r1', 'A', 'Business Role'), @('', 'B', ''), @('r3', '', '')) -Idx $idx
        $set.Skipped | Should -Be 2
        $set.Records.Count | Should -Be 1
        $set.Records[0].resourceType | Should -Be 'BusinessRole'
        $set.Records[0].ContainsKey('_systemId') | Should -BeFalse
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

    It 'reads optional columns positioned at index 0 (the -ge 0 presence boundary)' {
        # A column that sits FIRST (index 0) must still be read — pins the `-ge 0`
        # sentinel boundary so a `-ge 1` regression can't silently drop it.
        (ConvertTo-CsvResourceRecord -Row @('Group', 'r1', 'Name') -Idx @{ Ext = 1; DN = 2; RT = 0; En = -1; Desc = -1 } -SystemId 2).resourceType | Should -Be 'Group'
        (ConvertTo-CsvResourceRecord -Row @('false', 'r1', 'Name') -Idx @{ Ext = 1; DN = 2; RT = -1; En = 0; Desc = -1 } -SystemId 2).enabled     | Should -BeFalse
        (ConvertTo-CsvResourceRecord -Row @('mydesc', 'r1', 'Name') -Idx @{ Ext = 1; DN = 2; RT = -1; En = -1; Desc = 0 } -SystemId 2).description | Should -Be 'mydesc'
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

Describe 'ConvertTo-CsvStreamBatch (assignments)' {
    # A whole batch per call: the per-row function it replaced cost more than the
    # shaping it did, at 40M rows. Each case below feeds rows that only the right
    # branch handles correctly.
    BeforeAll {
        $script:aIdxFull = @{ Res = 0; User = 1; Type = 2; Sys = -1 }
        $script:aIdxMin  = @{ Res = 0; User = 1; Type = -1; Sys = -1 }
        function Invoke-Shape($Rows, $Idx, $Lookup = @{}, $Fallback = 2, $Unknown = @{}) {
            ConvertTo-CsvStreamBatch -Rows $Rows -Idx $Idx -SystemLookup $Lookup -FallbackSystemId $Fallback -ShapeSet ${function:ConvertTo-CsvAssignmentRecordSet} -Unknown $Unknown
        }
    }

    It 'skips and counts a row missing either id, keeping the rows around it' {
        $out = Invoke-Shape @(@('', 'u1', 'Direct'), @('r2', 'u2', ''), @('r1', '', 'Direct')) $script:aIdxFull
        $out.Skipped | Should -Be 2
        @($out.BySystem[2]).Count | Should -Be 1
        $out.BySystem[2][0].resourceExternalId | Should -Be 'r2'
    }

    It 'defaults assignmentType=Direct when the column is absent, and carries no _systemId' {
        $out = Invoke-Shape @(, @('r1', 'u1')) $script:aIdxMin -Fallback 3
        $rec = $out.BySystem[3][0]
        $rec.resourceExternalId  | Should -Be 'r1'
        $rec.principalExternalId | Should -Be 'u1'
        $rec.assignmentType      | Should -Be 'Direct'
        $rec.ContainsKey('_systemId') | Should -BeFalse   # the system is which array it is in
    }

    It 'reads an explicit AssignmentType but falls back to Direct when blank' {
        $out = Invoke-Shape @(@('r1', 'u1', 'Eligible'), @('r2', 'u2', '')) $script:aIdxFull
        $out.BySystem[2][0].assignmentType | Should -Be 'Eligible'
        $out.BySystem[2][1].assignmentType | Should -Be 'Direct'
    }

    It 'reads AssignmentType and SystemName positioned at index 0 (the -ge 0 presence boundary)' {
        (Invoke-Shape @(, @('Eligible', 'r1', 'u1')) @{ Res = 1; User = 2; Type = 0; Sys = -1 }).BySystem[2][0].assignmentType | Should -Be 'Eligible'
        (Invoke-Shape @(, @('HR', 'r1', 'u1')) @{ Res = 1; User = 2; Type = -1; Sys = 0 } @{ HR = 9 }).BySystem.Keys | Should -Be @(9)
    }

    It 'routes interleaved rows to their systems in file order, unknown or blank names to the fallback' {
        $idx = @{ Res = 0; User = 1; Type = -1; Sys = 2 }
        $rows = @(@('r1', 'u1', 'HR'), @('r2', 'u2', 'AD'), @('r3', 'u3', 'HR'), @('r4', 'u4', 'Nope'), @('r5', 'u5', ''))
        $out = Invoke-Shape $rows $idx @{ HR = 7; AD = 8 }
        @($out.BySystem[7] | ForEach-Object resourceExternalId) | Should -Be @('r1', 'r3')
        @($out.BySystem[8] | ForEach-Object resourceExternalId) | Should -Be @('r2')
        @($out.BySystem[2] | ForEach-Object resourceExternalId) | Should -Be @('r4', 'r5')
    }

    It 'returns arrays holding exactly the shaped rows — no unfilled slots' {
        # Each system's array is sized for the whole batch and trimmed once. An
        # untrimmed array would post $null records to the API.
        $idx = @{ Res = 0; User = 1; Type = -1; Sys = 2 }
        $out = Invoke-Shape @(@('r1', 'u1', 'HR'), @('r2', 'u2', 'AD'), @('r3', 'u3', 'AD')) $idx @{ HR = 7; AD = 8 }
        $out.BySystem[7].Length | Should -Be 1
        $out.BySystem[8].Length | Should -Be 2
        @($out.BySystem[8] | Where-Object { $null -eq $_ }).Count | Should -Be 0
    }

    It 'returns the full array untouched when every row went to one system' {
        $out = Invoke-Shape @(@('r1', 'u1'), @('r2', 'u2')) $script:aIdxMin
        $out.BySystem[2].Length | Should -Be 2
        $out.Skipped | Should -Be 0
    }

    It 'leaves out a system whose rows were all skipped — it must not get a stream to reconcile' {
        $idx = @{ Res = 0; User = 1; Type = -1; Sys = 2 }
        $out = Invoke-Shape @(@('r1', 'u1', 'HR'), @('', 'u2', 'AD'), @('r3', '', 'AD')) $idx @{ HR = 7; AD = 8 }
        @($out.BySystem.Keys) | Should -Be @(7)
        $out.Skipped | Should -Be 2
    }

    It 'routes a row shorter than its SystemName position to the fallback instead of throwing' {
        $idx = @{ Res = 0; User = 1; Type = -1; Sys = 2 }
        @((Invoke-Shape @(, @('r1', 'u1')) $idx @{ HR = 7 }).BySystem.Keys) | Should -Be @(2)
    }

    It 'counts rows per unknown system NAME, but never a blank one' {
        $idx = @{ Res = 0; User = 1; Type = -1; Sys = 2 }
        $unknown = @{}
        $rows = @(@('r1', 'u1', 'HR'), @('r2', 'u2', 'Ghost'), @('r3', 'u3', 'Ghost'), @('r4', 'u4', 'Other'), @('r5', 'u5', ''))
        [void](Invoke-Shape $rows $idx @{ HR = 7 } -Unknown $unknown)
        $unknown['Ghost'] | Should -Be 2
        $unknown['Other'] | Should -Be 1
        $unknown.Count | Should -Be 2
        # The tally accumulates across batches of one file.
        [void](Invoke-Shape @(, @('r6', 'u6', 'Ghost')) $idx @{ HR = 7 } -Unknown $unknown)
        $unknown['Ghost'] | Should -Be 3
    }

    It 'returns no systems at all for an empty batch' {
        $out = Invoke-Shape @() $script:aIdxMin
        $out.BySystem.Count | Should -Be 0
        $out.Skipped | Should -Be 0
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

    It 'reads each optional field positioned at index 0 (the -ge 0 presence boundary)' {
        (ConvertTo-CsvCertificationRecord -Row @('r1', 'cert1')         -Idx @{ Ext = 1; Res = 0; UDN = -1; Dec = -1; RDN = -1; RDT = -1 } -SystemId 2).resourceExternalId    | Should -Be 'r1'
        (ConvertTo-CsvCertificationRecord -Row @('Alice', 'cert1')      -Idx @{ Ext = 1; Res = -1; UDN = 0; Dec = -1; RDN = -1; RDT = -1 } -SystemId 2).principalDisplayName  | Should -Be 'Alice'
        (ConvertTo-CsvCertificationRecord -Row @('Approve', 'cert1')    -Idx @{ Ext = 1; Res = -1; UDN = -1; Dec = 0; RDN = -1; RDT = -1 } -SystemId 2).decision              | Should -Be 'Approve'
        (ConvertTo-CsvCertificationRecord -Row @('Bob', 'cert1')        -Idx @{ Ext = 1; Res = -1; UDN = -1; Dec = -1; RDN = 0; RDT = -1 } -SystemId 2).reviewedByDisplayName | Should -Be 'Bob'
        (ConvertTo-CsvCertificationRecord -Row @('2026-01-01', 'cert1') -Idx @{ Ext = 1; Res = -1; UDN = -1; Dec = -1; RDN = -1; RDT = 0 } -SystemId 2).reviewedDateTime      | Should -Be '2026-01-01'
    }
}

Describe 'Extra columns become extendedAttributes' {
    # The CSV schema doc promises this in five places, including "No data is lost
    # during import". The transforms returned a fixed set of keys and silently
    # dropped everything else, so an IdentityIQ export lost its cost centre,
    # division, sector and employee status on the way in — with no warning.
    It 'Get-CsvExtraColumns returns only the non-schema columns, and never the routing column' {
        $cols = @('ExternalId', 'DisplayName', 'Email', 'SystemName', 'costcentercode', 'divtext')
        $extra = Get-CsvExtraColumns -Columns $cols -FileName 'Users.csv'
        @($extra) | Should -Be @('costcentercode', 'divtext')
        # SystemName routes a row to a system; it is plumbing, not an attribute.
        @($extra) | Should -Not -Contain 'SystemName'
    }

    It 'returns nothing for a file that is pure schema, so the per-row work is skipped' {
        @(Get-CsvExtraColumns -Columns @('ExternalId', 'DisplayName') -FileName 'Users.csv') | Should -BeNullOrEmpty
    }

    It 'returns nothing for a file whose extras are deliberately not kept, and names them instead' {
        foreach ($f in 'Assignments.csv', 'IdentityMembers.csv', 'ContextMembers.csv') {
            @(Get-CsvExtraColumns -Columns @('SystemName', 'grantedBy') -FileName $f) | Should -BeNullOrEmpty
        }
        @(Get-CsvIgnoredColumns -Columns @('ResourceExternalId', 'UserExternalId', 'SystemName', 'grantedBy', 'source') -FileName 'Assignments.csv') |
            Should -Be @('grantedBy', 'source')
        @(Get-CsvIgnoredColumns -Columns @('IdentityExternalId', 'UserExternalId', 'AccountType', 'why') -FileName 'IdentityMembers.csv') | Should -Be @('why')
        # A file that KEEPS its extras never reports them as ignored.
        @(Get-CsvIgnoredColumns -Columns @('ExternalId', 'costcenter') -FileName 'Users.csv') | Should -BeNullOrEmpty
    }

    It 'matches a column that differs from a reserved one only by case as the reserved column' {
        # Import-Csv row access is case-insensitive, so `department` IS the
        # Department column; also forwarding it as an extra would send it twice.
        $row = [pscustomobject]@{ ExternalId = 'u1'; DisplayName = 'Ann'; department = 'Finance'; COSTCENTER = 'C1' }
        $names = [string[]]$row.PSObject.Properties.Name
        $extra = Get-CsvExtraColumns -Columns $names -FileName 'Users.csv'
        @($extra) | Should -Be @('COSTCENTER')
        $rec = ConvertTo-CsvUserRecord -Row $row -SystemId 2 -Cols (New-CsvColumnSet -Names $names) -Extra $extra
        $rec.department | Should -Be 'Finance'
        @($rec.Keys | Where-Object { $_ -eq 'department' }).Count | Should -Be 1   # once, not twice
        $rec.COSTCENTER | Should -Be 'C1'
    }

    It 'never forwards a column named like an ingest bookkeeping field' {
        # A record field named like a real column lands IN that column: "systemId"
        # would try to re-home the row, "id" to overwrite its key.
        $cols = @('ExternalId', 'DisplayName', 'id', 'SystemId', 'updatedAt', 'extendedAttributes', 'deletedAt', 'createdAt', 'site')
        @(Get-CsvExtraColumns -Columns $cols -FileName 'Resources.csv') | Should -Be @('site')
    }

    It 'never overwrites a field the shaper set, even when only the case differs' {
        # accountEnabled is not a CSV column, but the record is a case-insensitive
        # hashtable — an extra column called "AccountEnabled" would clobber the
        # boolean the shaper computed from Enabled.
        $row = [pscustomobject]@{ ExternalId = 'u1'; DisplayName = 'Ann'; Enabled = 'false'; AccountEnabled = 'yes' }
        $names = [string[]]$row.PSObject.Properties.Name
        $rec = ConvertTo-CsvUserRecord -Row $row -SystemId 2 -Cols (New-CsvColumnSet -Names $names) -Extra (Get-CsvExtraColumns -Columns $names -FileName 'Users.csv')
        $rec.accountEnabled | Should -BeExactly $false
    }

    It 'skips a blank or whitespace-only value rather than storing it' {
        $rec = @{}
        Add-CsvExtendedAttributes -Row ([pscustomobject]@{ a = ''; b = '   '; c = $null; d = 'kept' }) -Extra @('a', 'b', 'c', 'd') -Record $rec
        @($rec.Keys) | Should -Be @('d')
    }

    It 'reads a fast-path row by position, including an extra column in position 0' {
        # A one-element index array @(0) is falsy in PowerShell; testing it for
        # truth instead of $null would read $Row.site off a string[] and get nothing.
        $rec = @{}
        Add-CsvExtendedAttributes -Row @('Utrecht', 'r1') -Extra @('site') -ExtraIndex @(0) -Record $rec
        $rec.site | Should -Be 'Utrecht'
    }

    It 'carries extra columns onto a resource record (fast path)' {
        $colIdx = @{ Region = 0; ExternalId = 1; DisplayName = 2; Owner = 3 }
        $extra = Get-CsvExtraColumns -Columns @('Region', 'ExternalId', 'DisplayName', 'Owner') -FileName 'Resources.csv'
        $idx = @{ Ext = 1; DN = 2; RT = -1; Desc = -1; En = -1; Extra = $extra; ExtraIdx = (Get-CsvColumnPositions -ColIdx $colIdx -Names $extra) }
        $rec = ConvertTo-CsvResourceRecord -Row @('EU', 'r1', 'Payroll', '') -Idx $idx -SystemId 2
        $rec.Region | Should -Be 'EU'
        $rec.ContainsKey('Owner') | Should -BeFalse     # blank
        $rec.externalId | Should -Be 'r1'
    }

    It 'carries extra columns onto a certification record (fast path)' {
        $idx = @{ Ext = 0; Res = -1; UDN = -1; Dec = -1; RDN = -1; RDT = -1; Extra = @('campaign'); ExtraIdx = @(1) }
        (ConvertTo-CsvCertificationRecord -Row @('c1', 'Q3 review') -Idx $idx -SystemId 2).campaign | Should -Be 'Q3 review'
    }

    It 'carries extra columns onto system, context and relationship records' {
        $sys = [pscustomobject]@{ ExternalId = 's1'; DisplayName = 'SAP'; owner = 'Ops' }
        (ConvertTo-CsvSystemRecord -Row $sys -DefaultSystemType 'CSV' -Extra @('owner')).owner | Should -Be 'Ops'

        $ctx = [pscustomobject]@{ ExternalId = 'c1'; DisplayName = 'Sales'; manager = 'Bo' }
        $cc = [System.Collections.Generic.HashSet[string]]::new([string[]]@('ExternalId', 'DisplayName', 'manager'))
        (ConvertTo-CsvContextRecord -Row $ctx -SystemId 2 -Cols $cc -Extra @('manager')).manager | Should -Be 'Bo'

        $rel = [pscustomobject]@{ ParentExternalId = 'p'; ChildExternalId = 'c'; since = '2024' }
        $rc = [System.Collections.Generic.HashSet[string]]::new([string[]]@('ParentExternalId', 'ChildExternalId', 'since'))
        (ConvertTo-CsvRelationshipRecord -Row $rel -SystemId 2 -Cols $rc -Extra @('since')).since | Should -Be '2024'
    }

    It 'Get-CsvColumnPositions maps each name to its position, in order' {
        $p = Get-CsvColumnPositions -ColIdx @{ a = 3; b = 0; c = 1 } -Names @('b', 'a')
        $p | Should -Be @(0, 3)
        $none = Get-CsvColumnPositions -ColIdx @{ a = 3 } -Names @()
        $none.Length | Should -Be 0
    }

    It 'carries the extra columns onto a user record, leaving the schema fields alone' {
        $row = [pscustomobject]@{ ExternalId = 'u1'; DisplayName = 'Ann'; Email = 'a@x'; costcentercode = 'NL010153'; divtext = 'CFO Organization'; blank = '' }
        $cols = [System.Collections.Generic.HashSet[string]]::new([string[]]$row.PSObject.Properties.Name)
        $extra = Get-CsvExtraColumns -Columns ([string[]]$row.PSObject.Properties.Name) -FileName 'Users.csv'
        $rec = ConvertTo-CsvUserRecord -Row $row -SystemId 2 -Cols $cols -Extra $extra
        $rec.costcentercode | Should -Be 'NL010153'
        $rec.divtext | Should -Be 'CFO Organization'
        $rec.displayName | Should -Be 'Ann'
        $rec.ContainsKey('blank') | Should -BeFalse   # empty values are not stored
    }

    It 'carries them onto an identity record too' {
        $row = [pscustomobject]@{ ExternalId = 'i1'; DisplayName = 'Ann'; employeestatus = 'Active'; hiredate = '2025-10-16' }
        $cols = [System.Collections.Generic.HashSet[string]]::new([string[]]$row.PSObject.Properties.Name)
        $extra = Get-CsvExtraColumns -Columns ([string[]]$row.PSObject.Properties.Name) -FileName 'Identities.csv'
        $rec = ConvertTo-CsvIdentityRecord -Row $row -SystemId 2 -Cols $cols -Extra $extra
        $rec.employeestatus | Should -Be 'Active'
        $rec.hiredate | Should -Be '2025-10-16'
    }

    It 'a record with no extras is byte-identical to the old fixed shape' {
        $row = [pscustomobject]@{ ExternalId = 'u1'; DisplayName = 'Ann' }
        $cols = [System.Collections.Generic.HashSet[string]]::new([string[]]$row.PSObject.Properties.Name)
        $with = ConvertTo-CsvUserRecord -Row $row -SystemId 2 -Cols $cols -Extra @()
        @($with.Keys | Sort-Object) | Should -Be @('_systemId', 'accountEnabled', 'department', 'displayName', 'email', 'externalId', 'jobTitle', 'principalType')
    }
}
