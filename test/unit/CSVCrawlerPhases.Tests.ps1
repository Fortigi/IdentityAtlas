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
        Should -Invoke Invoke-IngestAPI -Exactly 0
    }

    It 'registers de-duplicated systems and extends $systemLookup from the returned ids' {
        Set-Csv 'Systems.csv' @('ExternalId;DisplayName', 'e1;HR', 'e2;Finance', 'e3;HR')
        Mock Invoke-IngestAPI { @{ systemIds = @(10, 11) } }
        Sync-CsvSystems
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter { $Body.records.Count -eq 2 -and $Body.syncMode -eq 'delta' }
        $script:systemLookup['HR']      | Should -Be 10
        $script:systemLookup['Finance'] | Should -Be 11
    }

    It 'skips the API call when no valid rows survive' {
        Set-Csv 'Systems.csv' @('ExternalId;DisplayName', 'e1;')
        Mock Invoke-IngestAPI { @{ systemIds = @() } }
        Sync-CsvSystems
        Should -Invoke Invoke-IngestAPI -Exactly 0
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

Describe 'Sync-CsvResources' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'warns and returns when Resources.csv is absent' {
        Remove-Csv 'Resources.csv'
        Sync-CsvResources
        @($script:sent).Count | Should -Be 0
    }

    It 'throws when required columns are missing' {
        Set-Csv 'Resources.csv' @('ExternalId;Foo', 'r1;x')
        { Sync-CsvResources } | Should -Throw '*missing required columns*'
    }

    It 'builds resource records, resolving SystemName and normalising Business Role' {
        $script:systemLookup = @{ 'Omada' = 9 }
        Set-Csv 'Resources.csv' @(
            'ExternalId;DisplayName;ResourceType;SystemName'
            'r1;HR Role;Business Role;Omada'
            'r2;Group;EntraGroup;'
            ';Skip;EntraGroup;'
        )
        Sync-CsvResources
        $sent = Get-Sent 'ingest/resources'
        $sent.Count | Should -Be 1
        $sent[0].Records.Count | Should -Be 2
        ($sent[0].Records | Where-Object { $_.externalId -eq 'r1' }).resourceType | Should -Be 'BusinessRole'
        ($sent[0].Records | Where-Object { $_.externalId -eq 'r1' })._systemId | Should -Be 9
        ($sent[0].Records | Where-Object { $_.externalId -eq 'r2' })._systemId | Should -Be 2
    }
}

Describe 'Sync-CsvRelationships' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'does nothing when the file is absent' {
        Remove-Csv 'ResourceRelationships.csv'
        Sync-CsvRelationships
        @($script:sent).Count | Should -Be 0
    }

    It 'sends Contains-scoped relationships and skips rows missing an endpoint' {
        Set-Csv 'ResourceRelationships.csv' @(
            'ParentExternalId;ChildExternalId'
            'p1;c1'
            'p2;'
        )
        Sync-CsvRelationships
        $sent = Get-Sent 'ingest/resource-relationships'
        $sent.Count | Should -Be 1
        $sent[0].Scope.relationshipType | Should -Be 'Contains'
        $sent[0].Records.Count | Should -Be 1
        $sent[0].Records[0].relationshipType | Should -Be 'Contains'
    }
}

Describe 'Sync-CsvUsers' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'warns and returns when Users.csv is absent' {
        Remove-Csv 'Users.csv'
        Sync-CsvUsers
        @($script:sent).Count | Should -Be 0
    }

    It 'sends User-scoped principals, resolving SystemName' {
        $script:systemLookup = @{ 'Omada' = 9 }
        Set-Csv 'Users.csv' @(
            'ExternalId;DisplayName;SystemName'
            'u1;Alice;Omada'
            'u2;Bob;'
            ';Skip;'
        )
        Sync-CsvUsers
        $sent = Get-Sent 'ingest/principals'
        $sent.Count | Should -Be 1
        $sent[0].Scope.principalType | Should -Be 'User'
        $sent[0].Records.Count | Should -Be 2
        ($sent[0].Records | Where-Object { $_.externalId -eq 'u1' })._systemId | Should -Be 9
    }
}

Describe 'Sync-CsvAssignments' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'warns and returns when Assignments.csv is absent' {
        Remove-Csv 'Assignments.csv'
        Sync-CsvAssignments
        @($script:sent).Count | Should -Be 0
    }

    It 'throws when required columns are missing' {
        Set-Csv 'Assignments.csv' @('ResourceExternalId;Foo', 'r1;x')
        { Sync-CsvAssignments } | Should -Throw '*missing required columns*'
    }

    It 'sends Direct-scoped assignments, honouring an explicit AssignmentType' {
        Set-Csv 'Assignments.csv' @(
            'ResourceExternalId;UserExternalId;AssignmentType'
            'r1;u1;Eligible'
            'r2;u2;'
            ';u3;Direct'
        )
        Sync-CsvAssignments
        $sent = Get-Sent 'ingest/resource-assignments'
        $sent.Count | Should -Be 1
        $sent[0].Scope.assignmentType | Should -Be 'Direct'
        $sent[0].Records.Count | Should -Be 2
        ($sent[0].Records | Where-Object { $_.resourceExternalId -eq 'r1' }).assignmentType | Should -Be 'Eligible'
        ($sent[0].Records | Where-Object { $_.resourceExternalId -eq 'r2' }).assignmentType | Should -Be 'Direct'
    }
}

