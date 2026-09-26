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
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngestStream.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Functions.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Transform.ps1')
    . (Join-Path $script:csvDir 'CSVCrawler.Phases.ps1')

    # Scope state the phases + helpers resolve at call time.
    $script:CsvFolder        = $TestDrive
    $script:Delimiter        = ';'
    $script:SystemType       = 'CSV'
    $script:fallbackSystemId = 2
    $script:JobId            = 0

    # BatchSize is captured because one phase overrides it, and a mock that drops
    # a parameter makes every assertion about that parameter impossible to write —
    # which is how a test named "with a 3000 batch size" ended up asserting
    # everything except the batch size.
    $script:SendMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Scope = $Scope; SyncMode = $SyncMode; Records = @($Records); BatchSize = $BatchSize })
    }
    # Resources and Assignments STREAM through Invoke-IngestAPI rather than going
    # through Send-GroupedBySystem. This records each streamed post in the same
    # shape as SendMock, with the envelope's systemId stamped back onto every
    # record as _systemId, so routing assertions read the same either way.
    $script:StreamMock = {
        $sid = $Body.systemId
        $recs = @(@($Body.records) | ForEach-Object { $c = $_.Clone(); $c['_systemId'] = $sid; $c })
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Scope = $Body.scope; SyncMode = $Body.syncMode; Records = $recs; BatchSize = $null })
        @{ inserted = $recs.Count; updated = 0 }
    }
    function Use-StreamMocks {
        Mock Invoke-IngestAPI $script:StreamMock
        Mock Get-CrawlerServerTime { '2026-09-25T10:00:00.000Z' }
        Mock Invoke-CrawlerReconcile { 0 }
    }
    # Every record posted to $Endpoint, across posts (one per system, or per chunk).
    function Get-SentRecords {
        param([string]$Endpoint)
        , @(Get-Sent $Endpoint | ForEach-Object { $_.Records })   # comma: a single record must stay indexable
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
        Use-StreamMocks
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
        $recs = Get-SentRecords 'ingest/resources'
        $recs.Count | Should -Be 2
        ($recs | Where-Object { $_.externalId -eq 'r1' }).resourceType | Should -Be 'BusinessRole'
        ($recs | Where-Object { $_.externalId -eq 'r1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.externalId -eq 'r2' })._systemId | Should -Be 2
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
    # Assignments are STREAMED now — the file is never held in memory, so these
    # assert on what actually reached the ingest API rather than on a
    # Send-GroupedBySystem call that no longer happens for this phase.
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Get-CrawlerServerTime { '2026-09-25T10:00:00.000Z' }
        Mock Invoke-CrawlerReconcile { $script:reconciled.Add(@{ Endpoint = $Endpoint; SystemId = $SystemId; Scope = $Scope; Before = $Before }); 0 }
        Mock Invoke-IngestAPI { $script:posted.Add(@{ Endpoint = $Endpoint; Body = $Body }); @{ inserted = @($Body.records).Count; updated = 0 } }
        $script:posted = [System.Collections.Generic.List[object]]::new()
        $script:reconciled = [System.Collections.Generic.List[object]]::new()
    }

    It 'warns and returns when Assignments.csv is absent' {
        Remove-Csv 'Assignments.csv'
        Sync-CsvAssignments
        $script:posted.Count | Should -Be 0
        $script:reconciled.Count | Should -Be 0
    }

    It 'throws when required columns are missing, before spending an API call' {
        Set-Csv 'Assignments.csv' @('ResourceExternalId;Foo', 'r1;x')
        { Sync-CsvAssignments } | Should -Throw '*missing required columns*'
        Should -Invoke Get-CrawlerServerTime -Exactly 0
    }

    It 'streams Direct-scoped assignments, honouring an explicit AssignmentType' {
        Set-Csv 'Assignments.csv' @(
            'ResourceExternalId;UserExternalId;AssignmentType'
            'r1;u1;Eligible'
            'r2;u2;'
            ';u3;Direct'
        )
        Sync-CsvAssignments
        $script:posted.Count | Should -Be 1
        $body = $script:posted[0].Body
        $script:posted[0].Endpoint | Should -Be 'ingest/resource-assignments'
        $body.scope.assignmentType | Should -Be 'Direct'
        $body.syncMode | Should -Be 'delta'          # chunks upsert; the reconcile does the deleting
        $recs = @($body.records)
        $recs.Count | Should -Be 2                   # the row with no resource id is skipped
        ($recs | Where-Object { $_.resourceExternalId -eq 'r1' }).assignmentType | Should -Be 'Eligible'
        ($recs | Where-Object { $_.resourceExternalId -eq 'r2' }).assignmentType | Should -Be 'Direct'
    }

    It 'reconciles each system it fed, against the clock read before the first row' {
        Set-Csv 'Assignments.csv' @('ResourceExternalId;UserExternalId', 'r1;u1')
        Sync-CsvAssignments
        $script:reconciled.Count | Should -Be 1
        $script:reconciled[0].Endpoint | Should -Be 'ingest/resource-assignments'
        $script:reconciled[0].Before | Should -Be '2026-09-25T10:00:00.000Z'
        $script:reconciled[0].Scope.assignmentType | Should -Be 'Direct'
    }

    It 'never reconciles when the file yielded no rows — an empty file must not wipe a system' {
        Set-Csv 'Assignments.csv' @('ResourceExternalId;UserExternalId')
        Sync-CsvAssignments
        $script:posted.Count | Should -Be 0
        $script:reconciled.Count | Should -Be 0
    }

    It 'holds only one batch in memory: a file larger than the batch posts as it goes' {
        # 25,000 rows with a 10,000 batch size -> 2 flushes DURING the read, one at
        # the end. If the phase were still materialising, there would be exactly one.
        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add('ResourceExternalId;UserExternalId')
        for ($i = 0; $i -lt 25000; $i++) { $lines.Add("r$i;u$i") }
        Set-Csv 'Assignments.csv' $lines
        Sync-CsvAssignments
        $script:posted.Count | Should -Be 3
        @($script:posted | ForEach-Object { @($_.Body.records).Count }) | Should -Be @(10000, 10000, 5000)
    }

    It 'delivers every row exactly once across read-batch and send-chunk boundaries, for two interleaved systems' {
        # 23,001 rows alternating between two systems: each system's stream fills
        # partway through a 10,000-row read batch, so chunks are cut mid-batch and
        # the remainder carried into the next one. A slice error there drops or
        # repeats rows without failing anything.
        $script:systemLookup = @{ 'HR' = 7; 'AD' = 8 }
        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add('ResourceExternalId;UserExternalId;SystemName')
        for ($i = 0; $i -lt 23001; $i++) { $lines.Add("r$i;u$i;$(if ($i % 2) { 'AD' } else { 'HR' })") }
        Set-Csv 'Assignments.csv' $lines
        Sync-CsvAssignments
        foreach ($p in $script:posted) { @($p.Body.records).Count | Should -BeLessOrEqual 10000 }
        $hr = @($script:posted | Where-Object { $_.Body.systemId -eq 7 } | ForEach-Object { @($_.Body.records) } | ForEach-Object resourceExternalId)
        $ad = @($script:posted | Where-Object { $_.Body.systemId -eq 8 } | ForEach-Object { @($_.Body.records) } | ForEach-Object resourceExternalId)
        $hr.Count | Should -Be 11501
        $ad.Count | Should -Be 11500
        @($hr | Select-Object -Unique).Count | Should -Be 11501
        $hr[0] | Should -Be 'r0'; $hr[-1] | Should -Be 'r23000'
        $ad[0] | Should -Be 'r1'; $ad[-1] | Should -Be 'r22999'
        # Each system reconciles once, against its own id.
        @($script:reconciled | ForEach-Object SystemId | Sort-Object) | Should -Be @(7, 8)
    }

    It 'reads a header with a byte order mark, quoted cells and CRLF line endings' {
        $bytes = [System.Text.Encoding]::UTF8.GetPreamble() + [System.Text.Encoding]::UTF8.GetBytes(
            "`"ResourceExternalId`";`"UserExternalId`";`"AssignmentType`"`r`n`"CN=Fin;OU=Groups`";`"u1`";`"Eligible`"`r`nr2;u2;`r`n")
        [System.IO.File]::WriteAllBytes((Join-Path $TestDrive 'Assignments.csv'), $bytes)
        Sync-CsvAssignments
        $recs = @($script:posted[0].Body.records)
        $recs.Count | Should -Be 2
        # The delimiter inside the quoted DN stays in the id; no quote survives.
        $recs[0].resourceExternalId | Should -Be 'CN=Fin;OU=Groups'
        $recs[0].assignmentType | Should -Be 'Eligible'
        $recs[1].principalExternalId | Should -Be 'u2'       # no stray `r on the last cell
        $recs[1].assignmentType | Should -Be 'Direct'
    }

    It 'skips and counts a row missing a required id, without failing the run' {
        Mock Write-Host { }
        Set-Csv 'Assignments.csv' @('ResourceExternalId;UserExternalId', 'r1;u1', ';u2', 'r3;', 'r4;u4')
        { Sync-CsvAssignments } | Should -Not -Throw
        @($script:posted[0].Body.records | ForEach-Object resourceExternalId) | Should -Be @('r1', 'r4')
        Should -Invoke Write-Host -ParameterFilter { "$Object" -like '*4 rows read, 2 sent, 2 skipped*' } -Exactly 1
        $script:reconciled.Count | Should -Be 1               # a partly-bad file is still a full sync
    }

    It 'sends a pair held both Direct and Eligible as two assignments' {
        Set-Csv 'Assignments.csv' @('ResourceExternalId;UserExternalId;AssignmentType', 'r1;u1;Direct', 'r1;u1;Eligible')
        Sync-CsvAssignments
        @($script:posted[0].Body.records | ForEach-Object assignmentType | Sort-Object) | Should -Be @('Direct', 'Eligible')
    }

    It 'does not reconcile when every row was skipped — nothing was touched, so nothing may be removed' {
        Set-Csv 'Assignments.csv' @('ResourceExternalId;UserExternalId', ';u1', 'r2;')
        Sync-CsvAssignments
        $script:posted.Count | Should -Be 0
        $script:reconciled.Count | Should -Be 0
    }

    It 'does not reconcile when a read fails partway — the run never completed' {
        # An unterminated quote aborts the read after the first chunk has gone out.
        # Reconciling then would delete every assignment past the failure point.
        $lines = @('ResourceExternalId;UserExternalId') + @(1..10000 | ForEach-Object { "r$_;u$_" }) + @('"broken;u') + @(1..1001 | ForEach-Object { "x$_;y" })
        [System.IO.File]::WriteAllLines((Join-Path $TestDrive 'Assignments.csv'), $lines)
        { Sync-CsvAssignments } | Should -Throw '*Assignments.csv line 10002 is not valid CSV*'
        $script:posted.Count | Should -Be 1
        $script:reconciled.Count | Should -Be 0
    }

    It 'names extra columns in the log as ignored — Assignments does not keep them' {
        Mock Write-Host { }
        Set-Csv 'Assignments.csv' @('ResourceExternalId;UserExternalId;grantedBy', 'r1;u1;alice')
        Sync-CsvAssignments
        $script:posted[0].Body.records[0].ContainsKey('grantedBy') | Should -BeFalse
        Should -Invoke Write-Host -ParameterFilter { "$Object" -like '*ignored*Assignments.csv*grantedBy*' } -Exactly 1
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
        # The name of this test promised the batch size and never checked it.
        # Certifications is the one phase that overrides the default, because the
        # records are small and the volume is high; losing the override silently
        # multiplies the request count on the largest table this crawler sends.
        $sent[0].BatchSize | Should -Be 3000
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

    It 'throws when the API returns neither, instead of guessing a system to scope deletes to' {
        # SEC-2026-09 M-11: this used to return a hard-coded id 2, so every scoped
        # full-sync reconcile of the run would have targeted another system's rows.
        Mock Invoke-IngestAPI { @{} }
        { Register-CsvFallbackSystem } | Should -Throw '*Could not resolve the CSV fallback system id*'
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
        Use-StreamMocks
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
        $recs = Get-SentRecords 'ingest/resources'
        ($recs | Where-Object { $_.externalId -eq 'r1' })._systemId | Should -Be 9
        ($recs | Where-Object { $_.externalId -eq 'r2' })._systemId | Should -Be 2
        ($recs | Where-Object { $_.externalId -eq 'r3' })._systemId | Should -Be 2
    }

    It 'Sync-CsvAssignments resolves a known system and falls back for an unknown one' {
        # Streamed now, so the system is not a field on the record — it selects
        # WHICH stream the row joins, and each stream posts under its own
        # systemId. Inverting the  guard sends every row to the
        # fallback system, which this still catches.
        Mock Get-CrawlerServerTime { '2026-09-25T10:00:00.000Z' }
        Mock Invoke-CrawlerReconcile { 0 }
        $posted = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $posted.Add($Body); @{ inserted = @($Body.records).Count } }
        Set-Csv 'Assignments.csv' @('ResourceExternalId;UserExternalId;SystemName', 'r1;u1;Omada', 'r2;u2;NoSuchSystem')
        Sync-CsvAssignments
        $bySystem = @{}
        foreach ($b in $posted) { foreach ($r in @($b.records)) { $bySystem[$r.resourceExternalId] = $b.systemId } }
        $bySystem['r1'] | Should -Be 9    # matched the lookup
        $bySystem['r2'] | Should -Be 2    # unknown name -> fallback
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
        Use-StreamMocks
        $script:systemLookup = @{ 'Omada' = 9 }
    }

    It 'Sync-CsvResources honours SystemName in column zero' {
        Set-Csv 'Resources.csv' @('SystemName;ExternalId;DisplayName', 'Omada;r1;A')
        Sync-CsvResources
        (Get-Sent 'ingest/resources')[0].Records[0]._systemId | Should -Be 9
    }

    It 'Sync-CsvAssignments honours SystemName in column zero' {
        Mock Get-CrawlerServerTime { '2026-09-25T10:00:00.000Z' }
        Mock Invoke-CrawlerReconcile { 0 }
        $posted = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $posted.Add($Body); @{ inserted = @($Body.records).Count } }
        Set-Csv 'Assignments.csv' @('SystemName;ResourceExternalId;UserExternalId', 'Omada;r1;u1')
        Sync-CsvAssignments
        $posted.Count | Should -Be 1
        $posted[0].systemId | Should -Be 9
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

Describe 'CSV phases — extra columns reach the ingest records' {
    # End to end through the real readers (Import-Csv for the slow path,
    # Read-CsvFast for the fast one): the docs promise that a column outside the
    # schema is kept as extendedAttributes, and each file that keeps them is
    # exercised here with a column the schema does not know.
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
        Use-StreamMocks
    }

    It 'Sync-CsvResources keeps an extra column (fast path), including one in position 0' {
        Set-Csv 'Resources.csv' @('Region;ExternalId;DisplayName;Owner', 'EU;r1;Payroll;jan', 'US;r2;Ledger;')
        Sync-CsvResources
        $recs = Get-SentRecords 'ingest/resources'
        ($recs | Where-Object { $_.externalId -eq 'r1' }).Region | Should -Be 'EU'
        ($recs | Where-Object { $_.externalId -eq 'r1' }).Owner | Should -Be 'jan'
        ($recs | Where-Object { $_.externalId -eq 'r2' }).ContainsKey('Owner') | Should -BeFalse
    }

    It 'Sync-CsvResources sends a pure-schema file with no extra keys at all' {
        Set-Csv 'Resources.csv' @('ExternalId;DisplayName;SystemName', 'r1;A;')
        Sync-CsvResources
        @((Get-Sent 'ingest/resources')[0].Records[0].Keys | Sort-Object) |
            Should -Be @('_systemId', 'description', 'displayName', 'enabled', 'externalId', 'resourceType')
    }

    It 'Sync-CsvCertifications keeps an extra column (fast path)' {
        Set-Csv 'Certifications.csv' @('ExternalId;Decision;Campaign', 'c1;Approve;Q3')
        Sync-CsvCertifications
        (Get-Sent 'ingest/governance/certifications')[0].Records[0].Campaign | Should -Be 'Q3'
    }

    It 'Sync-CsvUsers keeps an extra column and reads a lower-case schema column as that column' {
        # "department" IS the Department column. Before the column set was made
        # case-insensitive, the shaper read it as absent AND the extras skipped it
        # as reserved: the value was lost both ways.
        Set-Csv 'Users.csv' @('ExternalId;DisplayName;department;CostCenter', 'u1;Ann;Finance;NL01')
        Sync-CsvUsers
        $rec = (Get-Sent 'ingest/principals')[0].Records[0]
        $rec.department | Should -Be 'Finance'
        $rec.CostCenter | Should -Be 'NL01'
    }

    It 'Sync-CsvIdentities keeps an extra column' {
        Set-Csv 'Identities.csv' @('ExternalId;DisplayName;EmployeeStatus', 'i1;Ann;Active')
        Sync-CsvIdentities
        (Get-Sent 'ingest/identities')[0].Records[0].EmployeeStatus | Should -Be 'Active'
    }

    It 'Sync-CsvContexts keeps an extra column' {
        Set-Csv 'Contexts.csv' @('ExternalId;DisplayName;CostCenter', 'c1;Sales;CC9')
        Sync-CsvContexts
        (Get-Sent 'ingest/contexts')[0].Records[0].CostCenter | Should -Be 'CC9'
    }

    It 'Sync-CsvRelationships keeps an extra column' {
        Set-Csv 'ResourceRelationships.csv' @('ParentExternalId;ChildExternalId;GrantedOn', 'p1;c1;2024-01-01')
        Sync-CsvRelationships
        (Get-Sent 'ingest/resource-relationships')[0].Records[0].GrantedOn | Should -Be '2024-01-01'
    }

    It 'Sync-CsvSystems keeps an extra column' {
        Set-Csv 'Systems.csv' @('ExternalId;DisplayName;Owner', 's1;SAP;Ops')
        Mock Invoke-IngestAPI { $script:sysBody = $Body; @{ systemIds = @(10) } }
        Sync-CsvSystems
        $script:sysBody.records[0].Owner | Should -Be 'Ops'
    }

    It 'Sync-CsvIdentityMembers does not keep extras, and says so' {
        Mock Write-Host { }
        Set-Csv 'IdentityMembers.csv' @('IdentityExternalId;UserExternalId;Reason', 'i1;u1;merge')
        Sync-CsvIdentityMembers
        (Get-Sent 'ingest/identity-members')[0].Records[0].ContainsKey('Reason') | Should -BeFalse
        Should -Invoke Write-Host -ParameterFilter { "$Object" -like '*ignored*IdentityMembers.csv*Reason*' } -Exactly 1
    }
}

Describe 'CSV phases — a comma-delimited export full of LDAP distinguished names' {
    # The motivating export's entitlement values are DNs: commas everywhere. The
    # fast reader used to split each line on the delimiter and strip quotes per
    # cell, so a quoted DN was torn apart and every later column shifted by one —
    # accepted without an error. These files are comma-delimited on purpose.
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
        Use-StreamMocks
        $script:Delimiter = ','
    }
    AfterEach { $script:Delimiter = ';' }

    It 'Sync-CsvResources keeps DN ids, doubled quotes, a multi-line and an empty quoted value in their columns' {
        $text = @(
            'ExternalId,DisplayName,Description,Owner'
            '"CN=Fin,OU=Groups,DC=corp,DC=com","Finance, all","say ""hi""",ann'
            '"CN=Ops,OU=Groups,DC=corp,DC=com",Ops,"line one'
            'line two",""'
            'plain,Plain,,bob'
        ) -join "`r`n"
        [System.IO.File]::WriteAllText((Join-Path $TestDrive 'Resources.csv'), $text + "`r`n", [System.Text.UTF8Encoding]::new($true))
        Sync-CsvResources
        $recs = Get-SentRecords 'ingest/resources'
        $recs.Count | Should -Be 3
        $fin = $recs | Where-Object { $_.externalId -eq 'CN=Fin,OU=Groups,DC=corp,DC=com' }
        $fin.displayName | Should -Be 'Finance, all'
        $fin.description | Should -Be 'say "hi"'
        $fin.Owner | Should -Be 'ann'                      # the column after the DN did not shift
        $ops = $recs | Where-Object { $_.externalId -eq 'CN=Ops,OU=Groups,DC=corp,DC=com' }
        $ops.description | Should -Be "line one`r`nline two"
        $ops.ContainsKey('Owner') | Should -BeFalse         # "" is empty, not a value
        ($recs | Where-Object { $_.externalId -eq 'plain' }).Owner | Should -Be 'bob'
    }

    It 'Sync-CsvAssignments keeps a DN resource id whole' {
        Set-Csv 'Assignments.csv' @(
            'ResourceExternalId,UserExternalId,AssignmentType'
            '"CN=Fin,OU=Groups,DC=corp,DC=com",u1,Eligible'
        )
        Sync-CsvAssignments
        $rec = (Get-SentRecords 'ingest/resource-assignments')[0]
        $rec.resourceExternalId | Should -Be 'CN=Fin,OU=Groups,DC=corp,DC=com'
        $rec.principalExternalId | Should -Be 'u1'
        $rec.assignmentType | Should -Be 'Eligible'
    }

    It 'Sync-CsvContextMembers keeps a DN member id whole' {
        Set-Csv 'ContextMembers.csv' @(
            'ContextExternalId,MemberExternalId,MemberType'
            'app-payroll,"CN=Fin,OU=Groups,DC=corp,DC=com",Resource'
        )
        Sync-CsvContextMembers
        $rec = @((Get-Sent 'ingest/context-members')[0].Records)[0]
        $rec.memberExternalId | Should -Be 'CN=Fin,OU=Groups,DC=corp,DC=com'
        $rec.memberType | Should -Be 'Resource'
    }

    It 'fails the file, rather than loading shifted rows, on a quote that never closes' {
        Set-Csv 'Resources.csv' @('ExternalId,DisplayName', 'r1,A', '"CN=Broken,OU=x,B', 'r3,C')
        { Sync-CsvResources } | Should -Throw '*Resources.csv line 3 is not valid CSV*'
        Should -Invoke Invoke-CrawlerReconcile -Exactly 0
    }
}

