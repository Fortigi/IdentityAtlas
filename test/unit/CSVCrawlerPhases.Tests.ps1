#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the CSV crawler sync phases (CSVCrawler.Phases.ps1).

.DESCRIPTION
    Each Sync-Csv* phase reads a canonical CSV file (real files written to
    $TestDrive, parsed by the real Read-Csv* helpers), shapes rows via the pure
    ConvertTo-Csv*Record functions, and sends them through Send-GroupedBySystem.
    The API boundary (Invoke-IngestAPI / Send-GroupedBySystem / Update-CrawlerProgress)
    is mocked; the phases read the same script-scope state ($CsvFolder, $Delimiter,
    $SystemType, $fallbackSystemId, $systemLookup) they do when dot-sourced.

.USAGE
    Invoke-Pester -Path test/unit/CSVCrawlerPhases.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:csvDir   = Join-Path $script:repoRoot 'tools\crawlers\csv'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Functions.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Transform.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Phases.ps1')

    # Scope state the phases + helpers resolve at call time.
    $script:CsvFolder        = $TestDrive
    $script:Delimiter        = ';'
    $script:SystemType       = 'CSV'
    $script:fallbackSystemId = 2
    $script:JobId            = 0

    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Scope = $Scope; SyncMode = $SyncMode; Records = @($Records) })
    }
    function Get-Sent {
        param([string]$Endpoint)
        @($script:sent | Where-Object { $_.Endpoint -eq $Endpoint })
    }
    function Reset-CsvTestState {
        $script:sent        = [System.Collections.Generic.List[object]]::new()
        $script:systemLookup = @{}
    }
    function Set-Csv {
        param([string]$Name, [string[]]$Lines)
        Set-Content -Path (Join-Path $TestDrive $Name) -Value $Lines -Encoding utf8
    }
    function Remove-Csv {
        param([string]$Name)
        $p = Join-Path $TestDrive $Name
        if (Test-Path $p) { Remove-Item $p -Force }
    }
}

Describe 'Sync-CsvSystems' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
    }

    It 'does nothing when Systems.csv is absent' {
        Remove-Csv 'Systems.csv'
        Mock Invoke-IngestAPI { }
        Sync-CsvSystems
        Should -Invoke Invoke-IngestAPI -Times 0
    }

    It 'registers de-duplicated systems and extends $systemLookup from the returned ids' {
        Set-Csv 'Systems.csv' @('ExternalId;DisplayName', 'e1;HR', 'e2;Finance', 'e3;HR')
        Mock Invoke-IngestAPI { @{ systemIds = @(10, 11) } }
        Sync-CsvSystems
        Should -Invoke Invoke-IngestAPI -Times 1 -ParameterFilter { $Body.records.Count -eq 2 -and $Body.syncMode -eq 'delta' }
        $script:systemLookup['HR']      | Should -Be 10
        $script:systemLookup['Finance'] | Should -Be 11
    }

    It 'skips the API call when no valid rows survive' {
        Set-Csv 'Systems.csv' @('ExternalId;DisplayName', 'e1;')
        Mock Invoke-IngestAPI { @{ systemIds = @() } }
        Sync-CsvSystems
        Should -Invoke Invoke-IngestAPI -Times 0
    }
}

Describe 'Sync-CsvContexts' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'does nothing when Contexts.csv is absent' {
        Remove-Csv 'Contexts.csv'
        Sync-CsvContexts
        @($script:sent).Count | Should -Be 0
    }

    It 'sends synced contexts, scoping SystemName rows via the lookup' {
        $script:systemLookup = @{ 'Omada' = 9 }
        Set-Csv 'Contexts.csv' @(
            'ExternalId;DisplayName;SystemName'
            'c1;Sales;Omada'
            'c2;Marketing;'
            ';SkipMe;'
        )
        Sync-CsvContexts
        $sent = Get-Sent 'ingest/contexts'
        $sent.Count | Should -Be 1
        $sent[0].Scope.variant | Should -Be 'synced'
        $sent[0].Records.Count | Should -Be 2   # blank ExternalId row skipped
        ($sent[0].Records | Where-Object { $_.externalId -eq 'c1' }).scopeSystemId | Should -Be 9
        ($sent[0].Records | Where-Object { $_.externalId -eq 'c2' }).scopeSystemId | Should -Be 2
    }
}

Describe 'Sync-CsvContextMembers' {
    BeforeEach {
        Reset-CsvTestState
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'does nothing when ContextMembers.csv is absent' {
        Remove-Csv 'ContextMembers.csv'
        Sync-CsvContextMembers
        @($script:sent).Count | Should -Be 0
    }

    It 'maps membership rows and skips rows missing an id' {
        Set-Csv 'ContextMembers.csv' @(
            'ContextExternalId;MemberExternalId;MemberType'
            'c1;u1;Identity'
            'c1;;Identity'
        )
        Sync-CsvContextMembers
        $sent = Get-Sent 'ingest/context-members'
        $sent.Count | Should -Be 1
        $sent[0].Records.Count | Should -Be 1
        $sent[0].Records[0].addedBy | Should -Be 'sync'
    }
}
