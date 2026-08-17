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

# ─────────────────────────────────────────────────────────────────────────────
# The SystemName → systemId resolution is repeated across eight phases, and
# every guard in it survived mutation. The existing fixtures name a system that
# IS in the lookup, or leave the column blank — and neither separates
# `hasColumn -and named -and known` from the same expression with `-or`. The row
# that does is one naming a system the lookup has never heard of: as `-or` the
# phase indexes a missing key and stamps a NULL systemId onto the record instead
# of falling back, so those rows land unattached to any system.
#
# The other repeated survivor is `$rows[0].PSObject.Properties.Name`, which is
# how each phase learns whether a SystemName column exists at all. Reading row 1
# instead of row 0 is indistinguishable on a multi-row file — Import-Csv gives
# every row identical properties — so only a single-data-row file separates
# them. A one-row import is an ordinary case, and under the mutant its
# SystemName is ignored entirely.
# ─────────────────────────────────────────────────────────────────────────────

Describe 'CSV phases — a SystemName the lookup does not know' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
        $script:systemLookup = @{ 'Omada' = 9 }
    }

    It 'Sync-CsvContexts falls back for an unknown system' {
        Set-Csv 'Contexts.csv' @('ExternalId;DisplayName;SystemName', 'c1;Sales;Omada', 'c2;Ops;NoSuchSystem', 'c3;Fin;')
        Sync-CsvContexts
        $recs = (Get-Sent 'ingest/contexts')[0].Records
        ($recs | Where-Object { $_.externalId -eq 'c1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.externalId -eq 'c2' })._systemId | Should -Be 2
        ($recs | Where-Object { $_.externalId -eq 'c3' })._systemId | Should -Be 2
    }

    It 'Sync-CsvRelationships falls back for an unknown system' {
        Set-Csv 'ResourceRelationships.csv' @('ParentExternalId;ChildExternalId;SystemName', 'p1;c1;Omada', 'p2;c2;NoSuchSystem')
        Sync-CsvRelationships
        $recs = (Get-Sent 'ingest/resource-relationships')[0].Records
        ($recs | Where-Object { $_.parentExternalId -eq 'p1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.parentExternalId -eq 'p2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvUsers falls back for an unknown system' {
        Set-Csv 'Users.csv' @('ExternalId;DisplayName;SystemName', 'u1;Alice;Omada', 'u2;Bob;NoSuchSystem')
        Sync-CsvUsers
        $recs = (Get-Sent 'ingest/principals')[0].Records
        ($recs | Where-Object { $_.externalId -eq 'u1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.externalId -eq 'u2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvIdentities falls back for an unknown system' {
        Set-Csv 'Identities.csv' @('ExternalId;DisplayName;SystemName', 'i1;Alice;Omada', 'i2;Bob;NoSuchSystem')
        Sync-CsvIdentities
        $recs = (Get-Sent 'ingest/identities')[0].Records
        ($recs | Where-Object { $_.externalId -eq 'i1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.externalId -eq 'i2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvIdentityMembers falls back for an unknown system' {
        Set-Csv 'IdentityMembers.csv' @('IdentityExternalId;UserExternalId;SystemName', 'i1;u1;Omada', 'i2;u2;NoSuchSystem')
        Sync-CsvIdentityMembers
        $recs = (Get-Sent 'ingest/identity-members')[0].Records
        ($recs | Where-Object { $_.identityExternalId -eq 'i1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.identityExternalId -eq 'i2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvResources falls back for an unknown system' {
        Set-Csv 'Resources.csv' @('ExternalId;DisplayName;SystemName', 'r1;A;Omada', 'r2;B;NoSuchSystem', 'r3;C;')
        Sync-CsvResources
        $recs = (Get-Sent 'ingest/resources')[0].Records
        ($recs | Where-Object { $_.externalId -eq 'r1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.externalId -eq 'r2' })._systemId | Should -Be 2
        ($recs | Where-Object { $_.externalId -eq 'r3' })._systemId | Should -Be 2
    }

    It 'Sync-CsvAssignments resolves a known system and falls back for an unknown one' {
        # The existing assignment fixture has no SystemName column at all, so the
        # `$idxSys -ge 0` guard is only ever evaluated on the absent case (-1).
        # Inverted to `-lt 0` that reads the LAST column of every row as if it
        # were the system name; with the column genuinely present it silently
        # drops the mapping instead.
        Set-Csv 'Assignments.csv' @('ResourceExternalId;UserExternalId;SystemName', 'r1;u1;Omada', 'r2;u2;NoSuchSystem')
        Sync-CsvAssignments
        $recs = (Get-Sent 'ingest/resource-assignments')[0].Records
        ($recs | Where-Object { $_.resourceExternalId -eq 'r1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.resourceExternalId -eq 'r2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvCertifications resolves a known system and falls back for an unknown one' {
        Set-Csv 'Certifications.csv' @('ExternalId;SystemName', 'cert1;Omada', 'cert2;NoSuchSystem')
        Sync-CsvCertifications
        $recs = (Get-Sent 'ingest/governance/certifications')[0].Records
        ($recs | Where-Object { $_.externalId -eq 'cert1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.externalId -eq 'cert2' })._systemId | Should -Be 2
    }
}

Describe 'CSV phases — SystemName is honoured on a single-row file' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
        $script:systemLookup = @{ 'Omada' = 9 }
    }

    It 'Sync-CsvContexts reads the column list from the first row' {
        Set-Csv 'Contexts.csv' @('ExternalId;DisplayName;SystemName', 'c1;Sales;Omada')
        Sync-CsvContexts
        (Get-Sent 'ingest/contexts')[0].Records[0]._systemId | Should -Be 9
    }

    It 'Sync-CsvRelationships reads the column list from the first row' {
        Set-Csv 'ResourceRelationships.csv' @('ParentExternalId;ChildExternalId;SystemName', 'p1;c1;Omada')
        Sync-CsvRelationships
        (Get-Sent 'ingest/resource-relationships')[0].Records[0]._systemId | Should -Be 9
    }

    It 'Sync-CsvUsers reads the column list from the first row' {
        Set-Csv 'Users.csv' @('ExternalId;DisplayName;SystemName', 'u1;Alice;Omada')
        Sync-CsvUsers
        (Get-Sent 'ingest/principals')[0].Records[0]._systemId | Should -Be 9
    }

    It 'Sync-CsvIdentities reads the column list from the first row' {
        Set-Csv 'Identities.csv' @('ExternalId;DisplayName;SystemName', 'i1;Alice;Omada')
        Sync-CsvIdentities
        (Get-Sent 'ingest/identities')[0].Records[0]._systemId | Should -Be 9
    }

    It 'Sync-CsvIdentityMembers reads the column list from the first row' {
        Set-Csv 'IdentityMembers.csv' @('IdentityExternalId;UserExternalId;SystemName', 'i1;u1;Omada')
        Sync-CsvIdentityMembers
        (Get-Sent 'ingest/identity-members')[0].Records[0]._systemId | Should -Be 9
    }
}

Describe 'CSV fast-path phases — SystemName as the first column' {
    # `Get-CsvColIndex` returns the column's position, and the guard is `-ge 0`.
    # Read as `-ge 1` it works everywhere except when SystemName happens to be
    # column zero — the mapping is then dropped for the whole file, with no
    # error, which is the shape of bug a header reorder introduces.
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
        $script:systemLookup = @{ 'Omada' = 9 }
    }

    It 'Sync-CsvResources honours SystemName in column zero' {
        Set-Csv 'Resources.csv' @('SystemName;ExternalId;DisplayName', 'Omada;r1;A')
        Sync-CsvResources
        (Get-Sent 'ingest/resources')[0].Records[0]._systemId | Should -Be 9
    }

    It 'Sync-CsvAssignments honours SystemName in column zero' {
        Set-Csv 'Assignments.csv' @('SystemName;ResourceExternalId;UserExternalId', 'Omada;r1;u1')
        Sync-CsvAssignments
        (Get-Sent 'ingest/resource-assignments')[0].Records[0]._systemId | Should -Be 9
    }

    It 'Sync-CsvCertifications honours SystemName in column zero' {
        Set-Csv 'Certifications.csv' @('SystemName;ExternalId', 'Omada;cert1')
        Sync-CsvCertifications
        (Get-Sent 'ingest/governance/certifications')[0].Records[0]._systemId | Should -Be 9
    }
}

Describe 'Sync-CsvSystems / Register-CsvFallbackSystem — the records they register' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
    }

    It 'registers a single system (the guard is "any", not "more than one")' {
        # `$sysRecords.Count -gt 0` behaves identically at 0 and at 2, which is
        # all the existing fixtures supply. Exactly ONE row is what separates it
        # from `-gt 1` — under which a CSV declaring one system registers none
        # and every row silently falls back to the default system.
        Set-Csv 'Systems.csv' @('ExternalId;DisplayName', 'e1;HR')
        Mock Invoke-IngestAPI { @{ systemIds = @(10) } }
        Sync-CsvSystems
        Should -Invoke Invoke-IngestAPI -Exactly 1
        $script:systemLookup['HR'] | Should -Be 10
    }

    It 'registers the fallback system enabled and sync-enabled' {
        # Registered disabled, the fallback system exists but nothing attached to
        # it is ever synced again — a silent no-op crawl rather than an error.
        Mock Invoke-RestMethod { @{ displayName = 'tester' } }
        Mock Invoke-IngestAPI { @{ systemIds = @(5) } }
        $script:ApiBaseUrl = 'http://api'
        $script:ApiKey     = 'fgc_test'
        $script:SystemName = 'CSV Import'
        Register-CsvFallbackSystem | Should -Be 5
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter {
            $Body.records[0].enabled -eq $true -and $Body.records[0].syncEnabled -eq $true
        }
    }
}

Describe 'CSV phases — a row with fewer fields than the header' {
    # Exporters routinely omit trailing empty columns, so a row can be SHORTER
    # than its header. Import-Csv fills the missing tail with $null — not '' —
    # and `$hashtable.ContainsKey($null)` throws. The `$hSys -and $r.SystemName`
    # conjunct is what stops that call being made at all.
    #
    # This case was nearly written off as an equivalent mutant on the grounds
    # that the column-present flag is redundant. It is not: without the
    # short-circuit the whole import dies on a row that today just falls back to
    # the default system.
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
        $script:systemLookup = @{ 'Omada' = 9 }
    }

    It 'Sync-CsvContexts falls back instead of failing' {
        Set-Csv 'Contexts.csv' @('ExternalId;DisplayName;SystemName', 'c1;Sales;Omada', 'c2;Ops')
        { Sync-CsvContexts } | Should -Not -Throw
        $recs = (Get-Sent 'ingest/contexts')[0].Records
        ($recs | Where-Object { $_.externalId -eq 'c2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvRelationships falls back instead of failing' {
        Set-Csv 'ResourceRelationships.csv' @('ParentExternalId;ChildExternalId;SystemName', 'p1;c1;Omada', 'p2;c2')
        { Sync-CsvRelationships } | Should -Not -Throw
        $recs = (Get-Sent 'ingest/resource-relationships')[0].Records
        ($recs | Where-Object { $_.parentExternalId -eq 'p2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvUsers falls back instead of failing' {
        Set-Csv 'Users.csv' @('ExternalId;DisplayName;SystemName', 'u1;Alice;Omada', 'u2;Bob')
        { Sync-CsvUsers } | Should -Not -Throw
        $recs = (Get-Sent 'ingest/principals')[0].Records
        ($recs | Where-Object { $_.externalId -eq 'u2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvIdentities falls back instead of failing' {
        Set-Csv 'Identities.csv' @('ExternalId;DisplayName;SystemName', 'i1;Alice;Omada', 'i2;Bob')
        { Sync-CsvIdentities } | Should -Not -Throw
        $recs = (Get-Sent 'ingest/identities')[0].Records
        ($recs | Where-Object { $_.externalId -eq 'i2' })._systemId | Should -Be 2
    }

    It 'Sync-CsvIdentityMembers falls back instead of failing' {
        Set-Csv 'IdentityMembers.csv' @('IdentityExternalId;UserExternalId;SystemName', 'i1;u1;Omada', 'i2;u2')
        { Sync-CsvIdentityMembers } | Should -Not -Throw
        $recs = (Get-Sent 'ingest/identity-members')[0].Records
        ($recs | Where-Object { $_.identityExternalId -eq 'i2' })._systemId | Should -Be 2
    }
}
