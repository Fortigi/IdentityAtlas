#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Staging.ps1 — the staged
    full load of assignment scopes.

.DESCRIPTION
    The ingest API is mocked and every call captured. The assertions are about
    what the crawler DECIDED: which scopes load through a stage (assignments
    only, in any run mode), that statements sharing a scope share its stage (two
    stages finalized with deleteMissing would delete each other's rows), that a
    scope read in full is applied with deleteMissing and counted whole while a
    window is applied without it and held to what the finalize found present,
    and what each finalize is asked to do.
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
        if ($Endpoint -eq 'ingest/stages/finalize') {
            # As the API answers: `present` only when nothing was asked to be removed.
            return @{ results = @($Body.stageIds | ForEach-Object {
                $r = @{ stageId = $_; path = 'merge'; inserted = 2; updated = 1; deleted = 3; rows = 4; distinct = 4 }
                if (-not $Body.deleteMissing) { $r.deleted = 0; $r.present = 4 }
                $r }) }
        }
        if ($Endpoint -eq 'ingest/count') { return @{ count = 9 } }
        @{ inserted = @($Body.records).Count; updated = 0; rows = 1 }
    }
    function New-GrantSlot {
        param([string]$Name, [string]$Type = 'Direct')
        @{ name = $Name; target = 'assignments'; sql = "SELECT $Name"; enabled = $true; paged = $false
           resourceType = 'Entitlement'; assignmentType = $Type; governed = $false }
    }
    # A statement that reads a window once a watermark is stored for it.
    function New-WindowSlot {
        param([string]$Name, [string]$Type = 'Direct')
        $slot = New-GrantSlot -Name $Name -Type $Type
        $slot.sql = "SELECT $Name WHERE modified >= @Since"; $slot.watermarkColumn = 'modified'
        return $slot
    }
    function New-StagingState {
        param([string]$SyncMode = 'full', [bool]$Staged = $true, [hashtable[]]$Slots = @())
        New-SqlRunState -SystemId 7 -ServerTime '2026-09-25T09:00:00.000Z' -Slots $Slots -BatchSize 2 -SyncMode $SyncMode -StagedFullLoad $Staged
    }
}

