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
    function New-Keyed([long]$Rows, [int]$Distinct, [string]$Endpoint = 'ingest/principals') {
        $e = Get-SqlExpectation -State (New-State) -Key 'k' -Endpoint $Endpoint -Scope @{ principalType = 'User' }
        for ($i = 0; $i -lt $Distinct; $i++) { [void]$e.KeySet.Add("p$i") }
        $e.Rows = $Rows
        return $e
    }
    # A relationships scope the way Add-SqlRelationshipRow fills it: one key per
    # (parent, child) pair, and $Rows counting every source row that produced one.
    function New-PairKeyed([long]$Rows, [int]$Distinct, [string]$Endpoint = 'ingest/resource-relationships') {
        # -Keyed: an assignment endpoint has no key set unless it is asked for,
        # which is exactly how the ownership owner assignment gets one.
        $e = Get-SqlExpectation -State (New-State) -Key 'r' -Endpoint $Endpoint -Scope @{ relationshipType = 'Contains' } -Keyed
        for ($i = 0; $i -lt $Distinct; $i++) { [void]$e.KeySet.Add("role$i|ent$i") }
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

    It 'keeps the repeated-id failure for resources, where one record really does replace another' {
        # The check exists for this: two resources sharing an externalId are two
        # DIFFERENT records, and only one survives. Nothing here may soften.
        $v = Get-SqlScopeVerdict -Expectation (New-Keyed -Rows 5540 -Distinct 5534 -Endpoint 'ingest/resources') -Atlas 5534
        $v.ok | Should -BeFalse
        $v.reason | Should -Match '6 were lost'
        (Get-SqlScopeVerdict -Expectation (New-Keyed -Rows 176696 -Distinct 22087 -Endpoint 'ingest/resources') -Atlas 22087).ok | Should -BeFalse
    }
}

# A relationship is keyed on (parent, child) and an assignment on
# (resource, principal). Two source rows producing one such key are the same
# edge — a business role can reference one entitlement through two source
# applications — so collapsing them is correct and idempotent. Held to the id
# rule, a real run failed with expected and database BOTH reading 5,534:
#   FAIL resource-relationships (relationshipType=Contains) expected 5,534  database 5,534
#        the source returned 5,540 rows for only 5,534 distinct ids ... so 6 were lost
Describe 'Get-SqlScopeVerdict — scopes keyed on a pair' {
    It 'passes the field failure: 5,540 source rows, 5,534 distinct pairs, 5,534 in the database' {
        $v = Get-SqlScopeVerdict -Expectation (New-PairKeyed -Rows 5540 -Distinct 5534) -Atlas 5534
        $v.ok | Should -BeTrue
        $v.expected | Should -Be 5534
        $v.atlas | Should -Be 5534
        $v.reason | Should -Match '5[.,]540 source rows collapsed to 5[.,]534 distinct pairs'
        # The specific false claim that failed the run must be gone.
        $v.reason | Should -Not -Match '\d+ were lost'
        $v.reason | Should -Not -Match 'Make the id column unique'
    }

    It 'compares distinct against distinct, so a shortfall in the database still fails' {
        # The collapse is forgiven; the database disagreeing with what was sent
        # is not. Without this the change would be a hole rather than a fix.
        (Get-SqlScopeVerdict -Expectation (New-PairKeyed -Rows 5540 -Distinct 5534) -Atlas 5533).ok | Should -BeFalse
        (Get-SqlScopeVerdict -Expectation (New-PairKeyed -Rows 5540 -Distinct 5534) -Atlas 5535).ok | Should -BeFalse
        (Get-SqlScopeVerdict -Expectation (New-PairKeyed -Rows 5540 -Distinct 5534) -Atlas 0).ok | Should -BeFalse
    }

    It 'says nothing about a collapse when there was none' {
        $v = Get-SqlScopeVerdict -Expectation (New-PairKeyed -Rows 5534 -Distinct 5534) -Atlas 5534
        $v.ok | Should -BeTrue
        $v.reason | Should -BeNullOrEmpty
    }

    It 'treats a keyed ownership assignment the same way, since its key is (resource, principal) too' {
        # The only assignment scope that carries a key set: one owner assignment
        # per owned resource. Two statements naming the same owner of the same
        # resource are one assignment, not a lost record.
        $v = Get-SqlScopeVerdict -Expectation (New-PairKeyed -Rows 12 -Distinct 10 -Endpoint 'ingest/resource-assignments') -Atlas 10
        $v.ok | Should -BeTrue
        $v.reason | Should -Match 'collapsed to 10 distinct pairs'
    }
}

