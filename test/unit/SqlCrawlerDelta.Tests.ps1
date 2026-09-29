#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the SQL crawler's delta half — SqlCrawler.Delta.ps1
    (the per-statement watermark) and SqlCrawler.Sweep.ps1 (the key sweep).

.DESCRIPTION
    Two boundaries are mocked and nothing else: the delta-token store
    (Get-CrawlerDeltaTokenRow / Set-CrawlerDeltaToken) and the Ingest API
    (Invoke-IngestAPI, which captures every body). The SQL boundary is
    Invoke-SqlQueryStream, replayed exactly as the phase tests replay it.

    What these pin is the three properties the design says make a delta
    trustworthy rather than merely fast:

      * the token key carries a HASH OF THE STATEMENT, so an edited query starts
        from zero instead of skipping the rows its new shape would have returned;
      * the mark moves to (largest value read − overlap) and NEVER backwards;
      * nothing is stored until the run has been verified.

    And the two the sweep rests on: it is due-based, and its finalize carries a
    share ceiling so a source read mid-aggregation cannot empty a scope.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerDelta.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $sqlDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql'
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $sqlDir 'SqlCrawler.Load.ps1')

    function New-TestRow { param([hashtable]$Cells) $o = [ordered]@{}; foreach ($k in $Cells.Keys) { $o[$k] = $Cells[$k] }; return $o }

    function New-DeltaSlot {
        param([string]$Name = 'Grants', [hashtable]$Extra = @{})
        $raw = @{ name = $Name; target = 'assignments'; resourceType = 'Entitlement'
                  sql = 'SELECT principalId, resourceId, modified FROM g WHERE modified >= @Since'
                  watermarkColumn = 'modified' }
        foreach ($k in $Extra.Keys) { $raw[$k] = $Extra[$k] }
        return Resolve-SqlQuerySlot -Slot $raw
    }

    # A run state whose grants slot read a WINDOW — the state a sweep is for. A
    # slot that read in full needs no sweep (the reconcile covers it), so every
    # sweep test has to say which it is.
    function New-WindowedState {
        param([hashtable[]]$Slots = @(), [double]$SweepMaxDeleteShare = 0.05, [int]$SweepIntervalHours = 24)
        $s = New-DeltaState -Slots $Slots -SweepMaxDeleteShare $SweepMaxDeleteShare -SweepIntervalHours $SweepIntervalHours
        $s.Deltas.Add((New-ArmedDelta -Since 1758700000000))
        return $s
    }

    function New-DeltaState {
        param([hashtable[]]$Slots = @(), [string]$SyncMode = 'delta', [int]$OverlapSeconds = 900,
              [int]$SweepIntervalHours = 24, [double]$SweepMaxDeleteShare = 0.05)
        New-SqlRunState -SystemId 7 -ServerTime '2026-09-25T09:00:00.000Z' -Slots $Slots -BatchSize 1000 `
            -SyncMode $SyncMode -OverlapSeconds $OverlapSeconds -SweepIntervalHours $SweepIntervalHours `
            -SweepMaxDeleteShare $SweepMaxDeleteShare
    }

    # A delta state with a resolved watermark column and no store round trip.
    function New-ArmedDelta {
        param([long]$Since = 0, [string]$Column = 'modified')
        @{ Slot = 'Grants'; Key = 'sql:Grants:abc'; Since = $Since; Column = $Column; ColumnKey = $Column
           Max = [long]::MinValue; Rows = [long]0; Windowed = ($Since -gt 0); Unusable = $null }
    }
}

# ─── The token key ───────────────────────────────────────────────────────────

Describe 'Get-SqlStatementHash' {
    It 'is stable for one statement and different for an edited one' {
        $a = Get-SqlStatementHash -Sql 'SELECT 1 FROM t WHERE modified >= @Since'
        Get-SqlStatementHash -Sql 'SELECT 1 FROM t WHERE modified >= @Since' | Should -Be $a
        # One character of difference — a WHERE clause an operator tightened.
        Get-SqlStatementHash -Sql 'SELECT 1 FROM t WHERE modified >  @Since' | Should -Not -Be $a
    }

    It 'is 16 lower-case hex characters, so it fits an endpoint key' {
        Get-SqlStatementHash -Sql 'SELECT 1' | Should -Match '^[0-9a-f]{16}$'
    }
}

