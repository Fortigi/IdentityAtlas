#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Staging.ps1 — the staged
    full load of assignment scopes.

.DESCRIPTION
    The ingest API is mocked and every call captured. The assertions are about
    what the crawler DECIDED: which scopes load through a stage (full sync,
    complete read, assignments only), that statements sharing a scope share its
    stage (two stages finalized with deleteMissing would delete each other's
    rows), that a staged scope registers no timestamp reconcile and is counted
    whole, and what the finalize is asked to do.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql' 'SqlCrawler.Load.ps1')
    . (Join-Path $PSScriptRoot 'SqlCrawlerReplay.ps1')

    $script:IngestMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Body = $Body; TimeoutSec = $TimeoutSec })
        if ($Endpoint -eq 'ingest/stages') { return @{ stageId = "stage-$($Body.systemId)-$($Body.scope.assignmentType)" } }
        if ($Endpoint -eq 'ingest/stages/finalize') { return @{ results = @($Body.stageIds | ForEach-Object { @{ stageId = $_; path = 'merge'; inserted = 2; updated = 1; deleted = 3; rows = 4 } }) } }
        if ($Endpoint -eq 'ingest/count') { return @{ count = 9 } }
        @{ inserted = @($Body.records).Count; updated = 0; rows = 1 }
    }
    function New-GrantSlot {
        param([string]$Name, [string]$Type = 'Direct')
        @{ name = $Name; target = 'assignments'; sql = "SELECT $Name"; enabled = $true; paged = $false
           resourceType = 'Entitlement'; assignmentType = $Type; governed = $false }
    }
    function New-StagingState {
        param([string]$SyncMode = 'full', [bool]$Staged = $true, [hashtable[]]$Slots = @())
        New-SqlRunState -SystemId 7 -ServerTime '2026-09-25T09:00:00.000Z' -Slots $Slots -BatchSize 2 -SyncMode $SyncMode -StagedFullLoad $Staged
    }
}

Describe 'Test-SqlStagedSpec' {
    It 'stages only a complete, reconciled assignment scope of a run that stages' {
        $on = @{ StageFullLoads = $true }; $off = @{ StageFullLoads = $false }
        Test-SqlStagedSpec -State $on -Endpoint 'ingest/resource-assignments' -Reconcile $true -Complete $true | Should -BeTrue
        Test-SqlStagedSpec -State $off -Endpoint 'ingest/resource-assignments' -Reconcile $true -Complete $true | Should -BeFalse
        # A window is not the complete set: deleteMissing would remove the rest.
        Test-SqlStagedSpec -State $on -Endpoint 'ingest/resource-assignments' -Reconcile $true -Complete $false | Should -BeFalse
        Test-SqlStagedSpec -State $on -Endpoint 'ingest/resource-assignments' -Reconcile $false -Complete $true | Should -BeFalse
        Test-SqlStagedSpec -State $on -Endpoint 'ingest/resources' -Reconcile $true -Complete $true | Should -BeFalse
    }

    It 'is on only for a FULL sync, however the crawler is configured' {
        (New-StagingState -SyncMode 'full').StageFullLoads | Should -BeTrue
        (New-StagingState -SyncMode 'delta').StageFullLoads | Should -BeFalse
        (New-StagingState -SyncMode 'full' -Staged $false).StageFullLoads | Should -BeFalse
    }
}

