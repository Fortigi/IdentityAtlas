#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the CSV crawler's column mapping (CSVCrawler.Mapping.ps1).

.DESCRIPTION
    The mapping layer is what lets a non-schema export load: the config says which
    uploaded file feeds which schema slot, that file's delimiter, and which of its
    columns stands for which schema field, and these functions apply it at the
    header/row boundary on every run.

    Everything here is pure, so the tests are direct — no mocks, no files — except
    the two end-to-end cases that read a real mapped CSV through Read-CsvFile /
    Open-CsvFastReader from $TestDrive, which is where the delimiter threading and
    the post-mapping column guards actually meet.

    Inputs are chosen to DISCRIMINATE, per docs/contributing/writing-tests-that-assert.md:
    the tie fixtures are ones where the old sniffer's fixed ';' > ',' > TAB
    precedence picks a different winner than the pinned "tie → config delimiter"
    rule, and the mapping fixtures use source columns that collide with schema
    names only case-insensitively.

.USAGE
    Invoke-Pester -Path test/unit/CSVCrawlerMapping.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:csvDir   = Join-Path $script:repoRoot 'tools' 'crawlers' 'csv'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Functions.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Mapping.ps1')

    # Scope state the readers resolve at call time, as in a crawler entry point.
    $script:CsvFolder        = $TestDrive
    $script:Delimiter        = ';'
    $script:SystemType       = 'CSV'
    $script:CsvFileSettings  = @{}

    function Set-CsvFixture {
        param([string]$Name, [string[]]$Lines)
        Set-Content -Path (Join-Path $TestDrive $Name) -Value $Lines -Encoding utf8
    }

    # A fast-path row set: one string[] of cells per row, filled BY INDEX.
    # @([string[]]@('g1', 'u1;u2')) unrolls into two bogus one-cell rows instead,
    # and a split test built that way still passes — on the wrong fixture.
    function New-RowSet {
        param([int]$Count)
        return , [object[]]::new($Count)
    }
}

Describe 'Get-CsvSlotKey' {

    It 'resolves every canonical file name to its slot, from csv-slots.json' {
        Get-CsvSlotKey -CanonicalName 'Users.csv'       | Should -Be 'users'
        Get-CsvSlotKey -CanonicalName 'Assignments.csv' | Should -Be 'assignments'
        Get-CsvSlotKey -CanonicalName 'ContextMembers.csv' | Should -Be 'context-members'
    }

    It 'returns $null for a file that is not a schema slot' {
        Get-CsvSlotKey -CanonicalName 'Nope.csv' | Should -BeNullOrEmpty
    }
}

Describe 'Resolve-CsvDelimiterChar' {

    It 'returns the default when nothing is stored' {
        Resolve-CsvDelimiterChar -Delimiter '' -Default ';'   | Should -Be ';'
        Resolve-CsvDelimiterChar -Delimiter $null -Default ',' | Should -Be ','
    }

    It 'normalizes the legacy two-character \t a JSX attribute used to store' {
        # The wizard stored <option value="\t"> verbatim: a backslash and a t.
        # Import-Csv -Delimiter cannot bind that as a [char], so every
        # Tab-configured job failed. A config saved then must start working.
        $d = Resolve-CsvDelimiterChar -Delimiter '\t' -Default ';'
        $d | Should -Be "`t"
        $d.Length | Should -Be 1
        [int][char]$d | Should -Be 9
    }

    It 'passes a real delimiter through untouched' {
        Resolve-CsvDelimiterChar -Delimiter ',' -Default ';' | Should -Be ','
        Resolve-CsvDelimiterChar -Delimiter "`t" -Default ';' | Should -Be "`t"
    }
}