Describe 'ConvertTo-SqlTokenSlug' {
    It 'folds a human slot name to something the endpoint validator accepts' {
        # The API validates ^[a-zA-Z0-9/_\-.:]+$; a space or an apostrophe is a 400.
        ConvertTo-SqlTokenSlug -Name 'Entitlement grants via a role' | Should -Be 'Entitlement-grants-via-a-role'
        ConvertTo-SqlTokenSlug -Name "  Ann's grants (prod)  " | Should -Be 'Ann-s-grants-prod'
    }

    It 'never produces an empty slug or one over 60 characters' {
        ConvertTo-SqlTokenSlug -Name '   ' | Should -Be 'query'
        ConvertTo-SqlTokenSlug -Name '###' | Should -Be 'query'
        (ConvertTo-SqlTokenSlug -Name ('x' * 200)).Length | Should -Be 60
    }
}

Describe 'Get-SqlWatermarkKey / Get-SqlSweepKey' {
    BeforeAll { $script:slot = New-DeltaSlot }

    It 'keys the watermark on the slot name AND the statement hash' {
        $key = Get-SqlWatermarkKey -Slot $script:slot
        $key | Should -Match '^sql:Grants:[0-9a-f]{16}$'
        # The whole point: editing the statement moves the key, so the edited
        # query reads from zero instead of skipping what its new shape returns.
        $edited = New-DeltaSlot -Extra @{ sql = 'SELECT principalId, resourceId, modified FROM g WHERE modified >= @Since AND active = 1' }
        Get-SqlWatermarkKey -Slot $edited | Should -Not -Be $key
    }

    It 'gives the sweep a key of its own, so neither resets the other' {
        Get-SqlSweepKey -Slot $script:slot | Should -Not -Be (Get-SqlWatermarkKey -Slot $script:slot)
        Get-SqlSweepKey -Slot $script:slot | Should -Match '^sql:sweep:Grants:[0-9a-f]{16}$'
    }

    It 'produces a key the API would accept — the validator, not a guess' {
        foreach ($k in @((Get-SqlWatermarkKey -Slot $script:slot), (Get-SqlSweepKey -Slot $script:slot))) {
            Test-CrawlerDeltaTokenEndpoint -Endpoint $k | Should -BeTrue
        }
        # Even for a name made entirely of characters the validator rejects.
        $awkward = New-DeltaSlot -Name 'Grants — "prod", 100% (all)'
        Test-CrawlerDeltaTokenEndpoint -Endpoint (Get-SqlWatermarkKey -Slot $awkward) | Should -BeTrue
    }
}

# ─── Reading the mark ────────────────────────────────────────────────────────

Describe 'Get-SqlWatermarkFromToken' {
    It 'reads a stored epoch-millisecond mark' {
        Get-SqlWatermarkFromToken -Token '1758700000000' | Should -Be 1758700000000
        Get-SqlWatermarkFromToken -Token '  1758700000000  ' | Should -Be 1758700000000
    }

    It 'treats anything that is not a positive whole number as no token at all' {
        # Reading everything is slow; reading from a mark that means nothing is wrong.
        foreach ($t in @('', 'abc', '2026-09-25T00:00:00Z', '-5', '0', '1.5e12')) {
            Get-SqlWatermarkFromToken -Token $t | Should -Be 0
        }
    }
}

Describe 'New-SqlDeltaState' {
    BeforeEach { Mock Get-CrawlerDeltaTokenRow { @{ token = '1758700000000'; lastSyncAt = '2026-09-24T09:00:00Z' } } }

    It 'is $null for a statement that reads in full — there is no mark to keep' {
        $slot = Resolve-SqlQuerySlot -Slot @{ name = 'Roles'; target = 'resources'; resourceType = 'BusinessRole'; sql = 'SELECT id FROM r' }
        New-SqlDeltaState -Slot $slot -State (New-DeltaState) | Should -BeNullOrEmpty
        Should -Invoke Get-CrawlerDeltaTokenRow -Exactly 0
    }

    It 'binds the stored mark on a delta run and calls that a window' {
        $d = New-SqlDeltaState -Slot (New-DeltaSlot) -State (New-DeltaState -SyncMode 'delta')
        $d.Since | Should -Be 1758700000000
        $d.Windowed | Should -BeTrue
    }

    It 'a FULL run ignores the stored mark and reads everything' {
        $d = New-SqlDeltaState -Slot (New-DeltaSlot) -State (New-DeltaState -SyncMode 'full')
        $d.Since | Should -Be 0
        # Not windowed, so its scope may still be reconciled — that is what
        # "Force full sync next run" has to mean.
        $d.Windowed | Should -BeFalse
        Should -Invoke Get-CrawlerDeltaTokenRow -Exactly 0
    }

    It 'a first run has no token, so it reads everything and is complete' {
        Mock Get-CrawlerDeltaTokenRow { $null }
        $d = New-SqlDeltaState -Slot (New-DeltaSlot) -State (New-DeltaState -SyncMode 'delta')
        $d.Since | Should -Be 0
        $d.Windowed | Should -BeFalse
    }
}

