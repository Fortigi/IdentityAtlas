#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/shared/Invoke-CrawlerIngestStage.ps1 —
    the crawler side of the staged load.

.DESCRIPTION
    Invoke-IngestAPI is the only boundary mocked; it records every call. What
    these pin is the protocol a stage consumer has to get right: one open per
    (entity, system, scope), batches that never exceed the batch size, a flush
    that does NOT apply anything, and a finalize that carries the delete and its
    share ceiling together. Nothing reaches the target table before that
    finalize, which is what makes a read that fails part-way harmless.

.USAGE
    Invoke-Pester -Path test/unit/CrawlerIngestStage.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $shared = Join-Path $script:repoRoot 'tools' 'crawlers' 'shared'
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $shared 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $shared 'Invoke-CrawlerIngestStage.ps1')

    function Reset-StageTest { $script:calls = [System.Collections.Generic.List[object]]::new(); $script:stageSeq = 0 }
    $script:StageApiMock = {
        $script:calls.Add(@{ Endpoint = $Endpoint; Body = $Body })
        if ($Endpoint -eq 'ingest/stages') { $script:stageSeq++; return @{ stageId = "st$($script:stageSeq)"; table = 'ResourceAssignments' } }
        if ($Endpoint -eq 'ingest/stages/finalize') {
            return @{ results = @($Body.stageIds | ForEach-Object { @{ stageId = $_; path = 'merge'; inserted = 0; updated = 0; deleted = 2 } }) }
        }
        return @{ rows = @($Body.records).Count }
    }
    function Get-Calls { param([string]$Endpoint) @($script:calls | Where-Object { $_.Endpoint -eq $Endpoint }) }
}

