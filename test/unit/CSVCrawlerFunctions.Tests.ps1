#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the CSV crawler helper functions.

.DESCRIPTION
    Tests the six functions extracted into
    tools/crawlers/csv/CSVCrawler.Functions.ps1:
        Send-IngestBatch, Read-CsvFile, Read-CsvFast, Assert-Columns,
        Resolve-SystemId, Send-GroupedBySystem.

    The functions read script-scope variables ($CsvFolder, $Delimiter,
    $SystemType, $fallbackSystemId, $systemLookup) from the caller's scope,
    exactly as they do when dot-sourced into Start-CSVCrawler.ps1. These
    tests set those vars and exercise the functions against real CSV files
    written to $TestDrive, mocking only the Ingest API (Invoke-IngestAPI).

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/CSVCrawlerFunctions.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

    # Pull in Invoke-IngestAPI so Mock has a command to intercept (the dedup/
    # batching tests mock it rather than hitting the real API).
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'csv' 'CSVCrawler.Functions.ps1')

    # Scope variables the functions resolve at call time — mimics a crawler entry point.
    $script:CsvFolder        = $TestDrive
    $script:Delimiter        = ';'
    $script:SystemType       = 'CSV'
    $script:fallbackSystemId = 2
    $script:systemLookup     = @{}
}

Describe 'Read-CsvFile' {

    It 'returns $null when the file does not exist' {
        Read-CsvFile 'DoesNotExist.csv' | Should -BeNullOrEmpty
    }

    It 'parses a delimited file into PSCustomObject rows, stripping surrounding quotes' {
        Set-Content -Path (Join-Path $TestDrive 'Slow.csv') -Value @(
            'ExternalId;DisplayName'
            'u1;Alice'
            '"u2";"Bob"'
        ) -Encoding utf8
        $rows = Read-CsvFile 'Slow.csv'
        $rows.Count | Should -Be 2
        $rows[0].ExternalId | Should -Be 'u1'
        $rows[0].DisplayName | Should -Be 'Alice'
        # Slow-path quote stripping (Read-CsvDataRows) — the fast path had this
        # covered, the slow path did not (surfaced by a broad mutation run).
        $rows[1].ExternalId  | Should -Be 'u2'
        $rows[1].DisplayName | Should -Be 'Bob'
    }
}

Describe 'Read-CsvFast' {

    It 'returns $null when the file does not exist' {
        Read-CsvFast 'Nope.csv' | Should -BeNullOrEmpty
    }

    It 'returns rows + colIdx map for a basic file' {
        Set-Content -Path (Join-Path $TestDrive 'Fast.csv') -Value @(
            'ExternalId;DisplayName;ResourceType'
            'r1;Group One;EntraGroup'
            'r2;Group Two;EntraGroup'
        ) -Encoding utf8
        $result = Read-CsvFast 'Fast.csv'
        $result.colIdx['ExternalId'] | Should -Be 0
        $result.colIdx['DisplayName'] | Should -Be 1
        $result.colIdx['ResourceType'] | Should -Be 2
        $result.rows.Count | Should -Be 2
        $result.rows[0][0] | Should -Be 'r1'
        $result.rows[1][1] | Should -Be 'Group Two'
    }

    It 'strips surrounding double quotes from headers and cells' {
        Set-Content -Path (Join-Path $TestDrive 'Quoted.csv') -Value @(
            '"ExternalId";"DisplayName"'
            '"r1";"Quoted Name"'
        ) -Encoding utf8
        $result = Read-CsvFast 'Quoted.csv'
        $result.colIdx.ContainsKey('ExternalId') | Should -BeTrue
        $result.colIdx.ContainsKey('DisplayName') | Should -BeTrue
        $result.rows[0][0] | Should -Be 'r1'
        $result.rows[0][1] | Should -Be 'Quoted Name'
    }

    It 'strips a UTF-8 BOM from the first header' {
        $path = Join-Path $TestDrive 'Bom.csv'
        $bom = [char]0xFEFF
        Set-Content -Path $path -Value @(
            "${bom}ExternalId;DisplayName"
            'r1;Name'
        ) -Encoding utf8
        $result = Read-CsvFast 'Bom.csv'
        $result.colIdx.ContainsKey('ExternalId') | Should -BeTrue
        $result.colIdx['ExternalId'] | Should -Be 0
    }

    It 'skips blank lines in the body' {
        $path = Join-Path $TestDrive 'Blank.csv'
        # Write raw so we control the empty line exactly
        [System.IO.File]::WriteAllText($path, "ExternalId;DisplayName`nr1;A`n`nr2;B`n", [System.Text.Encoding]::UTF8)
        $result = Read-CsvFast 'Blank.csv'
        $result.rows.Count | Should -Be 2
    }

    It 'returns $null for an empty file (no header line)' {
        $path = Join-Path $TestDrive 'Empty.csv'
        [System.IO.File]::WriteAllText($path, '', [System.Text.Encoding]::UTF8)
        Read-CsvFast 'Empty.csv' | Should -BeNullOrEmpty
    }
}

