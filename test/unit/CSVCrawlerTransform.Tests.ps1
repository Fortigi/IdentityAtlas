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
