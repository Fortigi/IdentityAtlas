#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/sql/SqlCrawler.Verify.ps1 — the
    end-of-run comparison of what the source returned with what the database
    holds.

.DESCRIPTION
    The central case is the one that shipped: a principals statement whose id
    column repeats, eight rows per id. The ingest reported every row as sent and
    the run reported success while an eighth of the people existed. Here the
    database count EQUALS what was sent (22,087 of 22,087), and the run must
    still fail, because the source had eight times as many rows.

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
    # A connection whose command returns $Value from ExecuteScalar (or throws it),
    # recording the SQL it was given.
    function New-FakeConnection($Value) {
        $script:lastSql = $null
        $conn = [pscustomobject]@{}
        $conn | Add-Member -MemberType ScriptMethod -Name CreateCommand -Value {
            $cmd = [pscustomobject]@{ CommandText = ''; CommandTimeout = 0 }
            $cmd | Add-Member -MemberType ScriptMethod -Name ExecuteScalar -Value {
                $script:lastSql = $this.CommandText
                if ($script:scalar -is [System.Exception]) { throw $script:scalar }
                $script:scalar
            }
            $cmd | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
            $cmd
        }
        $script:scalar = $Value
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

Describe 'Measure-SqlSourceDistinct' {
    It 'counts distinct (resource, principal) pairs over the statement, quoting the column names' {
        $conn = New-FakeConnection ([long]321)
        $slot = @{ paged = $false; sql = 'SELECT a AS [res]], id], b AS p FROM t' }
        $m = Measure-SqlSourceDistinct -Connection $conn -Slot $slot -Map @{ resourceId = 'res], id'; principalId = 'p' }
        $m.count | Should -Be 321
        $script:lastSql | Should -Match '^SELECT COUNT_BIG\(\*\) FROM \(SELECT DISTINCT q\.\[res\]\], id\], q\.\[p\] FROM \('
        $script:lastSql | Should -Match 'SELECT a AS \[res\]\], id\], b AS p FROM t\s+\) q\) d$'
    }

    It 'falls back to the identityId column for the principal side' {
        $conn = New-FakeConnection ([long]1)
        Measure-SqlSourceDistinct -Connection $conn -Slot @{ paged = $false; sql = 'S' } -Map @{ resourceId = 'r'; identityId = 'i' } | Out-Null
        $script:lastSql | Should -Match 'q\.\[r\], q\.\[i\]'
    }

    It 'does not attempt a paged statement, a result set with no mapped columns, or survive a failure' {
        (Measure-SqlSourceDistinct -Connection 'x' -Slot @{ paged = $true; sql = 'S' } -Map @{}).reason | Should -Match '@Offset'
        (Measure-SqlSourceDistinct -Connection 'x' -Slot @{ paged = $false; sql = 'S' } -Map @{}).reason | Should -Be 'no rows were read'
        $m = Measure-SqlSourceDistinct -Connection (New-FakeConnection ([System.InvalidOperationException]::new('ORDER BY not allowed'))) -Slot @{ paged = $false; sql = 'S' } -Map @{ resourceId = 'r'; principalId = 'p' }
        $m.count | Should -BeNullOrEmpty
        $m.reason | Should -Match 'ORDER BY not allowed'
    }
}

Describe 'expectations while streaming' {
    BeforeEach {
        Mock Invoke-IngestAPI { @{ inserted = @($Body.records).Count; updated = 0 } }
        Mock Update-CrawlerProgress { }
    }

    It 'a principals slot whose id repeats records more rows than keys' {
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
    }

    It 'an assignment slot takes the source distinct count and its dangling rows; an empty one expects zero' {
        Mock Measure-SqlSourceDistinct { @{ count = [long]7; reason = $null } }
        $script:replay = @(([ordered]@{ principalId = 'p1'; resourceId = 'r1' }), ([ordered]@{ principalId = 'p1'; resourceId = 'r1' }))
        Mock Invoke-SqlQueryStream { foreach ($r in $script:replay) { & $OnRow $r }; [long]2 }
        $state = New-State
        $slot = @{ name = 'G'; target = 'assignments'; resourceType = 'Entitlement'; assignmentType = 'Direct'; governed = $false; sql = 'S'; paged = $false }
        Invoke-SqlSlot -Slot $slot -Connection 'c' -State $state | Out-Null
        $e = $state.Expect['ingest/resource-assignments|assignmentType=Direct;governed=False;resourceType=Entitlement']
        $e.SourceDistinct | Should -Be 7
        $e.Dangling | Should -Be 0
        Should -Invoke Measure-SqlSourceDistinct -Times 1 -Exactly

        Mock Invoke-SqlQueryStream { [long]0 }
        $empty = New-State
        Invoke-SqlSlot -Slot $slot -Connection 'c' -State $empty | Out-Null
        $empty.Expect.Values[0].SourceDistinct | Should -Be 0
        Should -Invoke Measure-SqlSourceDistinct -Times 1 -Exactly -Because 'an empty result needs no source count'
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
        { Test-SqlRunCounts -State $state } | Should -Throw '*Verification failed for 1 of 2 scope(s): principals (principalType=User): expected 22087, database 22087*'
        @($state.Verification).Count | Should -Be 2
    }

    It 'does nothing when no scope was fed' {
        Mock Invoke-IngestAPI { throw 'must not be called' }
        @(Test-SqlRunCounts -State (New-State)).Count | Should -Be 0
    }
}