Describe 'Sync-CsvContextMembers — the fast reader, one full sync' {
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
    }

    It 'sends every membership in ONE full sync, whatever SystemName says' {
        # ContextMembers has no systemId: a full sync of it removes the members of
        # every context the crawler owns. One sync per system would have each one
        # delete the others' — so SystemName is ignored and all rows go together.
        $script:systemLookup = @{ 'HR' = 7 }
        Set-Csv 'ContextMembers.csv' @('ContextExternalId;MemberExternalId;MemberType;SystemName', 'c1;m1;Resource;HR', 'c2;m2;Resource;AD', 'c3;m3;Resource;')
        Sync-CsvContextMembers
        $sent = Get-Sent 'ingest/context-members'
        $sent.Count | Should -Be 1
        @($sent[0].Records | ForEach-Object { $_._systemId } | Select-Object -Unique) | Should -Be @(2)
        @($sent[0].Records).Count | Should -Be 3
    }

    It 'reads past a batch boundary without losing or repeating a row' {
        $lines = @('ContextExternalId;MemberExternalId;MemberType') + @(1..10005 | ForEach-Object { "c1;m$_;Resource" })
        Set-Csv 'ContextMembers.csv' $lines
        Sync-CsvContextMembers
        $members = @((Get-Sent 'ingest/context-members')[0].Records | ForEach-Object { $_.memberExternalId })
        $members.Count | Should -Be 10005
        @($members | Select-Object -Unique).Count | Should -Be 10005
    }

    It 'throws on a missing required column before sending anything' {
        Set-Csv 'ContextMembers.csv' @('ContextExternalId;MemberExternalId', 'c1;m1')
        { Sync-CsvContextMembers } | Should -Throw '*ContextMembers.csv schema mismatch: missing MemberType*'
        @(Get-Sent 'ingest/context-members').Count | Should -Be 0
    }

    It 'sends nothing — not an empty full sync — when no row is usable' {
        # An empty full sync would remove every membership the crawler owns.
        Set-Csv 'ContextMembers.csv' @('ContextExternalId;MemberExternalId;MemberType', ';m1;Resource')
        Sync-CsvContextMembers
        @(Get-Sent 'ingest/context-members').Count | Should -Be 0
    }
}