# ─── Following the mark while rows stream ────────────────────────────────────

Describe 'Resolve-SqlWatermarkColumn' {
    It 'matches the column by the same fold every other column uses' {
        $d = New-ArmedDelta; $d.ColumnKey = $null
        Resolve-SqlWatermarkColumn -Delta $d -Columns @('principalId', 'LAST_MODIFIED', 'resourceId')
        $d.ColumnKey | Should -BeNullOrEmpty          # LAST_MODIFIED is not `modified`
        $d.Unusable | Should -Match "does not return a 'modified' column"

        # Case and underscores are ignored, and the ACTUAL spelling is kept —
        # the row is indexed by the name the result set uses, not by the fold.
        $d2 = New-ArmedDelta; $d2.ColumnKey = $null
        Resolve-SqlWatermarkColumn -Delta $d2 -Columns @('principalId', 'MOD_IFIED')
        $d2.ColumnKey | Should -Be 'MOD_IFIED'
        $d2.Unusable | Should -BeNullOrEmpty
    }
}

Describe 'Update-SqlWatermark' {
    It 'keeps the largest value it saw, in any order, and counts every row' {
        $d = New-ArmedDelta
        foreach ($v in @(1758700000000, 1758900000000, 1758800000000)) {
            Update-SqlWatermark -Delta $d -Row (New-TestRow @{ modified = $v })
        }
        $d.Max | Should -Be 1758900000000
        $d.Rows | Should -Be 3
    }

    It 'skips a NULL without disqualifying the statement — modified is NULL until a row is updated' {
        $d = New-ArmedDelta
        Update-SqlWatermark -Delta $d -Row (New-TestRow @{ modified = $null })
        Update-SqlWatermark -Delta $d -Row (New-TestRow @{ modified = 1758700000000 })
        $d.Unusable | Should -BeNullOrEmpty
        $d.Max | Should -Be 1758700000000
        $d.Rows | Should -Be 2
    }

    It 'disqualifies a column that is not epoch milliseconds, naming the value it saw' {
        # A datetime column would compare fine in SQL and be meaningless as a mark.
        $d = New-ArmedDelta
        Update-SqlWatermark -Delta $d -Row (New-TestRow @{ modified = '2026-09-25T09:00:00' })
        $d.Unusable | Should -Match '2026-09-25T09:00:00'
        $d.Unusable | Should -Match 'not epoch milliseconds'
    }

    It 'stops looking once the column is disqualified' {
        $d = New-ArmedDelta
        $d.Unusable = 'already broken'
        Update-SqlWatermark -Delta $d -Row (New-TestRow @{ modified = 1758700000000 })
        $d.Max | Should -Be ([long]::MinValue)
        $d.Rows | Should -Be 1
    }
}

# ─── Where the mark lands ────────────────────────────────────────────────────

Describe 'Get-SqlNextWatermark' {
    It 'steps back by the overlap, because clocks drift and transactions commit late' {
        $d = New-ArmedDelta -Since 1000000
        $d.Max = 1758900000000
        Get-SqlNextWatermark -Delta $d -OverlapMs 900000 | Should -Be (1758900000000 - 900000)
    }

    It 'never moves the mark BACKWARDS, however large the overlap' {
        # A run whose newest row is barely past the previous mark would otherwise
        # rewind it, and each run would read a wider window than the last.
        $d = New-ArmedDelta -Since 1758899000000
        $d.Max = 1758899500000
        Get-SqlNextWatermark -Delta $d -OverlapMs 900000 | Should -Be 1758899000000
    }

    It 'leaves the mark alone when the statement returned nothing' {
        Get-SqlNextWatermark -Delta (New-ArmedDelta -Since 5) -OverlapMs 0 | Should -BeNullOrEmpty
    }

    It 'leaves the mark alone when the column was disqualified' {
        $d = New-ArmedDelta
        $d.Max = 1758900000000
        $d.Unusable = 'not epoch milliseconds'
        Get-SqlNextWatermark -Delta $d -OverlapMs 0 | Should -BeNullOrEmpty
    }

    It 'refuses a mark the overlap would drive to zero or below' {
        $d = New-ArmedDelta
        $d.Max = 1000
        Get-SqlNextWatermark -Delta $d -OverlapMs 900000 | Should -BeNullOrEmpty
    }
}