Describe 'Assert-Columns' {

    It 'does nothing for empty / null row sets' {
        { Assert-Columns 'X.csv' @() @('ExternalId') } | Should -Not -Throw
        { Assert-Columns 'X.csv' $null @('ExternalId') } | Should -Not -Throw
    }

    It 'passes when all required columns are present' {
        $rows = @([PSCustomObject]@{ ExternalId = 'a'; DisplayName = 'b' })
        { Assert-Columns 'Users.csv' $rows @('ExternalId', 'DisplayName') } | Should -Not -Throw
    }

    It 'throws naming the missing column(s)' {
        $rows = @([PSCustomObject]@{ ExternalId = 'a' })
        { Assert-Columns 'Users.csv' $rows @('ExternalId', 'DisplayName') } |
            Should -Throw '*missing*DisplayName*'
    }
}

Describe 'Resolve-SystemId' {

    It 'falls back to $fallbackSystemId when there is no SystemName column' {
        $row = [PSCustomObject]@{ ExternalId = 'x' }
        Resolve-SystemId $row | Should -Be 2
    }

    It 'falls back when SystemName is not in the lookup' {
        $script:systemLookup = @{ 'Known' = 7 }
        $row = [PSCustomObject]@{ ExternalId = 'x'; SystemName = 'Unknown' }
        Resolve-SystemId $row | Should -Be 2
        $script:systemLookup = @{}
    }

    It 'resolves SystemName to its mapped systemId' {
        $script:systemLookup = @{ 'Omada' = 9 }
        $row = [PSCustomObject]@{ ExternalId = 'x'; SystemName = 'Omada' }
        Resolve-SystemId $row | Should -Be 9
        $script:systemLookup = @{}
    }
}

Describe 'Send-IngestBatch' {

    BeforeEach {
        Mock Invoke-IngestAPI { @{ inserted = 0; updated = 0; deleted = 0; syncId = 'sync-1' } }
    }

    It 'sends nothing for an empty record set' {
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 2 -Records @()
        Should -Invoke Invoke-IngestAPI -Times 0
    }

    It 'sends a single batch when count <= BatchSize' {
        $records = 1..5 | ForEach-Object { @{ externalId = "r$_" } }
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 2 -Records $records -BatchSize 10
        Should -Invoke Invoke-IngestAPI -Times 1
    }

    It 'includes systemId, syncMode and a deterministic idPrefix in the body' {
        $records = @(@{ externalId = 'r1' })
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 5 -SyncMode 'full' -Records $records -BatchSize 100
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter {
            $Body.systemId -eq 5 -and
            $Body.syncMode -eq 'full' -and
            $Body.idPrefix -eq 'CSV-resources'
        }
    }

    It 'chunks into multiple batches when count > BatchSize' {
        $records = 1..25 | ForEach-Object { @{ externalId = "r$_" } }
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 2 -Records $records -BatchSize 10
        # 25 records / batch of 10 => 3 calls
        Should -Invoke Invoke-IngestAPI -Times 3
    }

    It 'marks the first chunk with syncSession=start and the last with end' {
        $records = 1..25 | ForEach-Object { @{ externalId = "r$_" } }
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 2 -Records $records -BatchSize 10
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.syncSession -eq 'start' }
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.syncSession -eq 'continue' }
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.syncSession -eq 'end' }
    }
}

