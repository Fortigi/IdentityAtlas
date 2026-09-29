#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Verify.ps1 — the
    end-of-run comparison of what the source returned with what the database
    holds.

.DESCRIPTION
    Two ways a run can load an eighth of its source and still look perfect, and
    both must fail:

      * The read stops early. This is the one that shipped: the worker's
        transcript made the crawler skip 7 rows in 8, so 22,087 of 176,703
        identities arrived, all distinct, and every one landed. The database
        agrees with what was sent; only the source's own row count disagrees.
      * The id column repeats, eight rows per id. Every row is sent, but rows
        sharing an id overwrite each other, so the database again holds exactly
        the distinct ids and only the crawler's key tally can tell.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerVerify.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:ApiBaseUrl = 'http://localhost:3001/api'; $script:ApiKey = 'fgc_test'; $script:JobId = 0
    . (Join-Path $root 'tools' 'crawlers' 'mssql' 'SqlCrawler.Load.ps1')
    function New-State { New-SqlRunState -SystemId 5 -ServerTime '2026-09-26T08:00:00.000Z' -Slots @() -BatchSize 1000 }
    function New-Keyed([long]$Rows, [int]$Distinct) {
        $e = Get-SqlExpectation -State (New-State) -Key 'k' -Endpoint 'ingest/principals' -Scope @{ principalType = 'User' }
        for ($i = 0; $i -lt $Distinct; $i++) { [void]$e.KeySet.Add("p$i") }
        $e.Rows = $Rows
        return $e
    }
    function New-Pairs([long]$SourceDistinct, [long]$Dangling = 0, [int]$Slots = 1, [long]$Drift = 0) {
        $e = Get-SqlExpectation -State (New-State) -Key 'a' -Endpoint 'ingest/resource-assignments' -Scope @{ assignmentType = 'Direct' }
        $e.SourceDistinct = $SourceDistinct; $e.Dangling = $Dangling; $e.Slots = $Slots; $e.Drift = $Drift
        return $e
    }
    # A connection whose command answers one row of $Values from ExecuteReader (or
    # throws $Values when it is an exception), recording the SQL it was given and
    # whether the reader and command were disposed.
    function New-FakeConnection($Values) {
        $script:lastSql = $null; $script:disposed = [System.Collections.Generic.List[string]]::new()
        $script:lastParams = [System.Collections.Generic.List[object]]::new()
        $conn = [pscustomobject]@{}
        $conn | Add-Member -MemberType ScriptMethod -Name CreateCommand -Value {
            # A parameter bag, so a test can assert what the count was BOUND to —
            # a count that does not bind the read's own @Since asks about the
            # whole table and fails every delta run.
            $bag = [pscustomobject]@{}
            $bag | Add-Member -MemberType ScriptMethod -Name Add -Value {
                param($Name, $Type)
                $p = [pscustomobject]@{ ParameterName = $Name; SqlDbType = $Type; Value = $null }
                $script:lastParams.Add($p)
                return $p
            }
            $cmd = [pscustomobject]@{ CommandText = ''; CommandTimeout = 0; Parameters = $bag }
            $cmd | Add-Member -MemberType ScriptMethod -Name ExecuteReader -Value {
                $script:lastSql = $this.CommandText
                $script:lastTimeout = $this.CommandTimeout
                if ($script:answer -is [System.Exception]) { throw $script:answer }
                $r = [pscustomobject]@{ Row = $script:answer }
                $r | Add-Member -MemberType ScriptMethod -Name Read -Value { $true }
                $r | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($i) $this.Row[$i] }
                $r | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:disposed.Add('reader') }
                $r
            }
            $cmd | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:disposed.Add('command') }
            $cmd
        }
        $script:answer = $Values
        return $conn
    }
}

Describe 'Get-SqlScopeVerdict — keyed scopes' {
    It 'fails the eight-rows-per-id load even though the database holds exactly what was sent' {
        $v = Get-SqlScopeVerdict -Expectation (New-Keyed -Rows 176696 -Distinct 22087) -Atlas 22087
        $v.ok | Should -BeFalse
        $v.expected | Should -Be 22087
        $v.reason | Should -Match '176[.,]696 rows for only 22[.,]087 distinct ids'
        $v.reason | Should -Match '154[.,]609 were lost'
    }

    It 'passes when every row has its own id and all of them landed' {
        (Get-SqlScopeVerdict -Expectation (New-Keyed -Rows 5 -Distinct 5) -Atlas 5).ok | Should -BeTrue
    }

    It 'fails when the database holds fewer or more rows than distinct ids sent' {
        (Get-SqlScopeVerdict -Expectation (New-Keyed -Rows 5 -Distinct 5) -Atlas 4).ok | Should -BeFalse
        (Get-SqlScopeVerdict -Expectation (New-Keyed -Rows 5 -Distinct 5) -Atlas 6).ok | Should -BeFalse
    }

    It 'stays exact however much the source moved: both sides of this one are the crawler own' {
        # Keys SENT against rows the database holds. A source aggregated mid-read
        # cannot explain a difference here, so drift must buy nothing.
        $e = New-Keyed -Rows 1000 -Distinct 1000
        $e.Drift = [long]500
        (Get-SqlScopeVerdict -Expectation $e -Atlas 999).ok | Should -BeFalse
        (Get-SqlScopeVerdict -Expectation $e -Atlas 1000).ok | Should -BeTrue
    }
}