Describe 'Save-SqlWatermarks' {
    BeforeEach {
        $script:written = [System.Collections.Generic.List[object]]::new()
        Mock Set-CrawlerDeltaToken { $script:written.Add(@{ Endpoint = $Endpoint; Token = $Token; SystemId = $SystemId; Seen = $RecordsLastSeen }) }
    }

    It 'stores the stepped-back mark under the statement key, with the rows it read' {
        $state = New-DeltaState -OverlapSeconds 900
        $d = New-ArmedDelta
        $d.Max = 1758900000000; $d.Rows = 4321
        $state.Deltas.Add($d)
        Save-SqlWatermarks -State $state | Should -Be 1
        $script:written[0].Endpoint | Should -Be 'sql:Grants:abc'
        $script:written[0].Token | Should -Be '1758899100000'
        $script:written[0].SystemId | Should -Be 7
        $script:written[0].Seen | Should -Be 4321
    }

    It 'stores NOTHING for a statement whose watermark column it could not use' {
        $state = New-DeltaState
        $d = New-ArmedDelta
        $d.Max = 1758900000000; $d.Unusable = 'the statement does not return a modified column'
        $state.Deltas.Add($d)
        Save-SqlWatermarks -State $state | Should -Be 0
        Should -Invoke Set-CrawlerDeltaToken -Exactly 0
    }

    It 'stores nothing when a run read no rows, leaving the previous mark in place' {
        $state = New-DeltaState
        $state.Deltas.Add((New-ArmedDelta -Since 1758700000000))
        Save-SqlWatermarks -State $state | Should -Be 0
        Should -Invoke Set-CrawlerDeltaToken -Exactly 0
    }
}