Describe 'Test-SqlPairKeyedEndpoint' {
    It 'is true exactly for the two endpoints the model keys on a pair' {
        Test-SqlPairKeyedEndpoint -Endpoint 'ingest/resource-relationships' | Should -BeTrue
        Test-SqlPairKeyedEndpoint -Endpoint 'ingest/resource-assignments' | Should -BeTrue
    }

    It 'is false for every scope keyed on one record id, and for nothing at all' {
        Test-SqlPairKeyedEndpoint -Endpoint 'ingest/resources' | Should -BeFalse
        Test-SqlPairKeyedEndpoint -Endpoint 'ingest/principals' | Should -BeFalse
        Test-SqlPairKeyedEndpoint -Endpoint 'ingest/identities' | Should -BeFalse
        Test-SqlPairKeyedEndpoint -Endpoint '' | Should -BeFalse
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

    It 'a relationships slot whose join produces one edge twice verifies, through the real streaming path' {
        # Not the pure verdict this time: the whole path, so the key the handler
        # actually builds ("parent|child") is the one the verdict judges. A
        # business role reaching one entitlement through two source applications
        # is the shape that failed in the field.
        Mock Measure-SqlSource { @{ rows = [long]3; pairs = $null; reason = $null } }
        $script:replay = @(
            ([ordered]@{ parentId = 'role1'; childId = 'ent1' }),
            ([ordered]@{ parentId = 'role1'; childId = 'ent1' }),
            ([ordered]@{ parentId = 'role1'; childId = 'ent2' }))
        Mock Invoke-SqlQueryStream { foreach ($r in $script:replay) { & $OnRow $r }; [long]3 }
        $state = New-State
        Invoke-SqlSlot -Slot @{ name = 'Composition'; target = 'relationships'; relationshipType = 'Contains'; sql = 'S'; paged = $false } -Connection 'c' -State $state | Out-Null
        $e = $state.Expect['ingest/resource-relationships|relationshipType=Contains']
        $e.Rows | Should -Be 3
        $e.KeySet.Count | Should -Be 2
        $v = Get-SqlScopeVerdict -Expectation $e -Atlas 2
        $v.ok | Should -BeTrue
        $v.reason | Should -Match '3 source rows collapsed to 2 distinct pairs'
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

    It 'no longer fails the whole run over a collapsed relationship pair, and still does over a repeated resource id' {
        Mock Invoke-IngestAPI { @{ count = 5534 } }
        Mock Update-CrawlerProgress { }
        # The field run: the relationships scope agrees with the database exactly
        # and only the duplicate-id complaint failed the job.
        $ok = New-State
        $r = Get-SqlExpectation -State $ok -Key 'r' -Endpoint 'ingest/resource-relationships' -Scope @{ relationshipType = 'Contains' }
        for ($i = 0; $i -lt 5534; $i++) { [void]$r.KeySet.Add("role$i|ent$i") }
        $r.Rows = 5540
        $results = @(Test-SqlRunCounts -State $ok)
        $results.Count | Should -Be 1
        $results[0].ok | Should -BeTrue
        # Same numbers on a resources scope: still a failure, because there one
        # record really did replace another.
        $bad = New-State
        $res = Get-SqlExpectation -State $bad -Key 'x' -Endpoint 'ingest/resources' -Scope @{ resourceType = 'Entitlement' }
        for ($i = 0; $i -lt 5534; $i++) { [void]$res.KeySet.Add("e$i") }
        $res.Rows = 5540
        { Test-SqlRunCounts -State $bad } | Should -Throw '*Verification failed*'
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
