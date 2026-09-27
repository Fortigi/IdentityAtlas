#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/sql/SqlCrawler.Verify.ps1 — the
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
    foreach ($f in @(
        @('shared', 'Invoke-CrawlerIngest.ps1'), @('shared', 'Invoke-CrawlerIngestStream.ps1'),
        @('sql', 'SqlCrawler.Functions.ps1'), @('sql', 'SqlCrawler.Transform.ps1'), @('sql', 'SqlCrawler.Contexts.ps1'),
        @('sql', 'SqlCrawler.Phases.ps1'), @('sql', 'SqlCrawler.Verify.ps1'))) {
        . (Join-Path $root 'tools' 'crawlers' $f[0] $f[1])
    }
    function New-State { New-SqlRunState -SystemId 5 -ServerTime '2026-09-26T08:00:00.000Z' -Slots @() -BatchSize 1000 }
    function New-Keyed([long]$Rows, [int]$Distinct) {
        $e = Get-SqlExpectation -State (New-State) -Key 'k' -Endpoint 'ingest/principals' -Scope @{ principalType = 'User' }
        for ($i = 0; $i -lt $Distinct; $i++) { [void]$e.KeySet.Add("p$i") }
        $e.Rows = $Rows
        return $e
    }
    function New-Pairs([long]$SourceDistinct, [long]$Dangling = 0, [int]$Slots = 1) {
        $e = Get-SqlExpectation -State (New-State) -Key 'a' -Endpoint 'ingest/resource-assignments' -Scope @{ assignmentType = 'Direct' }
        $e.SourceDistinct = $SourceDistinct; $e.Dangling = $Dangling; $e.Slots = $Slots
        return $e
    }
    # A connection whose command answers one row of $Values from ExecuteReader (or
    # throws $Values when it is an exception), recording the SQL it was given and
    # whether the reader and command were disposed.
    function New-FakeConnection($Values) {
        $script:lastSql = $null; $script:disposed = [System.Collections.Generic.List[string]]::new()
        $conn = [pscustomobject]@{}
        $conn | Add-Member -MemberType ScriptMethod -Name CreateCommand -Value {
            $cmd = [pscustomobject]@{ CommandText = ''; CommandTimeout = 0 }
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
        $v.reason | Should -Match 'read 22[.,]087 rows but the source returns 176[.,]703'
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
        Should -Invoke Measure-SqlSource -Times 1 -Exactly
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