# Start-SqlCrawler.ps1 runs Test-SqlRunCounts BEFORE Save-SqlWatermarks and
# Save-SqlSweepMarks, so a statement the verification rejects costs the whole run
# its marks — not just its own. That is what turned a source drifting by 0.046%
# into a delta import that could never establish a baseline: every run failed
# identically and no watermark was ever written for any statement.
Describe 'verify-then-save: which runs are allowed to remember where they got to' {
    BeforeAll {
        # The ordering itself lives in the entry point, which runs live I/O the
        # moment it is dot-sourced. Assert it as text, then exercise it below.
        $script:entryPoint = Get-Content (Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql' 'Start-SqlCrawler.ps1') -Raw

        # The entry point's closing sequence, in its order. Helpers must be
        # declared inside BeforeAll or the It blocks cannot see them.
        function Invoke-VerifyThenSave {
            param([hashtable]$State)
            try { Test-SqlRunCounts -State $State | Out-Null }
            catch { return @{ Verified = $false; Error = $_.Exception.Message } }
            Save-SqlWatermarks -State $State | Out-Null
            Save-SqlSweepMarks -State $State | Out-Null
            return @{ Verified = $true; Error = $null }
        }

        # A run whose one watermarked statement read $Read rows out of a source
        # that held $Before when the read started and $After when it ended.
        function New-RunAt([long]$Read, [long]$Before, [long]$After) {
            $state = New-DeltaState
            $d = New-ArmedDelta -Since 1758700000000
            $d.Max = 1758900000000; $d.Rows = $Read
            $state.Deltas.Add($d)
            $state.Reads.Add(@{ Slot = 'Grants'; Read = $Read; Before = $Before; Source = $After; Reason = $null
                                Unplaced = [long]0; Misrouted = [long]0 })
            return $state
        }
    }

    BeforeEach {
        $script:written = [System.Collections.Generic.List[object]]::new()
        Mock Set-CrawlerDeltaToken { $script:written.Add(@{ Endpoint = $Endpoint; Token = $Token }) }
        Mock Update-CrawlerProgress { }
        Mock Invoke-IngestAPI { @{ count = 0 } }
    }

    It 'a source that drifted while it was read verifies, so the marks advance' {
        $r = Invoke-VerifyThenSave -State (New-RunAt 33857035 33857035 33841580)
        $r.Verified | Should -BeTrue
        @($script:written).Count | Should -Be 1
        $script:written[0].Token | Should -Be '1758899100000'
    }

    It 'a truncated read fails, and NOTHING is remembered — not the watermark, not the sweep' {
        $state = New-RunAt 22087 176703 176703
        $state.Sweeps.Add(@{ Slot = 'Grants'; Key = 'sql:sweep:Grants:abc'; Staged = [long]5; Distinct = $false })
        $r = Invoke-VerifyThenSave -State $state
        $r.Verified | Should -BeFalse
        $r.Error | Should -Match 'Verification failed'
        Should -Invoke Set-CrawlerDeltaToken -Exactly 0
    }

    It 'the entry point still verifies before it saves' {
        # If this ever reorders, a failed run starts stepping over rows it never
        # read, and the failure is permanent and invisible.
        $verify = $script:entryPoint.IndexOf('Test-SqlRunCounts')
        $verify | Should -BeGreaterThan 0
        $script:entryPoint.IndexOf('Save-SqlWatermarks') | Should -BeGreaterThan $verify
        $script:entryPoint.IndexOf('Save-SqlSweepMarks') | Should -BeGreaterThan $verify
    }
}

# ─── The slot binds it ───────────────────────────────────────────────────────

Describe 'Invoke-SqlSlot with a watermark' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        $script:boundSince = 'unset'
        Mock Invoke-IngestAPI { $script:sent.Add(@{ Endpoint = $Endpoint; Body = $Body }); @{ inserted = 1; updated = 0 } }
        Mock Update-CrawlerProgress { }
        Mock Add-SqlReadCheck { }
        Mock Get-SqlSourceRowsBefore { }
        Mock Invoke-SqlQueryStream {
            $script:boundSince = $Since
            foreach ($r in $script:rowsToReplay) { & $OnRow $r }
            [long]@($script:rowsToReplay).Count
        }
        Mock Get-CrawlerDeltaTokenRow { @{ token = '1758700000000'; lastSyncAt = '2026-09-24T09:00:00Z' } }
        $script:rowsToReplay = @(
            (New-TestRow @{ principalId = 'u1'; resourceId = 'e1'; modified = 1758800000000 })
            (New-TestRow @{ principalId = 'u2'; resourceId = 'e1'; modified = 1758900000000 })
        )
    }

    It 'binds the stored mark, follows the column while streaming, and marks the scope windowed' {
        $slot  = New-DeltaSlot
        $state = New-DeltaState -Slots @($slot) -SyncMode 'delta'
        $total = Invoke-SqlSlot -Slot $slot -Connection 'conn' -State $state
        $script:boundSince | Should -Be 1758700000000
        $total.complete | Should -BeFalse
        @($state.Deltas)[0].Max | Should -Be 1758900000000
        @($state.Deltas)[0].Rows | Should -Be 2
        # A windowed slot's scope is never reconciled: an untouched row there has
        # simply not changed.
        @($state.Scopes)[0].Complete | Should -BeFalse
    }

    It 'binds nothing at all for a statement that reads in full, and its scope stays reconcilable' {
        $slot = Resolve-SqlQuerySlot -Slot @{ name = 'Roles'; target = 'resources'; resourceType = 'BusinessRole'; sql = 'SELECT id, displayName FROM r' }
        $script:rowsToReplay = @((New-TestRow @{ id = 'r1'; displayName = 'Role 1' }))
        $state = New-DeltaState -Slots @($slot) -SyncMode 'delta'
        (Invoke-SqlSlot -Slot $slot -Connection 'conn' -State $state).complete | Should -BeTrue
        $script:boundSince | Should -BeNullOrEmpty
        @($state.Scopes)[0].Complete | Should -BeTrue
    }

    It 'a windowed resources statement takes the sweep off the table for the whole run' {
        $slot = Resolve-SqlQuerySlot -Slot @{ name = 'Ents'; target = 'resources'; resourceType = 'Entitlement'
                                              sql = 'SELECT id, displayName, modified FROM r WHERE modified >= @Since'; watermarkColumn = 'modified' }
        $script:rowsToReplay = @((New-TestRow @{ id = 'r1'; displayName = 'Role 1'; modified = 1758800000000 }))
        $state = New-DeltaState -Slots @($slot) -SyncMode 'delta'
        Invoke-SqlSlot -Slot $slot -Connection 'conn' -State $state | Out-Null
        $state.ResourcesComplete | Should -BeFalse
    }
}

# ─── The sweep ───────────────────────────────────────────────────────────────