Describe 'A full sync of two statements feeding one scope' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Update-CrawlerProgress { }
        Mock Write-Host { }
        Mock Measure-SqlSource { @{ rows = [long]3; pairs = [long]3; reason = $null } }
        Mock Invoke-SqlQueryStream { Invoke-SqlTestReplay -Rows @($script:rows[$Sql]) -OnRow $OnRow -OnBatch $OnBatch; [long]@($script:rows[$Sql]).Count }
        $script:rows = @{
            'SELECT A' = @([ordered]@{ principalId = 'p1'; resourceId = 'r1' }, [ordered]@{ principalId = 'p2'; resourceId = 'r1' }, [ordered]@{ principalId = 'p3'; resourceId = 'r2' })
            'SELECT B' = @([ordered]@{ principalId = 'p4'; resourceId = 'r2' })
            'SELECT C' = @([ordered]@{ principalId = 'p5'; resourceId = 'r2' })
        }
    }

    It 'sends both into ONE stage per (system, scope), records only, and registers no timestamp reconcile' {
        $slots = @((New-GrantSlot 'A'), (New-GrantSlot 'B'), (New-GrantSlot 'C' -Type 'Indirect'))
        $state = New-StagingState -Slots $slots
        foreach ($s in $slots) { Invoke-SqlSlot -Slot $s -Connection 'c' -State $state | Out-Null }
        $opened = @($script:sent | Where-Object Endpoint -eq 'ingest/stages')
        # A and B share Direct; C is Indirect — two stages, not three.
        $opened.Count | Should -Be 2
        $opened[0].Body.entity | Should -Be 'resource-assignments'
        $opened[0].Body.systemId | Should -Be 7
        $opened[0].Body.idPrefix | Should -Be 'sql-7-resource-assignments'
        $opened[0].Body.scope.assignmentType | Should -Be 'Direct'
        $opened[0].Body.keysOnly | Should -BeFalse
        $direct = @($script:sent | Where-Object Endpoint -eq 'ingest/stages/stage-7-Direct/rows')
        # 3 rows at batch size 2 from A, then 1 from B: three batches, one stage.
        @($direct | ForEach-Object { @($_.Body.records).Count }) | Should -Be @(2, 1, 1)
        @($direct | ForEach-Object { $_.Body.Keys } | Sort-Object -Unique) | Should -Be @('records')
        @($script:sent | Where-Object Endpoint -eq 'ingest/resource-assignments').Count | Should -Be 0
        $state.Scopes.Count | Should -Be 0
        $state.Stages.Count | Should -Be 2
    }

    It 'counts a staged scope whole, since an unchanged row is deliberately not touched' {
        $state = New-StagingState -Slots @(New-GrantSlot 'A')
        Invoke-SqlSlot -Slot (New-GrantSlot 'A') -Connection 'c' -State $state | Out-Null
        $e = @($state.Expect.Values)[0]
        $e.Whole | Should -BeTrue
        Measure-SqlScopeRows -State $state -Expectation $e | Should -Be 9
        @($script:sent | Where-Object Endpoint -eq 'ingest/count')[0].Body.before | Should -Be '1970-01-01T00:00:00.000Z'
    }

    It 'verifies each staged scope against what its own finalize applied, not against the source' {
        $slots = @((New-GrantSlot 'A'), (New-GrantSlot 'B'), (New-GrantSlot 'C' -Type 'Indirect'))
        $state = New-StagingState -Slots $slots
        foreach ($s in $slots) { Invoke-SqlSlot -Slot $s -Connection 'c' -State $state | Out-Null }
        Mock Invoke-IngestAPI { @{ results = @(
            @{ stageId = 'stage-7-Indirect'; path = 'merge'; rows = 1; distinct = 1 },
            @{ stageId = 'stage-7-Direct'; path = 'merge'; rows = 4; distinct = 4 }) } } -ParameterFilter { $Endpoint -eq 'ingest/stages/finalize' }
        Complete-SqlStagedLoads -State $state | Out-Null
        $direct = @($state.Expect.Values | Where-Object { $_.Scope.assignmentType -eq 'Direct' })[0]
        $indirect = @($state.Expect.Values | Where-Object { $_.Scope.assignmentType -eq 'Indirect' })[0]
        # A and B feed the one Direct stage: 4, though the mocked source says 3 pairs each.
        $direct.Applied | Should -Be 4
        $indirect.Applied | Should -Be 1
        (Get-SqlScopeVerdict -Expectation $direct -Atlas 4).ok | Should -BeTrue
        (Get-SqlScopeVerdict -Expectation $direct -Atlas 6).ok | Should -BeFalse
    }

    It 'a delta run streams and reconciles as before' {
        $state = New-StagingState -SyncMode 'delta' -Slots @(New-GrantSlot 'A')
        Invoke-SqlSlot -Slot (New-GrantSlot 'A') -Connection 'c' -State $state | Out-Null
        @($script:sent | Where-Object Endpoint -eq 'ingest/stages').Count | Should -Be 0
        @($script:sent | Where-Object Endpoint -eq 'ingest/resource-assignments').Count | Should -Be 2
        $state.Scopes.Count | Should -Be 1
        @($state.Expect.Values)[0].Whole | Should -BeNullOrEmpty
        Measure-SqlScopeRows -State $state -Expectation @($state.Expect.Values)[0] | Out-Null
        @($script:sent | Where-Object Endpoint -eq 'ingest/count')[0].Body.before | Should -Be '2026-09-25T09:00:00.000Z'
    }
}