Describe 'CSV phases — a SystemName that Systems.csv did not declare is reported' {
    # Rows naming an undeclared system still load (into the fallback system), but
    # never silently: an import once reported success while most of its data went
    # somewhere else. One warning per file, with the row count and the names.
    BeforeEach {
        Reset-CsvTestState
        Mock Update-CrawlerProgress { }
        Mock Send-GroupedBySystem $script:SendMock
        Use-StreamMocks
        Mock Write-Host { }
        $script:systemLookup = @{ 'HR' = 7 }
        $script:SystemName = 'CSV Import'
    }

    It 'Sync-CsvUsers (slow path) counts the fallen-back rows per name, and not the blank ones' {
        Set-Csv 'Users.csv' @('ExternalId;DisplayName;SystemName', 'u1;A;HR', 'u2;B;Ghost', 'u3;C;Ghost', 'u4;D;Other', 'u5;E;')
        Sync-CsvUsers
        Should -Invoke Write-Host -Exactly 1 -ParameterFilter {
            "$Object" -like "*WARNING: 3 row(s) in Users.csv*fallback system 'CSV Import'*Ghost (2), Other (1)"
        }
    }

    It 'Sync-CsvAssignments (streamed) totals the unknown names across batches' {
        $lines = @('ResourceExternalId;UserExternalId;SystemName') + @(1..10002 | ForEach-Object { if ($_ -le 2) { "r$_;u$_;HR" } else { "r$_;u$_;Ghost" } })
        Set-Csv 'Assignments.csv' $lines
        Sync-CsvAssignments
        Should -Invoke Write-Host -Exactly 1 -ParameterFilter { "$Object" -like '*WARNING: 10000 row(s) in Assignments.csv*Ghost (10000)' }
    }

    It 'Sync-CsvCertifications (fast path) reports them too' {
        Set-Csv 'Certifications.csv' @('ExternalId;SystemName', 'c1;Ghost')
        Sync-CsvCertifications
        Should -Invoke Write-Host -Exactly 1 -ParameterFilter { "$Object" -like '*WARNING: 1 row(s) in Certifications.csv*Ghost (1)' }
    }

    It 'says nothing when every named system is known' {
        Set-Csv 'Users.csv' @('ExternalId;DisplayName;SystemName', 'u1;A;HR', 'u2;B;')
        Sync-CsvUsers
        Should -Invoke Write-Host -Exactly 0 -ParameterFilter { "$Object" -like '*WARNING*' }
    }

    It 'lists at most ten names, most rows first, and says how many more there are' {
        $rows = @('ExternalId;DisplayName;SystemName') + @(1..12 | ForEach-Object { 'u{0};N;S{0:D2}' -f $_ }) + @('u99;N;S12')
        Set-Csv 'Users.csv' $rows
        Sync-CsvUsers
        Should -Invoke Write-Host -Exactly 1 -ParameterFilter { "$Object" -like '*13 row(s)*: S12 (2), S01 (1), S02 (1)*S09 (1), and 2 more' }
    }
}