Describe 'Get-SqlSweepSql' {
    It 'asks the source for the DISTINCT pair of ids and nothing else' {
        $slot = New-DeltaSlot
        $sql = Get-SqlSweepSql -Slot $slot -Map @{ resourceId = 'resourceId'; principalId = 'principalId' }
        $sql | Should -Match '^SELECT DISTINCT q\.\[resourceId\], q\.\[principalId\] FROM \('
        $sql | Should -Match ([regex]::Escape($slot.sql))
    }

    It 'accepts the identityId spelling an identities-shaped statement uses' {
        (Get-SqlSweepSql -Slot (New-DeltaSlot) -Map @{ resourceId = 'EntitlementID'; identityId = 'IdentityID' }) |
            Should -Match '\[EntitlementID\], q\.\[IdentityID\]'
    }

    It 'escapes a closing bracket in a column name rather than ending the quoting early' {
        (Get-SqlSweepSql -Slot (New-DeltaSlot) -Map @{ resourceId = 'we]ird'; principalId = 'p' }) | Should -Match '\[we\]\]ird\]'
    }

    It 'falls back to the statement itself when the columns could not be described' {
        $slot = New-DeltaSlot
        Get-SqlSweepSql -Slot $slot -Map $null | Should -Be $slot.sql
        Get-SqlSweepSql -Slot $slot -Map @{ resourceId = 'r' } | Should -Be $slot.sql
    }
}

Describe 'Test-SqlSweepDue' {
    BeforeEach { $script:now = [datetime]::Parse('2026-09-25T09:00:00Z').ToUniversalTime() }

    It 'is due when nothing has ever swept this statement' {
        Mock Get-CrawlerDeltaTokenRow { $null }
        (Test-SqlSweepDue -State (New-DeltaState) -Slot (New-DeltaSlot) -Now $script:now).due | Should -BeTrue
    }

    It 'is due once the interval has passed, and not before' {
        Mock Get-CrawlerDeltaTokenRow { @{ token = 'x'; lastSyncAt = '2026-09-24T20:00:00Z' } }   # 13h ago
        (Test-SqlSweepDue -State (New-DeltaState -SweepIntervalHours 24) -Slot (New-DeltaSlot) -Now $script:now).due | Should -BeFalse
        (Test-SqlSweepDue -State (New-DeltaState -SweepIntervalHours 12) -Slot (New-DeltaSlot) -Now $script:now).due | Should -BeTrue
    }

    It 'reads a stored time without a zone as UTC, not as a local clock' {
        # The API stores UTC; a worker in CEST would otherwise read 20:00 as
        # 18:00 UTC and think the sweep two hours fresher than it is.
        Mock Get-CrawlerDeltaTokenRow { @{ token = 'x'; lastSyncAt = '2026-09-24T20:00:00' } }
        $r = Test-SqlSweepDue -State (New-DeltaState -SweepIntervalHours 24) -Slot (New-DeltaSlot) -Now $script:now
        $r.due | Should -BeFalse
        $r.reason | Should -Match '^swept 13h ago'
    }

    It 'sweeps rather than trusting a timestamp it cannot read' {
        Mock Get-CrawlerDeltaTokenRow { @{ token = 'x'; lastSyncAt = 'not a date' } }
        (Test-SqlSweepDue -State (New-DeltaState) -Slot (New-DeltaSlot) -Now $script:now).due | Should -BeTrue
    }
}