Describe 'Resolve-CsvFileSpec' {

    It 'falls back to the canonical name, the config delimiter and no mapping when the config says nothing' {
        $spec = Resolve-CsvFileSpec -Files @{} -CanonicalName 'Users.csv' -DefaultDelimiter ';'
        $spec.FileName  | Should -Be 'Users.csv'
        $spec.Delimiter | Should -Be ';'
        $spec.Mapping   | Should -BeNullOrEmpty
        $spec.Split     | Should -BeNullOrEmpty
    }

    It 'reads a slot from a file named nothing like the canonical one' {
        # Without this the phase asks for Users.csv, which is not there, and the
        # export is silently never read.
        $files = @{ 'ad_people.csv' = @{ slot = 'users'; delimiter = ','; columns = @{ ExternalId = 'samaccountname' } } }
        $spec = Resolve-CsvFileSpec -Files $files -CanonicalName 'Users.csv' -DefaultDelimiter ';'
        $spec.FileName  | Should -Be 'ad_people.csv'
        $spec.Delimiter | Should -Be ','
        $spec.Mapping['ExternalId'] | Should -Be 'samaccountname'
    }

    It 'keeps the config-level delimiter for a file whose entry does not set one' {
        $files = @{ 'Users.csv' = @{ slot = 'users' } }
        (Resolve-CsvFileSpec -Files $files -CanonicalName 'Users.csv' -DefaultDelimiter '|').Delimiter | Should -Be '|'
    }

    It 'leaves other slots on their canonical names when only one file is mapped' {
        $files = @{ 'ad_people.csv' = @{ slot = 'users' } }
        (Resolve-CsvFileSpec -Files $files -CanonicalName 'Resources.csv' -DefaultDelimiter ';').FileName | Should -Be 'Resources.csv'
    }

    It 'ignores an all-empty mapping rather than treating the file as mapped' {
        $files = @{ 'Users.csv' = @{ slot = 'users'; columns = @{ ExternalId = ''; DisplayName = $null } } }
        (Resolve-CsvFileSpec -Files $files -CanonicalName 'Users.csv').Mapping | Should -BeNullOrEmpty
    }

    It 'ignores a malformed entry instead of failing on an indexing error' {
        # A hand-edited config should produce a clear "this slot has no file"
        # outcome, not "Cannot convert value 'slot' to type System.Int32".
        $files = @{ 'Users.csv' = 'nonsense' }
        $spec = Resolve-CsvFileSpec -Files $files -CanonicalName 'Users.csv' -DefaultDelimiter ';'
        $spec.FileName  | Should -Be 'Users.csv'
        $spec.Delimiter | Should -Be ';'
        $spec.Mapping   | Should -BeNullOrEmpty
    }

    It 'fails naming both files when two of them claim one slot' {
        $files = @{
            'ad_people.csv'  = @{ slot = 'users' }
            'hr_people.csv'  = @{ slot = 'users' }
        }
        { Resolve-CsvFileSpec -Files $files -CanonicalName 'Users.csv' } |
            Should -Throw -ExpectedMessage "*ad_people.csv, hr_people.csv*"
    }
}

Describe 'Get-CsvSplitSpec' {

    It 'returns the single declared split' {
        $entry = @{ slot = 'assignments'; split = @{ field = 'UserExternalId'; delimiter = ';' } }
        $split = Get-CsvSplitSpec -Entry $entry -SlotKey 'assignments' -FileName 'm.csv'
        $split.field     | Should -Be 'UserExternalId'
        $split.delimiter | Should -Be ';'
    }

    It 'normalizes a legacy \t split delimiter too' {
        $entry = @{ split = @{ field = 'ResourceExternalId'; delimiter = '\t' } }
        (Get-CsvSplitSpec -Entry $entry -SlotKey 'assignments' -FileName 'm.csv').delimiter | Should -Be "`t"
    }

    It 'returns $null when there is no split, or the split is incomplete' {
        Get-CsvSplitSpec -Entry @{ slot = 'assignments' } -SlotKey 'assignments' -FileName 'm.csv' | Should -BeNullOrEmpty
        Get-CsvSplitSpec -Entry @{ split = @{ field = 'UserExternalId' } } -SlotKey 'assignments' -FileName 'm.csv' | Should -BeNullOrEmpty
        Get-CsvSplitSpec -Entry @{ split = @{ delimiter = ';' } } -SlotKey 'assignments' -FileName 'm.csv' | Should -BeNullOrEmpty
    }

    It 'fails naming the file when two splits are declared — no cartesian products' {
        $entry = @{ split = @(
            @{ field = 'UserExternalId'; delimiter = ';' }
            @{ field = 'ResourceExternalId'; delimiter = ',' }
        ) }
        { Get-CsvSplitSpec -Entry $entry -SlotKey 'assignments' -FileName 'ad_memberships.csv' } |
            Should -Throw -ExpectedMessage "*ad_memberships.csv declares 2 multi-value splits*"
    }

    It 'accepts a one-element list — the shape stays generic for later slices' {
        $entry = @{ split = @(@{ field = 'UserExternalId'; delimiter = ';' }) }
        (Get-CsvSplitSpec -Entry $entry -SlotKey 'assignments' -FileName 'm.csv').field | Should -Be 'UserExternalId'
    }

    It 'refuses a split on a slot other than assignments' {
        { Get-CsvSplitSpec -Entry @{ split = @{ field = 'UserExternalId'; delimiter = ';' } } -SlotKey 'users' -FileName 'u.csv' } |
            Should -Throw -ExpectedMessage "*only supported for the Assignments slot*"
    }

    It 'refuses a split on a field that is not one of the two identifying ones' {
        { Get-CsvSplitSpec -Entry @{ split = @{ field = 'AssignmentType'; delimiter = ';' } } -SlotKey 'assignments' -FileName 'a.csv' } |
            Should -Throw -ExpectedMessage "*only ResourceExternalId or UserExternalId*"
    }
}