Describe 'Test-SqlStagedSpec' {
    It 'stages only a reconciled assignment scope of a run that stages' {
        $on = @{ StageLoads = $true }; $off = @{ StageLoads = $false }
        Test-SqlStagedSpec -State $on -Endpoint 'ingest/resource-assignments' -Reconcile $true | Should -BeTrue
        Test-SqlStagedSpec -State $off -Endpoint 'ingest/resource-assignments' -Reconcile $true | Should -BeFalse
        Test-SqlStagedSpec -State $on -Endpoint 'ingest/resource-assignments' -Reconcile $false | Should -BeFalse
        Test-SqlStagedSpec -State $on -Endpoint 'ingest/resources' -Reconcile $true | Should -BeFalse
    }

    It 'follows the configuration, not the run mode: a delta run stages too' {
        (New-StagingState -SyncMode 'full').StageLoads | Should -BeTrue
        (New-StagingState -SyncMode 'delta').StageLoads | Should -BeTrue
        (New-StagingState -SyncMode 'full' -Staged $false).StageLoads | Should -BeFalse
        (New-StagingState -SyncMode 'delta' -Staged $false).StageLoads | Should -BeFalse
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

    It 'with staging switched off, a run streams and reconciles as before' {
        $state = New-StagingState -SyncMode 'delta' -Staged $false -Slots @(New-GrantSlot 'A')
        Invoke-SqlSlot -Slot (New-GrantSlot 'A') -Connection 'c' -State $state | Out-Null
        @($script:sent | Where-Object Endpoint -eq 'ingest/stages').Count | Should -Be 0
        @($script:sent | Where-Object Endpoint -eq 'ingest/resource-assignments').Count | Should -Be 2
        $state.Scopes.Count | Should -Be 1
        @($state.Expect.Values)[0].Whole | Should -BeNullOrEmpty
        Measure-SqlScopeRows -State $state -Expectation @($state.Expect.Values)[0] | Out-Null
        @($script:sent | Where-Object Endpoint -eq 'ingest/count')[0].Body.before | Should -Be '2026-09-25T09:00:00.000Z'
    }
}

Describe 'A delta run' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Update-CrawlerProgress { }
        Mock Write-Host { }
        Mock Measure-SqlSource { @{ rows = [long]3; pairs = [long]3; reason = $null } }
        Mock Invoke-SqlQueryStream { Invoke-SqlTestReplay -Rows @($script:rows[$Sql]) -OnRow $OnRow -OnBatch $OnBatch; [long]@($script:rows[$Sql]).Count }
        $w = { param($p, $r) [ordered]@{ principalId = $p; resourceId = $r; modified = 1700000000500 } }
        $script:rows = @{
            'SELECT A' = @([ordered]@{ principalId = 'p1'; resourceId = 'r1' }, [ordered]@{ principalId = 'p2'; resourceId = 'r1' }, [ordered]@{ principalId = 'p3'; resourceId = 'r2' })
            'SELECT W WHERE modified >= @Since' = @((& $w 'p1' 'r1'), (& $w 'p2' 'r1'), (& $w 'p3' 'r2'))
            'SELECT V WHERE modified >= @Since' = @((& $w 'p7' 'r1'))
        }
        # A stored watermark is what makes a watermarked statement read a window.
        $script:token = '1700000000000'
        Mock Get-CrawlerDeltaTokenRow { if ($script:token) { @{ token = $script:token } } }
    }

    It 'loads a statement read in full through a stage and removes what is gone, exactly as a full sync does' {
        # No watermark on the statement: a delta run reads it whole every time.
        $state = New-StagingState -SyncMode 'delta' -Slots @(New-GrantSlot 'A')
        Invoke-SqlSlot -Slot (New-GrantSlot 'A') -Connection 'c' -State $state | Out-Null
        @($script:sent | Where-Object Endpoint -eq 'ingest/resource-assignments').Count | Should -Be 0
        $state.Stages.Count | Should -Be 1
        $e = @($state.Expect.Values)[0]
        $e.Windowed | Should -BeFalse
        $e.Whole | Should -BeTrue
        # Nothing for the windowed call to do; the complete call applies it.
        @(Complete-SqlStagedLoads -State $state -Windowed).Count | Should -Be 0
        @($script:sent | Where-Object Endpoint -eq 'ingest/stages/finalize').Count | Should -Be 0
        @(Complete-SqlStagedLoads -State $state).Count | Should -Be 1
        @($script:sent | Where-Object Endpoint -eq 'ingest/stages/finalize')[0].Body.deleteMissing | Should -BeTrue
        $e.Applied | Should -Be 4
        $e.Present | Should -BeNullOrEmpty
    }

    It 'a watermarked statement with no stored mark reads everything, so it is a complete scope too' {
        $script:token = $null
        $slot = New-WindowSlot 'W'
        $state = New-StagingState -SyncMode 'delta' -Slots @($slot)
        (Invoke-SqlSlot -Slot $slot -Connection 'c' -State $state).complete | Should -BeTrue
        @($state.Expect.Values)[0].Windowed | Should -BeFalse
        Complete-SqlStagedLoads -State $state | Out-Null
        @($script:sent | Where-Object Endpoint -eq 'ingest/stages/finalize')[0].Body.deleteMissing | Should -BeTrue
    }

    It 'stages a window too, applies it WITHOUT removing anything, and holds it to what the finalize found present' {
        $slot = New-WindowSlot 'W'
        $state = New-StagingState -SyncMode 'delta' -Slots @($slot)
        (Invoke-SqlSlot -Slot $slot -Connection 'c' -State $state).complete | Should -BeFalse
        # Staged, not upserted: an unchanged row in the window must not be rewritten.
        @($script:sent | Where-Object Endpoint -eq 'ingest/resource-assignments').Count | Should -Be 0
        @($script:sent | Where-Object Endpoint -like 'ingest/stages/*/rows').Count | Should -Be 2
        # The watermark column is read and not sent (it is the cursor, not an attribute).
        $state.Deltas[0].Max | Should -Be 1700000000500
        # Never reconciled, by timestamp or by the finalize.
        $state.Scopes.Count | Should -Be 0
        $e = @($state.Expect.Values)[0]
        $e.Windowed | Should -BeTrue
        $e.Whole | Should -BeFalse
        # The complete call leaves a window alone; the windowed call applies it.
        @(Complete-SqlStagedLoads -State $state).Count | Should -Be 0
        @($script:sent | Where-Object Endpoint -eq 'ingest/stages/finalize').Count | Should -Be 0
        @(Complete-SqlStagedLoads -State $state -Windowed).Count | Should -Be 1
        $call = @($script:sent | Where-Object Endpoint -eq 'ingest/stages/finalize')
        $call.Count | Should -Be 1
        $call[0].Body.deleteMissing | Should -BeFalse
        $state.Stages.Count | Should -Be 0
        $e.Applied | Should -Be 4
        $e.Present | Should -Be 4
        # Verified from the finalize's own answer: the database is not counted.
        Measure-SqlScopeRows -State $state -Expectation $e | Should -Be 4
        @($script:sent | Where-Object Endpoint -eq 'ingest/count').Count | Should -Be 0
        (Get-SqlScopeVerdict -Expectation $e -Atlas 4).ok | Should -BeTrue
        $bad = Get-SqlScopeVerdict -Expectation $e -Atlas 3
        $bad.ok | Should -BeFalse
        $bad.reason | Should -Match 'the window held 4 distinct assignments and 3 of them are in the database'
    }

    It 'one window among the statements feeding a scope makes the whole scope a window: none of its stages may delete' {
        # A reads in full, V a window, both Direct: one stage, and a finalize with
        # deleteMissing would remove every row of the scope V did not return.
        $slots = @((New-GrantSlot 'A'), (New-WindowSlot 'V'))
        $state = New-StagingState -SyncMode 'delta' -Slots $slots
        foreach ($s in $slots) { Invoke-SqlSlot -Slot $s -Connection 'c' -State $state | Out-Null }
        $state.Stages.Count | Should -Be 1
        $e = @($state.Expect.Values)[0]
        $e.Windowed | Should -BeTrue
        $e.Whole | Should -BeFalse
        @(Complete-SqlStagedLoads -State $state).Count | Should -Be 0
        Complete-SqlStagedLoads -State $state -Windowed | Out-Null
        @($script:sent | Where-Object Endpoint -eq 'ingest/stages/finalize')[0].Body.deleteMissing | Should -BeFalse
    }

    It 'the order of the statements does not matter: a complete one after a window does not make the scope whole again' {
        $slots = @((New-WindowSlot 'V'), (New-GrantSlot 'A'))
        $state = New-StagingState -SyncMode 'delta' -Slots $slots
        foreach ($s in $slots) { Invoke-SqlSlot -Slot $s -Connection 'c' -State $state | Out-Null }
        @($state.Expect.Values)[0].Windowed | Should -BeTrue
        @($state.Expect.Values)[0].Whole | Should -BeFalse
    }

    It 'applies a window and a complete scope in separate calls, each stage exactly once' {
        $slots = @((New-WindowSlot 'W'), (New-GrantSlot 'A' -Type 'Indirect'))
        $state = New-StagingState -SyncMode 'delta' -Slots $slots
        foreach ($s in $slots) { Invoke-SqlSlot -Slot $s -Connection 'c' -State $state | Out-Null }
        Complete-SqlStagedLoads -State $state -Windowed | Out-Null
        Complete-SqlStagedLoads -State $state | Out-Null
        Complete-SqlStagedLoads -State $state | Out-Null
        $calls = @($script:sent | Where-Object Endpoint -eq 'ingest/stages/finalize')
        $calls.Count | Should -Be 2
        @($calls[0].Body.stageIds) | Should -Be @('stage-7-Direct')
        $calls[0].Body.deleteMissing | Should -BeFalse
        @($calls[1].Body.stageIds) | Should -Be @('stage-7-Indirect')
        $calls[1].Body.deleteMissing | Should -BeTrue
        $state.StagedSeconds | Should -BeGreaterOrEqual 0
    }
}