Describe 'Get-SqlSweepEligibility' {
    It 'refuses when the operator turned sweeping off entirely' {
        (Get-SqlSweepEligibility -State (New-DeltaState -SweepIntervalHours 0) -Slot (New-DeltaSlot -Extra @{ sweep = $true })).ok | Should -BeFalse
    }

    # A full read already removed what is gone, through the ordinary reconcile,
    # and touched every surviving row on the way. Sweeping as well reads the whole
    # table a second time for nothing: on the rehearsal fixture that is 4 million
    # grants loaded and then 4 million keys swept.
    It 'skips the sweep when this run read the statement in full, and counts that as swept' {
        $state = New-DeltaState -SyncMode 'full'
        $slot  = New-DeltaSlot -Extra @{ sweep = $true }
        $v = Get-SqlSweepEligibility -State $state -Slot $slot
        $v.ok | Should -BeFalse
        $v.covered | Should -BeTrue
        Mock Invoke-SqlQueryStream { }
        Mock Update-CrawlerProgress { }
        Invoke-SqlSweep -State $state -Connection 'conn' -Slots @($slot) | Should -Be 1
        Should -Invoke Invoke-SqlQueryStream -Exactly 0
        @($state.Sweeps)[0].Covered | Should -BeTrue
        @($state.Sweeps)[0].Key | Should -Be (Get-SqlSweepKey -Slot $slot)
        # Nothing to compare a total against: the sweep never read a key set.
        @($state.Sweeps)[0].Distinct | Should -BeFalse
    }

    It 'still sweeps when the statement read a window' {
        $state = New-DeltaState
        $slot  = New-DeltaSlot -Extra @{ sweep = $true }
        $state.Deltas.Add((New-ArmedDelta -Since 1758700000000))   # this run read a WINDOW
        (Get-SqlSweepEligibility -State $state -Slot $slot).ok | Should -BeTrue
    }

    It 'refuses a paged statement — its key set cannot be read as one distinct set' {
        $slot = New-DeltaSlot -Extra @{ sweep = $true
            sql = 'SELECT principalId, resourceId, modified FROM g WHERE modified >= @Since ORDER BY id OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY' }
        $state = New-DeltaState
        $state.Deltas.Add((New-ArmedDelta -Since 1758700000000))   # this run read a WINDOW
        $v = Get-SqlSweepEligibility -State $state -Slot $slot
        $v.ok | Should -BeFalse
        $v.reason | Should -Match 'pages with @Offset'
    }

    # The sweep places each pair in its RESOURCE's system. Without every resource
    # id this run produced it would place them in the crawler's own system, and
    # the finalize would then remove the routed systems' whole scope.
    It 'refuses when the run routes into several systems but read its resources as a window' {
        $state = New-DeltaState
        $state.Systems.ByKey['APP-1'] = 11
        $state.ResourcesComplete = $false
        $state.Deltas.Add((New-ArmedDelta -Since 1758700000000))   # this run read a WINDOW
        $v = Get-SqlSweepEligibility -State $state -Slot (New-DeltaSlot -Extra @{ sweep = $true })
        $v.ok | Should -BeFalse
        $v.reason | Should -Match 'could not be placed in the right one'
    }

    It 'allows the same run once the resources were read in full' {
        $state = New-DeltaState
        $state.Systems.ByKey['APP-1'] = 11
        $state.Deltas.Add((New-ArmedDelta -Since 1758700000000))   # this run read a WINDOW
        (Get-SqlSweepEligibility -State $state -Slot (New-DeltaSlot -Extra @{ sweep = $true })).ok | Should -BeTrue
    }
}