Describe 'Get-SqlScopeVerdict — assignment scopes' {
    It 'is exact with one statement and nothing held back' {
        (Get-SqlScopeVerdict -Expectation (New-Pairs 400000) -Atlas 400000).ok | Should -BeTrue
        $v = Get-SqlScopeVerdict -Expectation (New-Pairs 400000) -Atlas 399999
        $v.ok | Should -BeFalse
        $v.reason | Should -Match 'distinct assignments'
    }

    It 'with dangling rows, accepts only the range they allow' {
        # 100 distinct pairs, 10 rows held back: between 90 and 100 can have landed.
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 10) -Atlas 90).ok | Should -BeTrue
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 10) -Atlas 95).reason | Should -Match 'within range'
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 10) -Atlas 89).ok | Should -BeFalse
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 10) -Atlas 101).ok | Should -BeFalse
    }

    It 'treats two statements feeding one scope as a range too' {
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 0 2) -Atlas 100).ok | Should -BeTrue
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 0 2) -Atlas 101).ok | Should -BeFalse
    }

    It 'allows the database to differ by exactly what the source moved, and not by more' {
        # The database-side half of the same field failure:
        # "expected 5,325,064, database 5,315,294". The pair count is measured
        # once, after the read; a pair cannot have moved by more than the rows did.
        (Get-SqlScopeVerdict -Expectation (New-Pairs 5325064 0 1 9770) -Atlas 5315294).ok | Should -BeTrue
        (Get-SqlScopeVerdict -Expectation (New-Pairs 400000 0 1 10) -Atlas 399990).ok | Should -BeTrue
        (Get-SqlScopeVerdict -Expectation (New-Pairs 400000 0 1 10) -Atlas 400010).ok | Should -BeTrue
        $v = Get-SqlScopeVerdict -Expectation (New-Pairs 400000 0 1 10) -Atlas 399989
        $v.ok | Should -BeFalse
        $v.reason | Should -Match 'the source moved by 10 rows while it was read'
        (Get-SqlScopeVerdict -Expectation (New-Pairs 400000 0 1 10) -Atlas 400011).ok | Should -BeFalse
    }

    It 'gives a scope whose source did not move no slack, so a single lost assignment still fails' {
        (Get-SqlScopeVerdict -Expectation (New-Pairs 400000 0 1 0) -Atlas 399999).ok | Should -BeFalse
        (Get-SqlScopeVerdict -Expectation (New-Pairs 400000 0 1 0) -Atlas 400000).reason | Should -BeNullOrEmpty
    }

    It 'widens the dangling range by the drift too, at both ends' {
        # 100 pairs, 10 held back, source moved by 2: 88..102 rather than 90..100.
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 10 1 2) -Atlas 88).ok | Should -BeTrue
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 10 1 2) -Atlas 102).ok | Should -BeTrue
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 10 1 2) -Atlas 87).ok | Should -BeFalse
        (Get-SqlScopeVerdict -Expectation (New-Pairs 100 10 1 2) -Atlas 103).reason | Should -Match 'outside the possible range 88-102'
    }

    It 'reports an unverifiable scope without failing it' {
        $e = New-Pairs 0
        $e.Unverifiable = 'the statement pages with @Offset'
        $v = Get-SqlScopeVerdict -Expectation $e -Atlas 12
        $v.ok | Should -BeTrue
        $v.expected | Should -BeNullOrEmpty
        $v.reason | Should -Be 'not verified: the statement pages with @Offset'
    }
}

Describe 'Get-SqlSourceCountSql' {
    It 'for an assignment statement, groups by the mapped pair so one pass gives rows and pairs, quoting the column names' {
        $sql = Get-SqlSourceCountSql -Slot @{ target = 'assignments'; sql = 'SELECT a AS [res]], id], b AS p FROM t' } -Map @{ resourceId = 'res], id'; principalId = 'p' }
        $sql | Should -Match '^SELECT COALESCE\(SUM\(g\.n\), 0\), COUNT_BIG\(\*\) FROM \(SELECT COUNT_BIG\(\*\) AS n FROM \('
        $sql | Should -Match 'SELECT a AS \[res\]\], id\], b AS p FROM t\s+\) q GROUP BY q\.\[res\]\], id\], q\.\[p\]\) g$'
    }

    It 'falls back to the identityId column for the principal side' {
        Get-SqlSourceCountSql -Slot @{ target = 'assignments'; sql = 'S' } -Map @{ resourceId = 'r'; identityId = 'i' } | Should -Match 'GROUP BY q\.\[r\], q\.\[i\]\) g$'
    }

    It 'counts rows only for any other target, and for an assignment statement with no map (nothing was read)' {
        $plain = '^SELECT COUNT_BIG\(\*\), NULL FROM \(\s+S\s+\) q$'
        Get-SqlSourceCountSql -Slot @{ target = 'principals'; sql = 'S' } -Map @{ resourceId = 'r'; principalId = 'p' } | Should -Match $plain
        Get-SqlSourceCountSql -Slot @{ target = 'assignments'; sql = 'S' } -Map $null | Should -Match $plain
        Get-SqlSourceCountSql -Slot @{ target = 'assignments'; sql = 'S' } -Map @{ resourceId = 'r' } | Should -Match $plain
    }

    It '-RowsOnly drops the GROUP BY even for a fully mapped assignment statement' {
        # The count taken BEFORE the read wants the rows and nothing else. The
        # distinct-pair GROUP BY is the expensive half — 3.0 s against 4.8 s over
        # the same 3.2 M-row statement on the rehearsal fixture — and the pair
        # count is needed once, afterwards.
        $sql = Get-SqlSourceCountSql -Slot @{ target = 'assignments'; sql = 'S' } -Map @{ resourceId = 'r'; principalId = 'p' } -RowsOnly
        $sql | Should -Match '^SELECT COUNT_BIG\(\*\), NULL FROM \(\s+S\s+\) q$'
        $sql | Should -Not -Match 'GROUP BY'
    }
}