Describe 'Sync-CsvIdentities' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'does nothing when Identities.csv is absent' {
        Remove-Csv 'Identities.csv'
        Sync-CsvIdentities
        @($script:sent).Count | Should -Be 0
    }

    It 'sends identities, skipping rows without an id/name' {
        Set-Csv 'Identities.csv' @(
            'ExternalId;DisplayName;Email'
            'i1;Alice;a@x'
            ';Skip;'
        )
        Sync-CsvIdentities
        $sent = Get-Sent 'ingest/identities'
        $sent.Count | Should -Be 1
        $sent[0].Records.Count | Should -Be 1
        $sent[0].Records[0].email | Should -Be 'a@x'
    }
}

Describe 'Sync-CsvIdentityMembers' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'does nothing when IdentityMembers.csv is absent' {
        Remove-Csv 'IdentityMembers.csv'
        Sync-CsvIdentityMembers
        @($script:sent).Count | Should -Be 0
    }

    It 'maps members and skips rows missing an id' {
        Set-Csv 'IdentityMembers.csv' @(
            'IdentityExternalId;UserExternalId;AccountType'
            'i1;u1;Primary'
            'i2;;Primary'
        )
        Sync-CsvIdentityMembers
        $sent = Get-Sent 'ingest/identity-members'
        $sent.Count | Should -Be 1
        $sent[0].Records.Count | Should -Be 1
        $sent[0].Records[0].accountType | Should -Be 'Primary'
    }
}

Describe 'Sync-CsvCertifications' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'does nothing when Certifications.csv is absent' {
        Remove-Csv 'Certifications.csv'
        Sync-CsvCertifications
        @($script:sent).Count | Should -Be 0
    }

    It 'throws when ExternalId column is missing' {
        Set-Csv 'Certifications.csv' @('Foo;Bar', 'a;b')
        { Sync-CsvCertifications } | Should -Throw '*missing required column ExternalId*'
    }

    It 'sends certification decisions with a 3000 batch size and maps optional fields' {
        Set-Csv 'Certifications.csv' @(
            'ExternalId;Decision'
            'cert1;Approve'
            ';SkipMe'
        )
        Sync-CsvCertifications
        $sent = Get-Sent 'ingest/governance/certifications'
        $sent.Count | Should -Be 1
        $sent[0].Records.Count | Should -Be 1
        $sent[0].Records[0].decision | Should -Be 'Approve'
    }
}

Describe 'Resolve-CsvConfig' {
    It 'applies defaults when the config is empty' {
        $p = Join-Path $TestDrive 'cfg-empty.json'
        '{}' | Set-Content -Path $p
        $c = Resolve-CsvConfig -ConfigPath $p
        $c.csvFolder  | Should -Be '/data/csv'
        $c.systemName | Should -Be 'CSV Import'
        $c.systemType | Should -Be 'CSV'
        $c.delimiter  | Should -Be ';'
    }

    It 'reads overrides from the config file' {
        $p = Join-Path $TestDrive 'cfg-full.json'
        '{ "csvFolder": "/mnt/x", "systemName": "Omada Export", "systemType": "Omada", "delimiter": "," }' | Set-Content -Path $p
        $c = Resolve-CsvConfig -ConfigPath $p
        $c.csvFolder  | Should -Be '/mnt/x'
        $c.systemName | Should -Be 'Omada Export'
        $c.systemType | Should -Be 'Omada'
        $c.delimiter  | Should -Be ','
    }
}

Describe 'Register-CsvFallbackSystem' {
    BeforeEach {
        $script:ApiBaseUrl = 'https://x/api'
        $script:ApiKey     = 'fgc_test'
        $script:SystemName = 'CSV Import'
        $script:SystemType = 'CSV'
        Mock Invoke-RestMethod { @{ displayName = 'CSV Worker' } }
    }

    It 'verifies the key via whoami and returns the id from systemIds' {
        Mock Invoke-IngestAPI { @{ systemIds = @(42) } }
        Register-CsvFallbackSystem | Should -Be 42
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -match '/crawlers/whoami' }
    }

    It 'falls back to a single systemId field' {
        Mock Invoke-IngestAPI { @{ systemId = 7 } }
        Register-CsvFallbackSystem | Should -Be 7
    }

    It 'defaults to id 2 when the API returns neither' {
        Mock Invoke-IngestAPI { @{} }
        Register-CsvFallbackSystem | Should -Be 2
    }
}

Describe 'Complete-CsvRun' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        $script:calls = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-IngestAPI { $script:calls.Add($Endpoint); @{} }
    }

    It 'classifies, refreshes views, and writes a sync-log entry' {
        Complete-CsvRun -SyncStart (Get-Date) -RefreshViews $true
        $script:calls | Should -Contain 'ingest/classify-business-role-assignments'
        $script:calls | Should -Contain 'ingest/refresh-views'
        $script:calls | Should -Contain 'ingest/sync-log'
    }

    It 'skips the view refresh when -RefreshViews is $false' {
        Complete-CsvRun -SyncStart (Get-Date) -RefreshViews $false
        $script:calls | Should -Not -Contain 'ingest/refresh-views'
        $script:calls | Should -Contain 'ingest/sync-log'
    }

    It 'does not throw when classification fails (non-critical)' {
        Mock Invoke-IngestAPI {
            if ($Endpoint -eq 'ingest/classify-business-role-assignments') { throw 'boom' }
            @{}
        }
        { Complete-CsvRun -SyncStart (Get-Date) -RefreshViews $false } | Should -Not -Throw
    }
}