Describe 'Invoke-SqlSweep' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        $script:sweepSql = $null
        $script:sweepSince = 'unset'
        Mock Update-CrawlerProgress { }
        Mock Get-CrawlerDeltaTokenRow { $null }                      # never swept, never watermarked
        Mock Get-SqlSweepResultColumns { @('resourceId', 'principalId', 'modified') }
        Mock Invoke-SqlQueryStream {
            $script:sweepSql = $Sql
            $script:sweepSince = $Since
            foreach ($r in $script:rowsToReplay) { & $OnRow $r }
            [long]@($script:rowsToReplay).Count
        }
        Mock Invoke-IngestAPI {
            $script:sent.Add(@{ Endpoint = $Endpoint; Body = $Body })
            if ($Endpoint -eq 'ingest/stages') { return @{ stageId = "stage-$(@($script:sent).Count)" } }
            if ($Endpoint -eq 'ingest/stages/finalize') { return @{ results = @(@{ path = 'merge'; inserted = 0; updated = 0; deleted = 3 }) } }
            return @{ rows = 1 }
        }
        $script:rowsToReplay = @(
            (New-TestRow @{ resourceId = 'e1'; principalId = 'u1' })
            (New-TestRow @{ resourceId = 'e1'; principalId = 'u2' })
        )
    }

    It 'stages the key set and finalizes it with the ceiling and the delete on' {
        $slot  = New-DeltaSlot -Extra @{ sweep = $true }
        $state = New-WindowedState -Slots @($slot) -SweepMaxDeleteShare 0.05
        Invoke-SqlSweep -State $state -Connection 'conn' -Slots @($slot) | Should -Be 1

        # The complete set, whatever window the delta half read.
        $script:sweepSince | Should -Be 0
        $script:sweepSql | Should -Match '^SELECT DISTINCT'

        $open = @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/stages' })
        @($open).Count | Should -Be 1
        $open[0].Body.entity | Should -Be 'resource-assignments'
        $open[0].Body.systemId | Should -Be 7
        $open[0].Body.idPrefix | Should -Be 'sql-7-resource-assignments'
        # The scope is the slot's reconcile partition, so the sweep can never
        # reach a neighbouring statement's rows.
        $open[0].Body.scope.assignmentType | Should -Be 'Direct'
        $open[0].Body.scope.resourceType | Should -Be 'Entitlement'
        $open[0].Body.scope.governed | Should -BeFalse

        $final = @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/stages/finalize' })
        @($final).Count | Should -Be 1
        $final[0].Body.deleteMissing | Should -BeTrue
        $final[0].Body.maxDeleteShare | Should -Be 0.05
        @($state.Sweeps)[0].Deleted | Should -Be 3
        @($state.Sweeps)[0].Staged | Should -Be 2
    }

    It 'sends the KEY columns only — a stage carrying anything else would insert, not just remove' {
        $slot = New-DeltaSlot -Extra @{ sweep = $true }
        Invoke-SqlSweep -State (New-WindowedState -Slots @($slot)) -Connection 'conn' -Slots @($slot) | Out-Null
        $rows = @($script:sent | Where-Object { $_.Endpoint -match '/rows$' })
        @($rows).Count | Should -Be 1
        $rec = @($rows[0].Body.records)[0]
        @($rec.Keys | Sort-Object) | Should -Be @('assignmentType', 'governed', 'principalExternalId', 'resourceExternalId')
    }

    It 'an explicit override sends no ceiling at all' {
        $slot = New-DeltaSlot -Extra @{ sweep = $true }
        Invoke-SqlSweep -State (New-WindowedState -Slots @($slot) -SweepMaxDeleteShare 1) -Connection 'conn' -Slots @($slot) | Out-Null
        $final = @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/stages/finalize' })[0]
        $final.Body.maxDeleteShare | Should -Be 1
    }

    It 'abandons its stages when the finalize is refused, so nothing is left half-applied' {
        Mock Invoke-IngestAPI {
            $script:sent.Add(@{ Endpoint = $Endpoint; Body = $Body })
            if ($Endpoint -eq 'ingest/stages') { return @{ stageId = 'stage-1' } }
            if ($Endpoint -eq 'ingest/stages/finalize') { throw 'HTTP 409: would remove 60 of 100 rows' }
            return @{ rows = 1 }
        }
        Mock Remove-CrawlerIngestStage { }
        $slot = New-DeltaSlot -Extra @{ sweep = $true }
        { Invoke-SqlSweep -State (New-WindowedState -Slots @($slot)) -Connection 'conn' -Slots @($slot) } |
            Should -Throw -ExpectedMessage '*would remove 60 of 100 rows*'
        Should -Invoke Remove-CrawlerIngestStage -Exactly 1
    }

    # "The statement returned nothing" is far more often a broken read than a
    # source that genuinely holds no grants, and an empty stage finalized with
    # deleteMissing empties the scope.
    It 'removes NOTHING when the source returned no keys at all' {
        $script:rowsToReplay = @()
        $slot = New-DeltaSlot -Extra @{ sweep = $true }
        $state = New-WindowedState -Slots @($slot)
        Invoke-SqlSweep -State $state -Connection 'conn' -Slots @($slot) | Should -Be 1
        @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/stages' }).Count | Should -Be 0
        @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/stages/finalize' }).Count | Should -Be 0
        @($state.Sweeps)[0].Deleted | Should -Be 0
    }

    It 'does nothing when the sweep is not yet due' {
        Mock Get-CrawlerDeltaTokenRow { @{ token = 'x'; lastSyncAt = ([DateTime]::UtcNow.AddHours(-1).ToString('o')) } }
        $slot = New-DeltaSlot -Extra @{ sweep = $true }
        Invoke-SqlSweep -State (New-WindowedState -Slots @($slot) -SweepIntervalHours 24) -Connection 'conn' -Slots @($slot) | Should -Be 0
        Should -Invoke Invoke-SqlQueryStream -Exactly 0
    }

    It 'leaves a statement with no sweep configured alone' {
        $slot = New-DeltaSlot
        Invoke-SqlSweep -State (New-WindowedState -Slots @($slot)) -Connection 'conn' -Slots @($slot) | Should -Be 0
        Should -Invoke Invoke-SqlQueryStream -Exactly 0
    }
}

Describe 'Save-SqlSweepMarks' {
    It 'records the sweep under its own key, so the interval is measured from a PROVEN sweep' {
        $script:written = [System.Collections.Generic.List[object]]::new()
        Mock Set-CrawlerDeltaToken { $script:written.Add(@{ Endpoint = $Endpoint; Token = $Token }) }
        $state = New-DeltaState
        $state.Sweeps.Add(@{ Slot = 'Grants'; Key = 'sql:sweep:Grants:abc'; Staged = 12 })
        Save-SqlSweepMarks -State $state | Should -Be 1
        $script:written[0].Endpoint | Should -Be 'sql:sweep:Grants:abc'
        [datetime]::Parse($script:written[0].Token) | Should -BeOfType [datetime]
    }

    It 'records nothing when no sweep ran' {
        Mock Set-CrawlerDeltaToken { }
        Save-SqlSweepMarks -State (New-DeltaState) | Should -Be 0
        Should -Invoke Set-CrawlerDeltaToken -Exactly 0
    }
}