Describe 'Set-SqlStagedExpectations — a window' {
    It 'sums distinct and present over the scope''s stages' {
        $e = @{ Windowed = $true; Applied = $null; Present = $null; Unverifiable = $null }
        Set-SqlStagedExpectations -Stages @([pscustomobject]@{ StageId = 's1'; Expect = $e }, [pscustomobject]@{ StageId = 's2'; Expect = $e }) `
            -Results @(@{ stageId = 's1'; distinct = 5; present = 5 }, @{ stageId = 's2'; distinct = 3; present = 2 })
        $e.Applied | Should -Be 8
        $e.Present | Should -Be 7
        $e.Unverifiable | Should -BeNullOrEmpty
    }

    It 'reports a window as not verified, rather than failing it, when the API did not say what is present' {
        $e = @{ Windowed = $true; Applied = $null; Present = $null; Unverifiable = $null }
        Set-SqlStagedExpectations -Stages @([pscustomobject]@{ StageId = 's1'; Expect = $e }, [pscustomobject]@{ StageId = 's2'; Expect = $e }) `
            -Results @(@{ stageId = 's1'; distinct = 5; present = 5 }, @{ stageId = 's2'; distinct = 3 })
        $e.Applied | Should -BeNullOrEmpty
        $e.Present | Should -BeNullOrEmpty
        $e.Unverifiable | Should -Match 'did not report what the staged window held'
        $v = Get-SqlScopeVerdict -Expectation $e -Atlas 0
        $v.ok | Should -BeTrue
        $v.reason | Should -Match '^not verified'
    }

    It 'a complete scope without counts is left to the source count, with no "not verified" attached' {
        $e = @{ Windowed = $false; Applied = $null; Present = $null; Unverifiable = $null }
        Set-SqlStagedExpectations -Stages @([pscustomobject]@{ StageId = 's1'; Expect = $e }) -Results @(@{ stageId = 's1'; rows = 3 })
        $e.Applied | Should -BeNullOrEmpty
        $e.Unverifiable | Should -BeNullOrEmpty
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