Describe 'Get-CsvMappingRenames' {

    It 'inverts the field -> source map into source -> field' {
        $r = Get-CsvMappingRenames -Mapping @{ ExternalId = 'samaccountname'; DisplayName = 'cn' } -FileName 'u.csv'
        $r['samaccountname'] | Should -Be 'ExternalId'
        $r['cn']             | Should -Be 'DisplayName'
    }

    It 'skips fields mapped to nothing' {
        $r = Get-CsvMappingRenames -Mapping @{ ExternalId = 'id'; Email = '' } -FileName 'u.csv'
        $r.Count | Should -Be 1
    }

    It 'fails naming the file when two schema fields claim one source column' {
        # One file feeding several schema slots is a later slice; dropping one of
        # the two fields silently is exactly the quiet wrong answer to avoid.
        { Get-CsvMappingRenames -Mapping @{ ExternalId = 'id'; DisplayName = 'id' } -FileName 'ad_people.csv' } |
            Should -Throw -ExpectedMessage "*ad_people.csv maps column 'id'*"
    }
}

Describe 'ConvertTo-CsvMappedColumns' {

    It 'returns the header untouched when there is no mapping — the bypass path' {
        $cols = [string[]]@('ExternalId', 'DisplayName')
        $none  = ConvertTo-CsvMappedColumns -Columns $cols -Mapping $null -FileName 'Users.csv'
        $empty = ConvertTo-CsvMappedColumns -Columns $cols -Mapping @{} -FileName 'Users.csv'
        @($none)  | Should -Be @('ExternalId', 'DisplayName')
        @($empty) | Should -Be @('ExternalId', 'DisplayName')
    }

    It 'renames mapped columns to schema fields and keeps the rest under their source names' {
        $cols = [string[]]@('samaccountname', 'cn', 'physicalDeliveryOfficeName')
        $out = ConvertTo-CsvMappedColumns -Columns $cols -Mapping @{ ExternalId = 'samaccountname'; DisplayName = 'cn' } -FileName 'ad.csv'
        # Position is preserved — the row's cells are not moved, only re-labelled.
        $out[0] | Should -Be 'ExternalId'
        $out[1] | Should -Be 'DisplayName'
        # An unmapped column keeps its SOURCE name: that is what makes it an
        # extendedAttribute named the way the source named it.
        $out[2] | Should -Be 'physicalDeliveryOfficeName'
    }

    It 'matches the source column case-insensitively, like every other header check' {
        $out = ConvertTo-CsvMappedColumns -Columns ([string[]]@('SAMAccountName')) -Mapping @{ ExternalId = 'samaccountname' } -FileName 'ad.csv'
        $out[0] | Should -Be 'ExternalId'
    }

    It 'fails naming the file AND the column when a mapped column is gone' {
        { ConvertTo-CsvMappedColumns -Columns ([string[]]@('cn')) -Mapping @{ ExternalId = 'samaccountname' } -FileName 'ad_people.csv' } |
            Should -Throw -ExpectedMessage "*ad_people.csv no longer has the mapped column(s): samaccountname (mapped to ExternalId)*"
    }
}