Describe 'New-CrawlerIngestStage' {
    BeforeEach { Reset-StageTest; Mock Invoke-IngestAPI $script:StageApiMock }

    It 'opens the stage for its entity, system and scope, in the run id namespace' {
        $stage = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 11 -IdPrefix 'sql-7' `
            -Scope @{ assignmentType = 'Direct'; resourceType = 'Entitlement' } -BatchSize 2
        $stage.StageId | Should -Be 'st1'
        $body = @(Get-Calls 'ingest/stages')[0].Body
        $body.entity | Should -Be 'resource-assignments'
        $body.systemId | Should -Be 11
        $body.idGeneration | Should -Be 'deterministic'
        # The NAMESPACE is the run's, not the system's — sql-7 even for system 11
        # — and it carries the entity suffix the API recovers the prefix from.
        $body.idPrefix | Should -Be 'sql-7-resource-assignments'
        $body.scope.assignmentType | Should -Be 'Direct'
    }

    It 'fails loudly when the API answers without a stage id' {
        Mock Invoke-IngestAPI { @{ } }
        { New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 3 -IdPrefix 'sql-7' } |
            Should -Throw -ExpectedMessage '*did not return a stageId*'
    }
}

Describe 'Add-CrawlerIngestStageRecord / Complete-CrawlerIngestStage' {
    BeforeEach { Reset-StageTest; Mock Invoke-IngestAPI $script:StageApiMock }

    It 'sends a batch as soon as it is full and the remainder on completion' {
        $stage = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 7 -IdPrefix 'sql-7' -BatchSize 2
        foreach ($i in 1..5) { Add-CrawlerIngestStageRecord -Stage $stage -Record @{ resourceExternalId = "e$i"; principalExternalId = 'u1' } }
        # Two full batches so far; the fifth record is still buffered.
        @(Get-Calls 'ingest/stages/st1/rows').Count | Should -Be 2
        $totals = Complete-CrawlerIngestStage -Stage $stage
        @(Get-Calls 'ingest/stages/st1/rows').Count | Should -Be 3
        $totals.sent | Should -Be 5
        $totals.batches | Should -Be 3
        # No batch ever exceeds the batch size — the whole point of streaming.
        foreach ($c in (Get-Calls 'ingest/stages/st1/rows')) { @($c.Body.records).Count | Should -BeLessOrEqual 2 }
    }

    It 'completing a stage applies NOTHING — finalize is a separate, deliberate step' {
        $stage = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 7 -IdPrefix 'sql-7' -BatchSize 100
        Add-CrawlerIngestStageRecord -Stage $stage -Record @{ resourceExternalId = 'e1'; principalExternalId = 'u1' }
        Complete-CrawlerIngestStage -Stage $stage | Out-Null
        @(Get-Calls 'ingest/stages/finalize').Count | Should -Be 0
    }

    It 'a stage that received nothing sends no batch at all' {
        $stage = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 7 -IdPrefix 'sql-7'
        (Complete-CrawlerIngestStage -Stage $stage).sent | Should -Be 0
        @(Get-Calls 'ingest/stages/st1/rows').Count | Should -Be 0
    }

    It 'serialises a single record as an ARRAY, or the API rejects the batch' {
        $stage = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 7 -IdPrefix 'sql-7'
        Add-CrawlerIngestStageRecord -Stage $stage -Record @{ resourceExternalId = 'e1'; principalExternalId = 'u1' }
        Complete-CrawlerIngestStage -Stage $stage | Out-Null
        $json = @{ records = @(Get-Calls 'ingest/stages/st1/rows')[0].Body.records } | ConvertTo-Json -Depth 5 -Compress
        $json | Should -Match '"records":\['
    }
}

Describe 'Invoke-CrawlerIngestStageFinalize' {
    BeforeEach { Reset-StageTest; Mock Invoke-IngestAPI $script:StageApiMock }

    It 'finalizes every stage of a run together, with the delete and the ceiling on the same call' {
        $a = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 11 -IdPrefix 'sql-7'
        $b = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 12 -IdPrefix 'sql-7'
        $results = Invoke-CrawlerIngestStageFinalize -Stages @($a, $b) -DeleteMissing -MaxDeleteShare 0.05
        $body = @(Get-Calls 'ingest/stages/finalize')[0].Body
        # Together, not one at a time: that is what lets a first load take the
        # empty-table path for the whole run instead of for its first system.
        $body.stageIds | Should -Be @('st1', 'st2')
        $body.deleteMissing | Should -BeTrue
        $body.maxDeleteShare | Should -Be 0.05
        @($results).Count | Should -Be 2
    }

    It 'omits the ceiling entirely when there is none, rather than sending zero' {
        $a = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 11 -IdPrefix 'sql-7'
        Invoke-CrawlerIngestStageFinalize -Stages @($a) -DeleteMissing | Out-Null
        @(Get-Calls 'ingest/stages/finalize')[0].Body.ContainsKey('maxDeleteShare') | Should -BeFalse
    }

    It 'never deletes unless asked' {
        $a = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 11 -IdPrefix 'sql-7'
        Invoke-CrawlerIngestStageFinalize -Stages @($a) | Out-Null
        @(Get-Calls 'ingest/stages/finalize')[0].Body.deleteMissing | Should -BeFalse
    }

    It 'calls nothing when there are no stages' {
        Invoke-CrawlerIngestStageFinalize -Stages @() -DeleteMissing | Should -BeNullOrEmpty
        Should -Invoke Invoke-IngestAPI -Exactly 0
    }
}

Describe 'Remove-CrawlerIngestStage' {
    BeforeEach { Reset-StageTest; Mock Invoke-IngestAPI $script:StageApiMock }

    It 'abandons the stage by id' {
        Mock Invoke-RestMethod { $script:abandoned = $Uri }
        $stage = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 7 -IdPrefix 'sql-7'
        Remove-CrawlerIngestStage -Stage $stage
        $script:abandoned | Should -Be 'http://localhost:3001/api/ingest/stages/st1'
    }

    It 'never throws — an unfinalized stage also expires on its own' {
        Mock Invoke-RestMethod { throw 'connection reset' }
        $stage = New-CrawlerIngestStage -Entity 'resource-assignments' -SystemId 7 -IdPrefix 'sql-7'
        { Remove-CrawlerIngestStage -Stage $stage } | Should -Not -Throw
    }
}