Describe 'Send-GroupedBySystem' {

    BeforeEach {
        Mock Invoke-IngestAPI { @{ inserted = 0; updated = 0; deleted = 0; syncId = 'sync-1' } }
    }

    It 'groups records by _systemId and sends one batch per system' {
        $records = @(
            @{ _systemId = 2; externalId = 'a' }
            @{ _systemId = 2; externalId = 'b' }
            @{ _systemId = 3; externalId = 'c' }
        )
        Send-GroupedBySystem -Endpoint 'ingest/resources' -Records $records
        # Two distinct systems => two API calls (each system's batch fits one chunk)
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.systemId -eq 2 }
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.systemId -eq 3 }
    }

    It 'strips the _systemId key from records before sending' {
        $records = @(@{ _systemId = 2; externalId = 'a' })
        Send-GroupedBySystem -Endpoint 'ingest/resources' -Records $records
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter {
            -not $Body.records[0].ContainsKey('_systemId')
        }
    }

    It 'falls back to $fallbackSystemId when _systemId is missing/zero' {
        $records = @(@{ externalId = 'a' })
        Send-GroupedBySystem -Endpoint 'ingest/resources' -Records $records
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.systemId -eq 2 }
    }

    It 'dedups records with the same externalId before sending' {
        $records = @(
            @{ _systemId = 2; externalId = 'dup' }
            @{ _systemId = 2; externalId = 'dup' }
            @{ _systemId = 2; externalId = 'unique' }
        )
        Send-GroupedBySystem -Endpoint 'ingest/resources' -Records $records
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.records.Count -eq 2 }
    }

    It 'dedups assignment rows on the composite key when externalId is absent' {
        $records = @(
            @{ _systemId = 2; resourceExternalId = 'r1'; principalExternalId = 'u1' }
            @{ _systemId = 2; resourceExternalId = 'r1'; principalExternalId = 'u1' }
            @{ _systemId = 2; resourceExternalId = 'r1'; principalExternalId = 'u2' }
        )
        Send-GroupedBySystem -Endpoint 'ingest/resource-assignments' -Records $records
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.records.Count -eq 2 }
    }

    It 'keeps all rows when -SkipDedup is set' {
        $records = @(
            @{ _systemId = 2; externalId = 'dup' }
            @{ _systemId = 2; externalId = 'dup' }
        )
        Send-GroupedBySystem -Endpoint 'ingest/resources' -Records $records -SkipDedup
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.records.Count -eq 2 }
    }
}

Describe 'Get-CsvColIndex' {
    It 'returns the column index when the column is present' {
        Get-CsvColIndex @{ 'ExternalId' = 0; 'DisplayName' = 2 } 'DisplayName' | Should -Be 2
    }
    It 'returns -1 when the column is absent' {
        Get-CsvColIndex @{ 'ExternalId' = 0 } 'Missing' | Should -Be -1
    }
}

Describe 'Get-CsvDedupedBatch' {
    It 'dedups records that share an externalId, keeping one per key' {
        $batch = [System.Collections.Generic.List[object]]::new()
        $batch.Add(@{ externalId = 'a'; v = 1 }); $batch.Add(@{ externalId = 'b'; v = 2 }); $batch.Add(@{ externalId = 'a'; v = 3 })
        $out = Get-CsvDedupedBatch -Batch $batch
        $out.Count | Should -Be 2
    }
    It 'returns the batch unchanged when there are no duplicates' {
        $batch = [System.Collections.Generic.List[object]]::new()
        $batch.Add(@{ externalId = 'a' }); $batch.Add(@{ externalId = 'b' })
        $out = Get-CsvDedupedBatch -Batch $batch
        $out.Count | Should -Be 2
    }
    It 'falls back to a composite key for keyless (relationship-style) rows' {
        $batch = [System.Collections.Generic.List[object]]::new()
        $batch.Add(@{ parentExternalId = 'p'; childExternalId = 'c' })
        $batch.Add(@{ parentExternalId = 'p'; childExternalId = 'c' })   # duplicate composite
        $batch.Add(@{ parentExternalId = 'p'; childExternalId = 'd' })
        $out = Get-CsvDedupedBatch -Batch $batch
        $out.Count | Should -Be 2
    }
}