Describe 'ConvertTo-CsvMappedRow / ConvertTo-CsvMappedRows' {

    It 'renames a row property to its schema field, keeping unmapped ones' {
        $row = [pscustomobject]@{ samaccountname = 'u1'; cn = 'Alice'; office = 'Utrecht' }
        $out = ConvertTo-CsvMappedRow -Row $row -Renames @{ samaccountname = 'ExternalId'; cn = 'DisplayName' }
        $out.ExternalId  | Should -Be 'u1'
        $out.DisplayName | Should -Be 'Alice'
        $out.office      | Should -Be 'Utrecht'
    }

    It 'returns the row object itself when there is nothing to rename' {
        $row = [pscustomobject]@{ ExternalId = 'u1' }
        ConvertTo-CsvMappedRow -Row $row -Renames @{} | Should -Be $row
    }

    It 'maps a whole file and validates its header once' {
        $rows = @(
            [pscustomobject]@{ samaccountname = 'u1'; cn = 'Alice' }
            [pscustomobject]@{ samaccountname = 'u2'; cn = 'Bob' }
        )
        $out = ConvertTo-CsvMappedRows -Rows $rows -Mapping @{ ExternalId = 'samaccountname'; DisplayName = 'cn' } -FileName 'ad.csv'
        $out.Count | Should -Be 2
        $out[1].ExternalId  | Should -Be 'u2'
        $out[1].DisplayName | Should -Be 'Bob'
    }

    It 'fails on a header the mapping no longer fits, before shaping a single row' {
        $rows = @([pscustomobject]@{ cn = 'Alice' })
        { ConvertTo-CsvMappedRows -Rows $rows -Mapping @{ ExternalId = 'samaccountname' } -FileName 'ad.csv' } |
            Should -Throw -ExpectedMessage "*no longer has the mapped column*"
    }
}

Describe 'Split-CsvMultiValueRows' {

    It 'emits one row per value, trimmed, skipping empty segments' {
        $rows = New-RowSet 1
        $rows[0] = [string[]]@('g1', 'user1; user2 ;;user3')
        $out = Split-CsvMultiValueRows -Rows $rows -Index 1 -Delimiter ';'
        $out.Count | Should -Be 3
        @($out | ForEach-Object { $_[1] }) | Should -Be @('user1', 'user2', 'user3')
        # The other cells are copied, not shared-and-mutated.
        @($out | ForEach-Object { $_[0] }) | Should -Be @('g1', 'g1', 'g1')
    }

    It 'leaves a single-value cell alone' {
        $rows = New-RowSet 2
        $rows[0] = [string[]]@('g1', 'user1')
        $rows[1] = [string[]]@('g2', 'user2')
        $out = Split-CsvMultiValueRows -Rows $rows -Index 1 -Delimiter ';'
        $out.Count | Should -Be 2
        $out[1][1] | Should -Be 'user2'
    }

    It 'drops a row whose split cell holds only separators' {
        $rows = New-RowSet 1
        $rows[0] = [string[]]@('g1', ';;')
        (Split-CsvMultiValueRows -Rows $rows -Index 1 -Delimiter ';').Count | Should -Be 0
    }

    It 'passes everything through when no split is configured' {
        $rows = New-RowSet 1
        $rows[0] = [string[]]@('g1', 'a;b')
        (Split-CsvMultiValueRows -Rows $rows -Index -1 -Delimiter ';')[0][1] | Should -Be 'a;b'
        (Split-CsvMultiValueRows -Rows $rows -Index 1 -Delimiter '')[0][1]   | Should -Be 'a;b'
    }

    It 'tolerates a short row that has no cell at the split position' {
        $rows = New-RowSet 1
        $rows[0] = [string[]]@('g1')
        $out = Split-CsvMultiValueRows -Rows $rows -Index 1 -Delimiter ';'
        $out.Count | Should -Be 1
        $out[0][0] | Should -Be 'g1'
    }
}

Describe 'Get-CsvMissingConfiguredFiles' {

    It 'names the configured files that are not in the folder' {
        $files = @{ 'ad_people.csv' = @{ slot = 'users' }; 'ad_groups.csv' = @{ slot = 'resources' } }
        Get-CsvMissingConfiguredFiles -Files $files -Present @('ad_groups.csv') | Should -Be @('ad_people.csv')
    }

    It 'matches the folder listing case-insensitively' {
        $files = @{ 'AD_People.csv' = @{ slot = 'users' } }
        Get-CsvMissingConfiguredFiles -Files $files -Present @('ad_people.csv') | Should -BeNullOrEmpty
    }

    It 'returns nothing for a config with no per-file section' {
        Get-CsvMissingConfiguredFiles -Files @{} -Present @() | Should -BeNullOrEmpty
    }
}