Describe 'Measure-SqlSource' {
    It 'returns the source rows and pairs, runs with the command timeout, and disposes reader and command' {
        $conn = New-FakeConnection @([long]400000, [long]399990)
        $m = Measure-SqlSource -Connection $conn -Slot @{ target = 'assignments'; paged = $false; sql = 'S' } -Map @{ resourceId = 'r'; principalId = 'p' } -CommandTimeout 77
        $m.rows | Should -Be 400000
        $m.pairs | Should -Be 399990
        $m.reason | Should -BeNullOrEmpty
        $script:lastTimeout | Should -Be 77
        @($script:disposed) | Should -Be @('reader', 'command')
    }

    It 'reports no pairs when the source answers NULL for them' {
        $m = Measure-SqlSource -Connection (New-FakeConnection @([long]1800, [System.DBNull]::Value)) -Slot @{ target = 'principals'; paged = $false; sql = 'S' } -Map @{}
        $m.rows | Should -Be 1800
        $m.pairs | Should -BeNullOrEmpty
    }

    It 'asks for the rows-only count when -RowsOnly is set, binding the same window' {
        $m = Measure-SqlSource -Connection (New-FakeConnection @([long]33857035, [System.DBNull]::Value)) `
            -Slot @{ target = 'assignments'; paged = $false; sql = 'S' } -Map @{ resourceId = 'r'; principalId = 'p' } -Since ([long]1700000000000) -RowsOnly
        $m.rows | Should -Be 33857035
        $script:lastSql | Should -Not -Match 'GROUP BY'
        # The window the count asks about must be the window the read asked
        # about, or a delta run compares a window's rows with the whole table.
        @($script:lastParams).Count | Should -Be 1
        $script:lastParams[0].ParameterName | Should -Be '@Since'
        $script:lastParams[0].Value | Should -Be 1700000000000
    }

    It 'does not attempt a paged statement or a missing connection, and survives a failure' {
        (Measure-SqlSource -Connection 'x' -Slot @{ paged = $true; sql = 'S' } -Map @{}).reason | Should -Match '@Offset'
        (Measure-SqlSource -Connection $null -Slot @{ paged = $false; sql = 'S' } -Map @{}).reason | Should -Match 'no source connection'
        $m = Measure-SqlSource -Connection (New-FakeConnection ([System.InvalidOperationException]::new('ORDER BY not allowed'))) -Slot @{ paged = $false; sql = 'S' } -Map @{}
        $m.rows | Should -BeNullOrEmpty
        $m.reason | Should -Match 'ORDER BY not allowed'
        @($script:disposed) | Should -Be @('command')
    }
}

Describe 'Get-SqlReadVerdict' {
    It 'fails the shipped case: 22,087 rows read of 176,703, although every one of them was distinct and landed' {
        $v = Get-SqlReadVerdict -Read @{ Slot = 'Identities'; Read = [long]22087; Source = [long]176703 }
        $v.ok | Should -BeFalse
        $v.reason | Should -Match 'read 22[.,]087 rows; the source returns 176[.,]703 rows'
        $v.reason | Should -Match 'The read stopped early'
    }

    It 'fails a read of more rows than the source now returns, and passes an exact one' {
        (Get-SqlReadVerdict -Read @{ Read = [long]11; Source = [long]10 }).ok | Should -BeFalse
        $ok = Get-SqlReadVerdict -Read @{ Read = [long]10; Source = [long]10 }
        $ok.ok | Should -BeTrue
        $ok.reason | Should -BeNullOrEmpty
    }

    It 'passes an unmeasured read, saying why it was not verified' {
        $v = Get-SqlReadVerdict -Read @{ Read = [long]5; Source = $null; Reason = 'the statement pages with @Offset' }
        $v.ok | Should -BeTrue
        $v.reason | Should -Be 'not verified: the statement pages with @Offset'
    }
}

# A large governance source is aggregated continuously; a read of it takes hours
# and nothing freezes it. The three rows below are the field run that failed:
# 805,491 read of 805,547; 33,857,035 read while the table held 33,841,580
# minutes later; 5,315,294 read of 5,325,064. Held to the count taken afterwards
# alone, all three fail — and because the verification runs before
# Save-SqlWatermarks, no watermark is stored for ANY statement.
Describe 'Get-SqlReadVerdict — a source that moves under the read' {
    It 'passes the field run that used to fail: read inside the band the two counts describe' {
        # Entitlements: the source grew by 56 while it was read.
        $grew = Get-SqlReadVerdict -Read @{ Slot = 'Entitlements'; Read = [long]805491; Before = [long]805491; Source = [long]805547 }
        $grew.ok | Should -BeTrue
        # Grants via a role: grew by 9,770.
        (Get-SqlReadVerdict -Read @{ Read = [long]5315294; Before = [long]5315294; Source = [long]5325064 }).ok | Should -BeTrue
        # Entitlement grants: SHRANK by 15,455 — rows were deleted mid-read, which
        # is why the crawler saw more rows than the table held afterwards.
        $shrank = Get-SqlReadVerdict -Read @{ Read = [long]33857035; Before = [long]33857035; Source = [long]33841580 }
        $shrank.ok | Should -BeTrue
        $shrank.reason | Should -Match 'moved by 15[.,]455 during the read'
    }

    It 'reports the drift on every moving source, pass or fail, naming both counts and the band' {
        $v = Get-SqlReadVerdict -Read @{ Read = [long]1005; Before = [long]1000; Source = [long]1010 }
        $v.ok | Should -BeTrue
        $v.reason | Should -Match 'held 1[.,]000 rows before the read and 1[.,]010 after'
        $v.reason | Should -Match 'moved by 10 during the read, so a complete read is 990-1[.,]020 rows'
    }

    It 'passes a read that exceeded both counts by no more than the source moved, and fails one that exceeded them by more' {
        # A source shrinking 1,000 -> 900 may still yield 1,010 rows: a row can be
        # read and then deleted. 1,001 is not more than the 100 of slack it bought.
        (Get-SqlReadVerdict -Read @{ Read = [long]1000; Before = [long]1000; Source = [long]900 }).ok | Should -BeTrue
        (Get-SqlReadVerdict -Read @{ Read = [long]1100; Before = [long]1000; Source = [long]900 }).ok | Should -BeTrue
        $v = Get-SqlReadVerdict -Read @{ Read = [long]1101; Before = [long]1000; Source = [long]900 }
        $v.ok | Should -BeFalse
        $v.reason | Should -Match 'returned more rows than the source ever held'
    }

    It 'still fails a read that stopped early, and the more the source moved the more it had to lose to pass' {
        # Grew 1,000 -> 1,010, so the floor is 990. One row below it fails.
        (Get-SqlReadVerdict -Read @{ Read = [long]990; Before = [long]1000; Source = [long]1010 }).ok | Should -BeTrue
        $v = Get-SqlReadVerdict -Read @{ Read = [long]989; Before = [long]1000; Source = [long]1010 }
        $v.ok | Should -BeFalse
        $v.reason | Should -Match 'The read stopped early'
    }

    It 'fails the 87.5% loss however hard the source churns, which is the whole point of the check' {
        # The shipped defect: 22,087 of 176,703 arrived. Even a source that moved
        # by 10,000 rows — far more than any field run has shown — cannot explain
        # losing seven rows in eight.
        (Get-SqlReadVerdict -Read @{ Read = [long]22087; Before = [long]176703; Source = [long]176703 }).ok | Should -BeFalse
        (Get-SqlReadVerdict -Read @{ Read = [long]22087; Before = [long]176703; Source = [long]166703 }).ok | Should -BeFalse
        (Get-SqlReadVerdict -Read @{ Read = [long]22087; Before = [long]176703; Source = [long]186703 }).ok | Should -BeFalse
    }

    It 'gives a source that did not move no slack at all: the band is the exact equality it always was' {
        # This is what keeps the check capable of catching a small silent loss. A
        # 1% flat tolerance would wave 990 through, and a verified run WRITES the
        # watermark, so the 10 lost rows would be stepped over permanently.
        (Get-SqlReadVerdict -Read @{ Read = [long]1000; Before = [long]1000; Source = [long]1000 }).ok | Should -BeTrue
        (Get-SqlReadVerdict -Read @{ Read = [long]999; Before = [long]1000; Source = [long]1000 }).ok | Should -BeFalse
        (Get-SqlReadVerdict -Read @{ Read = [long]1001; Before = [long]1000; Source = [long]1000 }).ok | Should -BeFalse
        (Get-SqlReadVerdict -Read @{ Read = [long]990; Before = [long]1000; Source = [long]1000 }).ok | Should -BeFalse
    }

    It 'falls back to exact equality when only one count could be taken' {
        # No count from before the read (a paged statement, or the count failed):
        # one number is all there is, so the comparison is what it always was.
        (Get-SqlReadVerdict -Read @{ Read = [long]999; Before = $null; Source = [long]1000 }).ok | Should -BeFalse
        (Get-SqlReadVerdict -Read @{ Read = [long]1000; Before = $null; Source = [long]1000 }).ok | Should -BeTrue
    }

    It 'holds the unplaced and misrouted bounds exactly as strictly for a moving source' {
        # Role assignments failed in the field with 100% of its rows unplaced,
        # because a statement it referenced was disabled. Nothing about a moving
        # source may soften that: the two findings are independent.
        $v = Get-SqlReadVerdict -Read @{ Read = [long]1000; Before = [long]1000; Source = [long]1010; Unplaced = [long]1000 }
        $v.ok | Should -BeFalse
        $v.reason | Should -Match 'could not be placed'
        (Get-SqlReadVerdict -Read @{ Read = [long]1000; Before = [long]1000; Source = [long]1010; Misrouted = [long]51 }).ok | Should -BeFalse
        (Get-SqlReadVerdict -Read @{ Read = [long]1000; Before = [long]1000; Source = [long]1010; Misrouted = [long]50 }).ok | Should -BeTrue
    }
}

Describe 'Get-SqlReadBand' {
    It 'is the single count twice when there is no count from before the read' {
        $b = Get-SqlReadBand -Before $null -After ([long]500)
        $b.Lo | Should -Be 500
        $b.Hi | Should -Be 500
        $b.Drift | Should -Be 0
        $b.Moving | Should -BeFalse
    }

    It 'is nothing at all when the source could not be counted' {
        Get-SqlReadBand -Before ([long]500) -After $null | Should -BeNullOrEmpty
    }

    It 'widens by exactly the drift, whichever way the source moved' {
        $grew = Get-SqlReadBand -Before ([long]1000) -After ([long]1010)
        $grew.Lo | Should -Be 990
        $grew.Hi | Should -Be 1020
        $grew.Drift | Should -Be 10
        $grew.Moving | Should -BeTrue
        $shrank = Get-SqlReadBand -Before ([long]1010) -After ([long]1000)
        $shrank.Lo | Should -Be 990
        $shrank.Hi | Should -Be 1020
        $shrank.Drift | Should -Be 10
    }
}

Describe 'expectations while streaming' {
    BeforeEach {
        Mock Invoke-IngestAPI { @{ inserted = @($Body.records).Count; updated = 0 } }
        Mock Update-CrawlerProgress { }
    }

    It 'a principals slot whose id repeats records more rows than keys, and its read against the source' {
        Mock Measure-SqlSource { @{ rows = [long]3; pairs = $null; reason = $null } }
        $script:replay = @(
            ([ordered]@{ id = 'a'; display_name = 'A1' }), ([ordered]@{ id = 'a'; display_name = 'A2' }),
            ([ordered]@{ id = 'b'; display_name = 'B' }))
        Mock Invoke-SqlQueryStream { foreach ($r in $script:replay) { & $OnRow $r }; [long]3 }
        $state = New-State
        Invoke-SqlSlot -Slot @{ name = 'P'; target = 'principals'; principalType = 'User'; sql = 'S'; paged = $false } -Connection 'c' -State $state | Out-Null
        $e = $state.Expect['ingest/principals|principalType=User']
        $e.Rows | Should -Be 3
        $e.KeySet.Count | Should -Be 2
        $e.Slots | Should -Be 1
        $state.Reads.Count | Should -Be 1
        $state.Reads[0].Slot | Should -Be 'P'
        $state.Reads[0].Read | Should -Be 3
        $state.Reads[0].Source | Should -Be 3
    }

    It 'an assignment slot takes the source distinct pairs and its dangling rows from the one measurement' {
        Mock Measure-SqlSource { @{ rows = [long]9; pairs = [long]7; reason = $null } }
        $script:replay = @(([ordered]@{ principalId = 'p1'; resourceId = 'r1' }), ([ordered]@{ principalId = 'p1'; resourceId = 'r1' }))
        Mock Invoke-SqlQueryStream { foreach ($r in $script:replay) { & $OnRow $r }; [long]2 }
        $state = New-State
        $slot = @{ name = 'G'; target = 'assignments'; resourceType = 'Entitlement'; assignmentType = 'Direct'; governed = $false; sql = 'S'; paged = $false }
        Invoke-SqlSlot -Slot $slot -Connection 'c' -State $state | Out-Null
        $e = $state.Expect['ingest/resource-assignments|assignmentType=Direct;governed=False;resourceType=Entitlement']
        $e.SourceDistinct | Should -Be 7
        $e.Dangling | Should -Be 0
        $state.Reads[0].Source | Should -Be 9
        # Twice: once before the read for the band's floor, once after for the
        # rows and the distinct pairs. Not three times — the pair count is the
        # expensive half and is asked for exactly once.
        Should -Invoke Measure-SqlSource -Times 2 -Exactly
        Should -Invoke Measure-SqlSource -Times 1 -Exactly -ParameterFilter { $RowsOnly }
    }

    It 'an empty assignment read still asks the source, so a read that returned nothing cannot pass for an empty table' {
        Mock Measure-SqlSource { @{ rows = [long]400; pairs = $null; reason = $null } }
        Mock Invoke-SqlQueryStream { [long]0 }
        $state = New-State
        Invoke-SqlSlot -Slot @{ name = 'G'; target = 'assignments'; resourceType = 'Entitlement'; assignmentType = 'Direct'; governed = $false; sql = 'S'; paged = $false } -Connection 'c' -State $state | Out-Null
        $state.Expect.Values[0].SourceDistinct | Should -Be 0
        $state.Reads[0].Read | Should -Be 0
        $state.Reads[0].Source | Should -Be 400
        (Get-SqlReadVerdict -Read $state.Reads[0]).ok | Should -BeFalse
    }

    It 'an assignment read the source could not count leaves the scope unverified with the reason' {
        Mock Measure-SqlSource { @{ rows = $null; pairs = $null; reason = 'the statement pages with @Offset' } }
        Mock Invoke-SqlQueryStream { & $OnRow ([ordered]@{ principalId = 'p1'; resourceId = 'r1' }); [long]1 }
        $state = New-State
        Invoke-SqlSlot -Slot @{ name = 'G'; target = 'assignments'; resourceType = 'Entitlement'; assignmentType = 'Direct'; governed = $false; sql = 'S'; paged = $true } -Connection 'c' -State $state | Out-Null
        $state.Expect.Values[0].Unverifiable | Should -Be 'the statement pages with @Offset'
    }
}

Describe 'Test-SqlRunCounts' {
    It 'asks the database for each scope since the run started, and passes when every count matches' {
        $script:asked = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $script:asked.Add($Body); @{ count = 2 } }
        Mock Update-CrawlerProgress { }
        $state = New-State
        $e = Get-SqlExpectation -State $state -Key 'k' -Endpoint 'ingest/resources' -Scope @{ resourceType = 'Entitlement' }
        [void]$e.KeySet.Add('r1'); [void]$e.KeySet.Add('r2'); $e.Rows = 2
        $r = Test-SqlRunCounts -State $state
        @($r).Count | Should -Be 1
        $r[0].ok | Should -BeTrue
        $r[0].scope | Should -Be 'resources (resourceType=Entitlement)'
        $script:asked[0].entity | Should -Be 'resources'
        $script:asked[0].systemId | Should -Be 5
        $script:asked[0].before | Should -Be '2026-09-26T08:00:00.000Z'
        $state.Verification[0].atlas | Should -Be 2
    }

    It 'checks every scope, then fails the run naming each one that is wrong' {
        Mock Invoke-IngestAPI { @{ count = 22087 } }
        Mock Update-CrawlerProgress { }
        $state = New-State
        $p = Get-SqlExpectation -State $state -Key 'p' -Endpoint 'ingest/principals' -Scope @{ principalType = 'User' }
        for ($i = 0; $i -lt 22087; $i++) { [void]$p.KeySet.Add("$i") }
        $p.Rows = 176696
        $a = Get-SqlExpectation -State $state -Key 'a' -Endpoint 'ingest/resource-assignments' -Scope @{}
        $a.SourceDistinct = 22087; $a.Slots = 1
        { Test-SqlRunCounts -State $state } | Should -Throw '*Verification failed for 1 of 2 check(s): principals (principalType=User): expected 22087, database 22087*'
        @($state.Verification).Count | Should -Be 2
    }

    It 'fails a read that stopped early even when every scope agrees with the database' {
        Mock Invoke-IngestAPI { @{ count = 22087 } }
        Mock Update-CrawlerProgress { }
        $state = New-State
        $p = Get-SqlExpectation -State $state -Key 'p' -Endpoint 'ingest/principals' -Scope @{ principalType = 'User' }
        for ($i = 0; $i -lt 22087; $i++) { [void]$p.KeySet.Add("$i") }
        $p.Rows = 22087
        $state.Reads.Add(@{ Slot = 'Identities'; Read = [long]22087; Source = [long]176703; Reason = $null })
        { Test-SqlRunCounts -State $state } | Should -Throw '*Verification failed for 1 of 2 check(s): read: Identities: expected 176703, read 22087*'
        $state.Verification[0].scope | Should -Be 'read: Identities'
        $state.Verification[1].ok | Should -BeTrue -Because 'the database does hold everything that was read'
    }

    It 'verifies reads alone when no scope was fed' {
        Mock Invoke-IngestAPI { throw 'must not be called' }
        Mock Update-CrawlerProgress { }
        $state = New-State
        $state.Reads.Add(@{ Slot = 'Apps'; Read = [long]15; Source = [long]15; Reason = $null })
        $r = @(Test-SqlRunCounts -State $state)
        $r.Count | Should -Be 1
        $r[0].ok | Should -BeTrue
        $r[0].measured | Should -Be 'read'
    }

    It 'does nothing when no scope was fed' {
        Mock Invoke-IngestAPI { throw 'must not be called' }
        @(Test-SqlRunCounts -State (New-State)).Count | Should -Be 0
    }
}

# A statement's rows that arrive but cannot be placed (dangling or skipped). An
# entitlement statement filtered on type = 'Entitlement' loaded 454 of 805,497 in
# production; every grant for the rest dangled, and the run used to pass.
Describe 'Get-SqlReadVerdict — rows that could not be placed' {
    It 'fails a read whose rows mostly could not be placed, even when the read itself was complete' {
        $v = Get-SqlReadVerdict -Read @{ Slot = 'Grants'; Read = [long]46000; Source = [long]46000; Unplaced = [long]45000 }
        $v.ok | Should -BeFalse
        $v.reason | Should -Match '^45[.,]000 of the 46[.,]000 rows read \(97[.,]8%\) could not be placed'
    }

    It 'allows up to 5% and fails just above it' {
        (Get-SqlReadVerdict -Read @{ Read = [long]100; Source = [long]100; Unplaced = [long]5 }).ok | Should -BeTrue
        (Get-SqlReadVerdict -Read @{ Read = [long]100; Source = [long]100; Unplaced = [long]6 }).ok | Should -BeFalse
    }

    It 'fails on the unplaced share even when the source could not be counted' {
        (Get-SqlReadVerdict -Read @{ Read = [long]10; Source = $null; Reason = 'the statement pages with @Offset'; Unplaced = [long]9 }).ok | Should -BeFalse
    }

    It 'does not divide by zero on an empty read' {
        (Get-SqlReadVerdict -Read @{ Read = [long]0; Source = [long]0; Unplaced = [long]0 }).ok | Should -BeTrue
    }
}

Describe 'Get-SqlSourceRowsBefore' {
    BeforeEach { Mock Write-Host { } }

    It 'counts the rows only, in the same window the read will use' {
        Mock Measure-SqlSource { @{ rows = [long]805491; pairs = $null; reason = $null } }
        $ctx = @{ Slot = @{ name = 'Entitlements'; target = 'assignments'; paged = $false; sql = 'S' }
                  State = (New-State); Delta = @{ Since = [long]1700000000000 } }
        Get-SqlSourceRowsBefore -Ctx $ctx -Connection 'c' | Should -Be 805491
        Should -Invoke Measure-SqlSource -Times 1 -Exactly -ParameterFilter { $RowsOnly -and $Since -eq 1700000000000 }
    }

    It 'binds no window for a statement that reads in full' {
        Mock Measure-SqlSource { @{ rows = [long]12; pairs = $null; reason = $null } }
        $ctx = @{ Slot = @{ name = 'Apps'; target = 'resources'; paged = $false; sql = 'S' }; State = (New-State); Delta = $null }
        Get-SqlSourceRowsBefore -Ctx $ctx -Connection 'c' | Should -Be 12
        Should -Invoke Measure-SqlSource -Times 1 -Exactly -ParameterFilter { $null -eq $Since }
    }

    It 'does not ask at all for a paged statement or without a connection' {
        Mock Measure-SqlSource { throw 'must not be called' }
        $paged = @{ Slot = @{ name = 'P'; target = 'resources'; paged = $true; sql = 'S' }; State = (New-State); Delta = $null }
        Get-SqlSourceRowsBefore -Ctx $paged -Connection 'c' | Should -BeNullOrEmpty
        $plain = @{ Slot = @{ name = 'P'; target = 'resources'; paged = $false; sql = 'S' }; State = (New-State); Delta = $null }
        Get-SqlSourceRowsBefore -Ctx $plain -Connection $null | Should -BeNullOrEmpty
        Should -Invoke Measure-SqlSource -Times 0 -Exactly
    }

    It 'says so and falls back when the count could not be taken, instead of failing the load' {
        Mock Measure-SqlSource { @{ rows = $null; pairs = $null; reason = 'the source count failed: timeout' } }
        $ctx = @{ Slot = @{ name = 'Grants'; target = 'assignments'; paged = $false; sql = 'S' }; State = (New-State); Delta = $null }
        Get-SqlSourceRowsBefore -Ctx $ctx -Connection 'c' | Should -BeNullOrEmpty
        Should -Invoke Write-Host -Times 1 -Exactly -ParameterFilter { $Object -match 'could not be counted before the read' -and $Object -match 'timeout' }
    }
}

Describe 'Add-SqlReadCheck — a source that moved' {
    BeforeEach { Mock Write-Host { } }

    It 'records both ends of the band and reports the drift as a finding' {
        Mock Measure-SqlSource { @{ rows = [long]33841580; pairs = $null; reason = $null } }
        $state = New-State
        $ctx = @{ Slot = @{ name = 'Entitlement grants'; target = 'relationships'; paged = $false; sql = 'S' }; Map = @{}
                  State = $state; SourceBefore = [long]33857035; Dangling = 0; Skipped = 0; Misrouted = 0 }
        Add-SqlReadCheck -Ctx $ctx -Connection 'c' -Rows 33857035
        $state.Reads[0].Before | Should -Be 33857035
        $state.Reads[0].Source | Should -Be 33841580
        (Get-SqlReadVerdict -Read $state.Reads[0]).ok | Should -BeTrue
        Should -Invoke Write-Host -Times 1 -Exactly -ParameterFilter { $Object -match 'moved by 15[.,]455 rows during the read' }
    }

    It 'gives the assignment scope the same drift as its slack, and nothing when the source held still' {
        Mock Measure-SqlSource { @{ rows = [long]1010; pairs = [long]1000; reason = $null } }
        $state = New-State
        $slot = @{ name = 'G'; target = 'assignments'; resourceType = 'Entitlement'; assignmentType = 'Direct'; governed = $false; paged = $false; sql = 'S' }
        $streams = New-SqlSlotStreams -Slot $slot -State $state -Complete $true
        $ctx = @{ Slot = $slot; Map = @{ resourceId = 'r'; principalId = 'p' }; State = $state; Streams = $streams
                  SourceBefore = [long]1000; Dangling = 0; Skipped = 0; Misrouted = 0 }
        Add-SqlReadCheck -Ctx $ctx -Connection 'c' -Rows 1005
        $streams.assignment.Expect.SourceDistinct | Should -Be 1000
        $streams.assignment.Expect.Drift | Should -Be 10

        $state2 = New-State
        $streams2 = New-SqlSlotStreams -Slot $slot -State $state2 -Complete $true
        $ctx2 = @{ Slot = $slot; Map = @{ resourceId = 'r'; principalId = 'p' }; State = $state2; Streams = $streams2
                   SourceBefore = [long]1010; Dangling = 0; Skipped = 0; Misrouted = 0 }
        Add-SqlReadCheck -Ctx $ctx2 -Connection 'c' -Rows 1010
        $streams2.assignment.Expect.Drift | Should -Be 0
    }
}

Describe 'Add-SqlReadCheck — unplaced rows' {
    It 'records dangling plus skipped rows with the read' {
        Mock Measure-SqlSource { @{ rows = [long]10; pairs = $null; reason = $null } }
        $state = New-State
        $ctx = @{ Slot = @{ name = 'Composition'; target = 'relationships'; paged = $false; sql = 'S' }; Map = @{}; State = $state; Dangling = 3; Skipped = 2; Misrouted = 0 }
        Add-SqlReadCheck -Ctx $ctx -Connection 'c' -Rows 10
        $state.Reads[0].Unplaced | Should -Be 5
        (Get-SqlReadVerdict -Read $state.Reads[0]).ok | Should -BeFalse
    }

    It 'records misrouted rows separately from unplaced ones' {
        # They are different findings: an unplaced row names an object the run
        # did not load, a misrouted one names a SYSTEM it did not create. Adding
        # them together would let 3% of each pass while 6% of the rows are wrong.
        Mock Measure-SqlSource { @{ rows = [long]100; pairs = $null; reason = $null } }
        $state = New-State
        $ctx = @{ Slot = @{ name = 'Entitlements'; target = 'resources'; paged = $false; sql = 'S' }; Map = @{}; State = $state; Dangling = 0; Skipped = 0; Misrouted = 40 }
        Add-SqlReadCheck -Ctx $ctx -Connection 'c' -Rows 100
        $state.Reads[0].Unplaced | Should -Be 0
        $state.Reads[0].Misrouted | Should -Be 40
        (Get-SqlReadVerdict -Read $state.Reads[0]).ok | Should -BeFalse
    }
}

# A scope the run wrote to several systems: the source's counts are per
# statement, so the database side has to be summed over exactly those systems.
Describe 'Measure-SqlScopeRows' {
    It 'counts every system the scope was written to and adds them up' {
        $script:asked = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $script:asked.Add($Body); @{ count = 100 * $Body.systemId } }
        $state = New-State
        $e = Get-SqlExpectation -State $state -Key 'r' -Endpoint 'ingest/resources' -Scope @{ resourceType = 'Entitlement' }
        [void]$e.Systems.Add(11); [void]$e.Systems.Add(12)
        Measure-SqlScopeRows -State $state -Expectation $e | Should -Be 2300
        @($script:asked.systemId | Sort-Object) | Should -Be @(11, 12)
        @($script:asked.entity | Select-Object -Unique) | Should -Be @('resources')
    }

    It 'falls back to the crawler own system when nothing routed' {
        Mock Invoke-IngestAPI { @{ count = 7 } }
        $state = New-State
        $e = Get-SqlExpectation -State $state -Key 'r' -Endpoint 'ingest/resources' -Scope @{}
        Measure-SqlScopeRows -State $state -Expectation $e | Should -Be 7
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter { $Body.systemId -eq 5 }
    }

    It 'names the systems in the scope label only when there is more than one' {
        $one = Get-SqlExpectation -State (New-State) -Key 'a' -Endpoint 'ingest/resources' -Scope @{ resourceType = 'Entitlement' }
        [void]$one.Systems.Add(11)
        Format-SqlScopeLabel -Expectation $one | Should -Be 'resources (resourceType=Entitlement)'
        [void]$one.Systems.Add(12)
        Format-SqlScopeLabel -Expectation $one | Should -Be 'resources (resourceType=Entitlement) ×2 systems'
    }
}