Describe 'Complete-SqlStagedLoads' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Update-CrawlerProgress { }
        Mock Write-Host { }
    }

    It 'finalizes every stage of the run in ONE call, removing what the stages do not hold, with a long timeout' {
        $state = New-StagingState
        $state.Stages['7|a'] = [pscustomobject]@{ StageId = 's1' }
        $state.Stages['9|a'] = [pscustomobject]@{ StageId = 's2' }
        $results = Complete-SqlStagedLoads -State $state
        $calls = @($script:sent | Where-Object Endpoint -eq 'ingest/stages/finalize')
        $calls.Count | Should -Be 1
        @($calls[0].Body.stageIds | Sort-Object) | Should -Be @('s1', 's2')
        $calls[0].Body.deleteMissing | Should -BeTrue
        # No share ceiling: the timestamp reconcile it replaces has none either.
        $calls[0].Body.ContainsKey('maxDeleteShare') | Should -BeFalse
        $calls[0].TimeoutSec | Should -Be 14400
        $results.Count | Should -Be 2
    }

    It 'tells each scope the distinct assignments its stages held, summed over its systems' {
        $direct = @{ Applied = $null }; $indirect = @{ Applied = $null }
        $state = New-StagingState
        $state.Stages['7|d'] = [pscustomobject]@{ StageId = 's1'; Expect = $direct }
        $state.Stages['9|d'] = [pscustomobject]@{ StageId = 's2'; Expect = $direct }
        $state.Stages['7|i'] = [pscustomobject]@{ StageId = 's3'; Expect = $indirect }
        Mock Invoke-IngestAPI { @{ results = @(
            @{ stageId = 's2'; path = 'merge'; rows = 9; distinct = 7 },
            @{ stageId = 's3'; path = 'empty-stage'; rows = 0; distinct = 0 },
            @{ stageId = 's1'; path = 'merge'; rows = 40; distinct = 30 }) } }
        Complete-SqlStagedLoads -State $state | Out-Null
        # distinct, not rows (49), and matched by stageId, not by position
        $direct.Applied | Should -Be 37
        $indirect.Applied | Should -Be 0
        $indirect.Applied | Should -Not -BeNullOrEmpty
    }
}

Describe 'Set-SqlStagedExpectations' {
    It 'leaves a scope to the source count when ANY of its stages came back without a distinct count' {
        $e = @{ Applied = $null }; $other = @{ Applied = $null }
        $stages = @([pscustomobject]@{ StageId = 's1'; Expect = $e }, [pscustomobject]@{ StageId = 's2'; Expect = $e },
                    [pscustomobject]@{ StageId = 's3'; Expect = $other })
        # s2 answered by an API that predates `distinct`; s3 is complete.
        Set-SqlStagedExpectations -Stages $stages -Results @(
            @{ stageId = 's1'; distinct = 5 }, @{ stageId = 's2'; rows = 3 }, @{ stageId = 's3'; distinct = 4 })
        $e.Applied | Should -BeNullOrEmpty
        $other.Applied | Should -Be 4
    }

    It 'ignores a stage with no result and a stage that carries no expectation' {
        $e = @{ Applied = $null }
        Set-SqlStagedExpectations -Stages @([pscustomobject]@{ StageId = 'gone'; Expect = $e }, [pscustomobject]@{ StageId = 'bare' }) `
            -Results @(@{ stageId = 'bare'; distinct = 2 })
        $e.Applied | Should -BeNullOrEmpty
    }
}

Describe 'Complete-SqlStagedLoads — nothing to apply, or a failure' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Update-CrawlerProgress { }
        Mock Write-Host { }
    }

    It 'asks nothing when the run staged nothing' {
        (Complete-SqlStagedLoads -State (New-StagingState)).Count | Should -Be 0
        $script:sent.Count | Should -Be 0
    }

    It 'abandons every stage and fails the run when the finalize fails' {
        Mock Invoke-IngestAPI { throw 'HTTP 500 finalize' }
        Mock Remove-CrawlerIngestStage { }
        $state = New-StagingState
        $state.Stages['7|a'] = [pscustomobject]@{ StageId = 's1' }
        $state.Stages['9|a'] = [pscustomobject]@{ StageId = 's2' }
        { Complete-SqlStagedLoads -State $state } | Should -Throw '*HTTP 500 finalize*'
        Should -Invoke Remove-CrawlerIngestStage -Exactly 2
    }
}

Describe 'Write-SqlStagedSummary' {
    It 'totals every stage''s answer and names the paths taken' {
        Mock Write-Host { $script:line = [string]$Object }
        $sum = Write-SqlStagedSummary -Seconds 12 -Results @(
            @{ path = 'merge'; inserted = 5; updated = 2; deleted = 1; rows = 8 },
            @{ path = 'empty-table'; inserted = 10; rows = 10 })
        $sum.inserted | Should -Be 15
        $sum.updated | Should -Be 2
        $sum.deleted | Should -Be 1
        $sum.rows | Should -Be 18
        $script:line | Should -Match 'empty-table, merge'
    }
}