Describe 'Reading a real mapped file end to end' {

    It 'reads a comma-delimited, foreign-column users file through the slow path' {
        Set-CsvFixture -Name 'ad_people.csv' -Lines @(
            'samaccountname,cn,mail,physicalDeliveryOfficeName'
            'u1,Alice,alice@x.test,Utrecht'
        )
        $files = @{ 'ad_people.csv' = @{ slot = 'users'; delimiter = ','; columns = @{
            ExternalId = 'samaccountname'; DisplayName = 'cn'; Email = 'mail' } } }
        $spec = Resolve-CsvFileSpec -Files $files -CanonicalName 'Users.csv' -DefaultDelimiter ';'
        $rows = Read-CsvFile $spec.FileName -Delimiter $spec.Delimiter -Mapping $spec.Mapping
        $rows.Count | Should -Be 1
        $rows[0].ExternalId  | Should -Be 'u1'
        $rows[0].DisplayName | Should -Be 'Alice'
        $rows[0].Email       | Should -Be 'alice@x.test'
        # The unmapped column survives under its source name, for extendedAttributes.
        $rows[0].physicalDeliveryOfficeName | Should -Be 'Utrecht'
        # And the post-mapping header is what Assert-Columns now sees.
        { Assert-Columns $spec.FileName $rows @('ExternalId', 'DisplayName') } | Should -Not -Throw
    }

    It 'reads a TAB-delimited, foreign-column file through the fast path' {
        # Written with a real tab; the legacy "\t" config form must reach it too.
        Set-CsvFixture -Name 'ad_groups.tsv.csv' -Lines @(
            "group_dn`tgroup_name"
            "CN=Sales`tSales"
        )
        $files = @{ 'ad_groups.tsv.csv' = @{ slot = 'resources'; delimiter = '\t'; columns = @{
            ExternalId = 'group_dn'; DisplayName = 'group_name' } } }
        $spec = Resolve-CsvFileSpec -Files $files -CanonicalName 'Resources.csv' -DefaultDelimiter ';'
        $f = Open-CsvFastReader -FileName $spec.FileName -Delimiter $spec.Delimiter -Mapping $spec.Mapping
        try {
            # ColIdx carries SCHEMA names, so every Get-Csv*Index guard downstream
            # validates the post-mapping file and needs no change.
            $f.ColIdx['ExternalId']  | Should -Be 0
            $f.ColIdx['DisplayName'] | Should -Be 1
            $rows = Read-CsvDataRows -Parser $f.Parser -FileName $spec.FileName
            $rows[0][0] | Should -Be 'CN=Sales'
            $rows[0][1] | Should -Be 'Sales'
        } finally { $f.Parser.Dispose() }
    }

    It 'fails the read naming file and column when the mapping no longer fits' {
        Set-CsvFixture -Name 'renamed.csv' -Lines @('cn', 'Alice')
        $files = @{ 'renamed.csv' = @{ slot = 'users'; columns = @{ ExternalId = 'samaccountname' } } }
        $spec = Resolve-CsvFileSpec -Files $files -CanonicalName 'Users.csv' -DefaultDelimiter ';'
        { Read-CsvFile $spec.FileName -Delimiter $spec.Delimiter -Mapping $spec.Mapping } |
            Should -Throw -ExpectedMessage "*renamed.csv no longer has the mapped column(s): samaccountname*"
    }

    It 'still reads an unmapped file with the config delimiter — byte-identical bypass' {
        Set-CsvFixture -Name 'Users.csv' -Lines @('ExternalId;DisplayName', 'u1;Alice')
        $spec = Resolve-CsvFileSpec -Files @{} -CanonicalName 'Users.csv' -DefaultDelimiter ';'
        $mapped = Read-CsvFile $spec.FileName -Delimiter $spec.Delimiter -Mapping $spec.Mapping
        $plain  = Read-CsvFile 'Users.csv'
        $mapped.Count | Should -Be $plain.Count
        $mapped[0].ExternalId  | Should -Be $plain[0].ExternalId
        $mapped[0].DisplayName | Should -Be $plain[0].DisplayName
    }
}

Describe 'Get-CsvFileSpec (scope wrapper)' {

    It 'resolves against the crawler scope state' {
        $script:CsvFileSettings = @{ 'ad_people.csv' = @{ slot = 'users'; delimiter = ',' } }
        $script:Delimiter = ';'
        try {
            $spec = Get-CsvFileSpec 'Users.csv'
            $spec.FileName  | Should -Be 'ad_people.csv'
            $spec.Delimiter | Should -Be ','
            (Get-CsvFileSpec 'Resources.csv').Delimiter | Should -Be ';'
        } finally { $script:CsvFileSettings = @{} }
    }
}
