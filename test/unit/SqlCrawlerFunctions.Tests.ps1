#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/sql/SqlCrawler.Functions.ps1.

.DESCRIPTION
    Config resolution and the connection string are pure. The query runner is
    driven against an in-process fake of the SqlClient surface it uses
    (CreateCommand → ExecuteReader → Read/GetValue/GetName), so paging, streaming
    order and disposal are asserted without a SQL Server.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerFunctions.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'sql' 'SqlCrawler.Functions.ps1')

    function New-ConfigFile {
        param([hashtable]$Cfg)
        $path = Join-Path $TestDrive "cfg-$([guid]::NewGuid().ToString('N')).json"
        $Cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $path -Encoding UTF8
        return $path
    }
    # Merge overrides onto a base config (a + b throws when a key repeats).
    function Merge-Cfg { param([hashtable]$Base, [hashtable]$Over) $c = $Base.Clone(); foreach ($k in $Over.Keys) { $c[$k] = $Over[$k] }; return $c }
    $script:BaseCfg = @{
        server = 'db1'; database = 'iiq'; username = 'reader'; password = 'pw'
        queries = @(@{ name = 'Ids'; target = 'identities'; sql = 'SELECT id FROM t' })
    }

    # ── Fake SqlClient surface ───────────────────────────────────────────────
    # A "table" is @{ columns = @(...); pages = <scriptblock offset,pageSize -> rows[][]> }
    # The double enforces SequentialAccess the way SqlDataReader does. The old one
    # accepted the flag and ignored it, which is how the crawler shipped asking for
    # a mode that broke against a live Azure SQL database — a 26-column statement
    # died on "Invalid attempt to read from column ordinal '0'. With
    # CommandBehavior.SequentialAccess, you may only read from column ordinal '26'
    # or greater."
    #
    # Read honestly: the shapers read ordinals in ascending order, which the rule
    # allows, so this double does NOT reproduce that failure and neither did any
    # test. The guard that does is the assertion that the crawler never asks for
    # the mode at all — the flag bought nothing here (its purpose is streaming
    # large BLOBs, and binary columns are skipped) and cost a live run.
    class FakeReader {
        [string[]]$Columns; [object[]]$Rows; [int]$Pos = -1; [bool]$Disposed = $false; [int]$FieldCount
        [bool]$Sequential = $false; [int]$MinOrdinal = 0
        FakeReader([string[]]$c, [object[]]$r) { $this.Columns = $c; $this.Rows = $r; $this.FieldCount = $c.Length }
        [string]GetName([int]$i) { return $this.Columns[$i] }
        [bool]Read() { $this.Pos++; $this.MinOrdinal = 0; return $this.Pos -lt $this.Rows.Count }
        [object]GetValue([int]$i) {
            if ($this.Sequential -and $i -lt $this.MinOrdinal) {
                throw "Invalid attempt to read from column ordinal '$i'.  With CommandBehavior.SequentialAccess, you may only read from column ordinal '$($this.MinOrdinal)' or greater."
            }
            if ($this.Sequential) { $this.MinOrdinal = $i + 1 }
            return $this.Rows[$this.Pos][$i]
        }
        [void]Dispose() { $this.Disposed = $true }
    }
    class FakeParam { [string]$Name; [object]$Value; FakeParam([string]$n) { $this.Name = $n } }
    class FakeParams {
        [System.Collections.Generic.List[object]]$Items = [System.Collections.Generic.List[object]]::new()
        [object]Add([string]$name, [object]$type) { $p = [FakeParam]::new($name); $this.Items.Add($p); return $p }
        [object]Get([string]$name) { return ($this.Items | Where-Object { $_.Name -eq $name } | Select-Object -First 1) }
    }
    class FakeCommand {
        [string]$CommandText; [int]$CommandTimeout; [FakeParams]$Parameters = [FakeParams]::new(); [bool]$Disposed = $false
        [object]$Conn
        [object]$Connection      # what Assert-SqlReadCompleted probes through
        [object]$Behavior
        [object]ExecuteReader([object]$behavior) {
            $this.Behavior = $behavior
            $r = $this.Conn.OpenReader($this)
            $r.Sequential = ("$behavior" -eq 'SequentialAccess')
            return $r
        }
        # The post-read health probe ("SELECT 1"). A connection that died mid-stream
        # cannot answer it — that is the whole point of the check.
        [object]ExecuteScalar() {
            if (-not $this.Conn.Healthy) { throw 'A transport-level error has occurred when sending the request to the server.' }
            return 1
        }
        [void]Dispose() { $this.Disposed = $true }
    }
    class FakeConnection {
        [string[]]$Columns; [object[]]$AllRows
        [bool]$Healthy = $true   # set false to simulate a connection cut mid-stream
        [System.Collections.Generic.List[object]]$Commands = [System.Collections.Generic.List[object]]::new()
        [System.Collections.Generic.List[object]]$Readers  = [System.Collections.Generic.List[object]]::new()
        [System.Collections.Generic.List[object]]$ReadCommands = [System.Collections.Generic.List[object]]::new()
        FakeConnection([string[]]$c, [object[]]$rows) { $this.Columns = $c; $this.AllRows = $rows }
        [object]CreateCommand() { $cmd = [FakeCommand]::new(); $cmd.Conn = $this; $cmd.Connection = $this; $this.Commands.Add($cmd); return $cmd }
        [object]OpenReader([object]$cmd) {
            $this.ReadCommands.Add($cmd)   # commands that ran a page, excluding health probes
            $rows = $this.AllRows
            $off = $cmd.Parameters.Get('@Offset'); $size = $cmd.Parameters.Get('@PageSize')
            if ($off) { $rows = @($rows | Select-Object -Skip ([int]$off.Value) -First ([int]$size.Value)) }
            $r = [FakeReader]::new($this.Columns, $rows); $this.Readers.Add($r); return $r
        }
    }
}

Describe 'Test-SqlPagedQuery' {
    It 'is true only when the statement binds @Offset (any case, whole word)' {
        Test-SqlPagedQuery -Sql 'SELECT 1 ORDER BY id OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY' | Should -BeTrue
        Test-SqlPagedQuery -Sql 'select 1 offset @offset rows' | Should -BeTrue
        Test-SqlPagedQuery -Sql 'SELECT 1 -- @PageSize only' | Should -BeFalse
        Test-SqlPagedQuery -Sql 'SELECT @OffsetDays FROM t' | Should -BeFalse
        Test-SqlPagedQuery -Sql '' | Should -BeFalse
    }
}

Describe 'Resolve-SqlQuerySlot' {
    It 'normalises a minimal identities slot with the defaults' {
        $s = Resolve-SqlQuerySlot -Slot @{ name = 'Ids'; target = 'Identities'; sql = 'SELECT 1' }
        $s.target | Should -Be 'identities'
        $s.enabled | Should -BeTrue
        $s.assignmentType | Should -Be 'Direct'
        $s.relationshipType | Should -Be 'Contains'
        $s.principalType | Should -Be 'User'
        $s.governed | Should -BeFalse
        $s.paged | Should -BeFalse
    }

    It 'keeps explicit values, coerces governed/enabled, and detects paging' {
        $s = Resolve-SqlQuerySlot -Slot @{ name = 'RA'; target = 'assignments'; sql = 'SELECT 1 OFFSET @Offset ROWS'; resourceType = ' BusinessRole '; assignmentType = 'Eligible'; governed = 'true'; enabled = $false }
        $s.resourceType | Should -Be 'BusinessRole'
        $s.assignmentType | Should -Be 'Eligible'
        $s.governed | Should -BeTrue
        $s.enabled | Should -BeFalse
        $s.paged | Should -BeTrue
    }

    It 'names an unnamed slot by its position' {
        (Resolve-SqlQuerySlot -Slot @{ target = 'resources'; sql = 'x'; resourceType = 'Group' } -Index 2).name | Should -Be 'query 3'
    }

    It 'rejects an unknown target, an empty statement, and a resources/assignments slot without resourceType' {
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'users'; sql = 'x' } } | Should -Throw "*target 'users'*"
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'resources'; sql = '  '; resourceType = 'x' } } | Should -Throw '*statement is empty*'
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'resources'; sql = 'x' } } | Should -Throw '*needs a resourceType*'
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'assignments'; sql = 'x' } } | Should -Throw '*needs a resourceType*'
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'relationships'; sql = 'x' } } | Should -Not -Throw
    }

    It 'normalises a columnMap, dropping blanks and defaulting to empty' {
        (Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'resources'; sql = 'x'; resourceType = 'G' }).columnMap.Count | Should -Be 0
        $s = Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'assignments'; sql = 'x'; resourceType = 'G'
            columnMap = @{ IdentityID = 'principalId'; ' EntitlementID ' = ' resourceId '; Blank = ''; '' = 'id' } }
        $s.columnMap['IdentityID'] | Should -Be 'principalId'
        $s.columnMap['EntitlementID'] | Should -Be 'resourceId'   # key and value both trimmed
        $s.columnMap.ContainsKey('Blank') | Should -BeFalse
        $s.columnMap.Count | Should -Be 2
    }

    It 'reads a columnMap that arrived as a JSON object rather than a hashtable' {
        $slot = @{ name = 'q'; target = 'resources'; sql = 'x'; resourceType = 'G' }
        $slot.columnMap = ([pscustomobject]@{ RoleID = 'id'; RoleDisplayName = 'displayName' })
        $s = Resolve-SqlQuerySlot -Slot $slot
        $s.columnMap['RoleID'] | Should -Be 'id'
        $s.columnMap['RoleDisplayName'] | Should -Be 'displayName'
    }

    It 'rejects a columnMap entry whose target is not a column name' {
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'resources'; sql = 'x'; resourceType = 'G'; columnMap = @{ RoleID = 42 } } } |
            Should -Throw "*columnMap entry 'RoleID'*"
    }

    It 'rejects enum values off the list' {
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'assignments'; sql = 'x'; resourceType = 'G'; assignmentType = 'Owner' } } | Should -Throw "*assignmentType 'Owner'*"
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'relationships'; sql = 'x'; relationshipType = 'HasAppRole' } } | Should -Throw "*relationshipType 'HasAppRole'*"
        { Resolve-SqlQuerySlot -Slot @{ name = 'q'; target = 'principals'; sql = 'x'; principalType = 'Robot' } } | Should -Throw "*principalType 'Robot'*"
    }
}

Describe 'Resolve-SqlConfig' {
    It 'applies every default and reads the dispatcher keys' {
        $cfg = Resolve-SqlConfig -ConfigPath (New-ConfigFile -Cfg (Merge-Cfg -Base $script:BaseCfg -Over @{ _syncMode = 'delta'; _configName = 'IIQ prod' }))
        $cfg.server | Should -Be 'db1'
        $cfg.port | Should -Be 0
        $cfg.encrypt | Should -BeTrue
        $cfg.trustServerCertificate | Should -BeFalse
        $cfg.connectTimeout | Should -Be 30
        $cfg.commandTimeout | Should -Be 600
        $cfg.batchSize | Should -Be 5000
        $cfg.pageSize | Should -Be 10000
        $cfg.syncMode | Should -Be 'delta'
        $cfg.configName | Should -Be 'IIQ prod'
        $cfg.queries.Count | Should -Be 1
    }

    It 'honours explicit values, treats commandTimeout 0 as unlimited, and anything else as full sync' {
        $c = Merge-Cfg -Base $script:BaseCfg -Over @{ port = '1434'; encrypt = $false; trustServerCertificate = $true; connectTimeoutSeconds = 5; commandTimeoutSeconds = 0; batchSize = 250; pageSize = 999; _syncMode = 'weird' }
        $cfg = Resolve-SqlConfig -ConfigPath (New-ConfigFile -Cfg $c)
        $cfg.port | Should -Be 1434
        $cfg.encrypt | Should -BeFalse
        $cfg.trustServerCertificate | Should -BeTrue
        $cfg.connectTimeout | Should -Be 5
        $cfg.commandTimeout | Should -Be 0
        $cfg.batchSize | Should -Be 250
        $cfg.pageSize | Should -Be 999
        $cfg.syncMode | Should -Be 'full'
    }

    It 'falls back to the default for an out-of-range or non-numeric value' {
        $c = Merge-Cfg -Base $script:BaseCfg -Over @{ batchSize = 5; pageSize = 'lots'; port = -1 }
        $cfg = Resolve-SqlConfig -ConfigPath (New-ConfigFile -Cfg $c)
        $cfg.batchSize | Should -Be 5000
        $cfg.pageSize | Should -Be 10000
        $cfg.port | Should -Be 0
    }

    It 'fails on a missing connection field, naming it' {
        foreach ($k in 'server', 'database', 'username', 'password') {
            $c = $script:BaseCfg.Clone(); $c.Remove($k)
            { Resolve-SqlConfig -ConfigPath (New-ConfigFile -Cfg $c) } | Should -Throw "*missing '$k'*"
        }
    }

    It 'fails when there are no queries' {
        $c = $script:BaseCfg.Clone(); $c.queries = @()
        { Resolve-SqlConfig -ConfigPath (New-ConfigFile -Cfg $c) } | Should -Throw '*no queries*'
    }
}

Describe 'Get-SqlConnectionString / Get-SqlConnectionSummary' {
    BeforeAll {
        $script:ConnCfg = @{ server = 'db1'; port = 0; database = 'iiq'; username = 'reader'; password = 'S3cret!'; encrypt = $true; trustServerCertificate = $false; connectTimeout = 30 }
    }
    It 'builds a SQL-authentication connection string with the safety defaults' {
        $cs = Get-SqlConnectionString -Cfg $script:ConnCfg
        $cs | Should -Match 'Data Source=db1;'
        $cs | Should -Match 'Initial Catalog=iiq'
        $cs | Should -Match 'User ID=reader'
        $cs | Should -Match 'Password=S3cret!'
        $cs | Should -Match 'Encrypt=True'
        $cs | Should -Match 'TrustServerCertificate=False'
        $cs | Should -Match 'Connect Timeout=30'
        $cs | Should -Match 'MultipleActiveResultSets=False'
        $cs | Should -Not -Match 'Integrated Security'
    }
    It 'appends the port to the data source and passes the TLS flags through' {
        $cs = Get-SqlConnectionString -Cfg (Merge-Cfg -Base $script:ConnCfg -Over @{ port = 1533; encrypt = $false; trustServerCertificate = $true })
        $cs | Should -Match 'Data Source=db1,1533;'
        $cs | Should -Match 'Encrypt=False'
        $cs | Should -Match 'TrustServerCertificate=True'
    }
    It 'the summary names the server, database, user and TLS state but never the password' {
        $s = Get-SqlConnectionSummary -Cfg $script:ConnCfg
        $s | Should -Be 'db1 / iiq as reader (encrypted)'
        $s | Should -Not -Match 'S3cret'
        Get-SqlConnectionSummary -Cfg (Merge-Cfg -Base $script:ConnCfg -Over @{ port = 1433; trustServerCertificate = $true }) | Should -Be 'db1,1433 / iiq as reader (encrypted, server certificate trusted)'
        Get-SqlConnectionSummary -Cfg (Merge-Cfg -Base $script:ConnCfg -Over @{ encrypt = $false }) | Should -Match 'not encrypted'
    }
}

Describe 'ConvertFrom-SqlValue' {
    It 'maps NULL/DBNull to $null and passes strings, numbers and booleans through' {
        ConvertFrom-SqlValue -Value ([System.DBNull]::Value) | Should -BeNull
        ConvertFrom-SqlValue -Value $null | Should -BeNull
        ConvertFrom-SqlValue -Value 'x' | Should -Be 'x'
        ConvertFrom-SqlValue -Value 42 | Should -Be 42
        ConvertFrom-SqlValue -Value ([decimal]1.5) | Should -Be ([decimal]1.5)
        ConvertFrom-SqlValue -Value $true | Should -BeTrue
    }
    It 'renders dates, offsets, GUIDs and timespans as strings and drops binary' {
        ConvertFrom-SqlValue -Value ([datetime]'2026-09-25T10:11:12Z').ToUniversalTime() | Should -Match '^2026-09-25T10:11:12'
        ConvertFrom-SqlValue -Value ([System.DateTimeOffset]::new(2026, 1, 2, 3, 4, 5, [timespan]::Zero)) | Should -Be '2026-01-02T03:04:05.0000000+00:00'
        ConvertFrom-SqlValue -Value ([guid]'11111111-1111-1111-1111-111111111111') | Should -Be '11111111-1111-1111-1111-111111111111'
        ConvertFrom-SqlValue -Value ([timespan]::FromMinutes(90)) | Should -Be '01:30:00'
        ConvertFrom-SqlValue -Value ([byte[]](1, 2, 3)) | Should -BeNull
    }
}

Describe 'Read-SqlRow / Get-SqlReaderColumns' {
    It 'produces an ordered hashtable in column order with converted cells' {
        $r = [FakeReader]::new(@('id', 'when', 'blob'), @(, @('a1', [System.DBNull]::Value, [byte[]](1))))
        $cols = Get-SqlReaderColumns -Reader $r
        $cols | Should -Be @('id', 'when', 'blob')
        [void]$r.Read()
        $row = Read-SqlRow -Reader $r -Columns $cols
        @($row.Keys) | Should -Be @('id', 'when', 'blob')
        $row.id | Should -Be 'a1'
        $row.when | Should -BeNull
        $row.blob | Should -BeNull
    }
}

Describe 'Invoke-SqlQueryStream' {
    BeforeAll {
        $script:Rows = @(1..7 | ForEach-Object { , @("r$_", $_) })
    }

    It 'streams every row once, in order, through -OnRow for a plain statement with a single command' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        $seen = [System.Collections.Generic.List[string]]::new()
        $n = Invoke-SqlQueryStream -Connection $conn -Sql 'SELECT id, n FROM t' -OnRow { param($Row) $seen.Add($Row.id) } -CommandTimeout 12
        $n | Should -Be 7
        $seen | Should -Be @('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7')
        $conn.ReadCommands.Count | Should -Be 1
        $conn.ReadCommands[0].CommandTimeout | Should -Be 12
        $conn.ReadCommands[0].Parameters.Items.Count | Should -Be 0
        $conn.ReadCommands[0].Disposed | Should -BeTrue
        $conn.Readers[0].Disposed | Should -BeTrue
    }

    It 'pages with @Offset/@PageSize until a short page, covering every row exactly once' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        $seen = [System.Collections.Generic.List[string]]::new()
        $n = Invoke-SqlQueryStream -Connection $conn -Sql 'SELECT id, n FROM t ORDER BY n OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY' -OnRow { param($Row) $seen.Add($Row.id) } -Paged $true -PageSize 3
        $n | Should -Be 7
        $seen | Should -Be @('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7')
        # 3 + 3 + 1: the short third page ends the loop
        $conn.ReadCommands.Count | Should -Be 3
        @($conn.ReadCommands | ForEach-Object { [int]$_.Parameters.Get('@Offset').Value }) | Should -Be @(0, 3, 6)
        @($conn.ReadCommands | ForEach-Object { [int]$_.Parameters.Get('@PageSize').Value }) | Should -Be @(3, 3, 3)
        @($conn.ReadCommands | Where-Object { -not $_.Disposed }).Count | Should -Be 0
    }

    It 'a paged statement whose row count is a multiple of the page size runs one extra, empty page' {
        $conn = [FakeConnection]::new(@('id', 'n'), @($script:Rows | Select-Object -First 6))
        $n = Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { } -Paged $true -PageSize 3
        $n | Should -Be 6
        $conn.ReadCommands.Count | Should -Be 3
    }

    # The failure that reached a live Azure SQL instance: a 26-column identities
    # query died on its first row. The double now enforces the same rule the real
    # SqlDataReader does, so asking for SequentialAccess here would fail this.
    It 'reads a wide statement that returns MORE columns than a narrow one' {
        $wide = 0..25 | ForEach-Object { "col$_" }
        $conn = [FakeConnection]::new([string[]]$wide, @(, @(0..25 | ForEach-Object { "v$_" })))
        # A List, not `$x = $Row`: an assignment inside the scriptblock writes to
        # the scriptblock's own scope and never reaches the assertion.
        $captured = [System.Collections.Generic.List[object]]::new()
        $n = Invoke-SqlQueryStream -Connection $conn -Sql 'SELECT 26 columns' -OnRow { param($Row) $captured.Add($Row) }
        $n | Should -Be 1
        $seen = $captured[0]
        @($seen.Keys).Count | Should -Be 26
        $seen['col0'] | Should -Be 'v0'    # ordinal 0 must still be readable
        $seen['col25'] | Should -Be 'v25'
    }

    It 'does not ask for SequentialAccess, which forbids re-reading an earlier ordinal' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { } | Out-Null
        "$($conn.Commands[0].Behavior)" | Should -Not -Be 'SequentialAccess'
    }

    It 'reads every row of a MULTI-row wide statement, resetting to ordinal 0 each time' {
        $wide = 0..25 | ForEach-Object { "col$_" }
        $rows = 1..3 | ForEach-Object { $r = $_; , @(0..25 | ForEach-Object { "r$r-c$_" }) }
        $conn = [FakeConnection]::new([string[]]$wide, $rows)
        $first = [System.Collections.Generic.List[string]]::new()
        $n = Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { param($Row) $first.Add([string]$Row['col0']) }
        $n | Should -Be 3
        $first | Should -Be @('r1-c0', 'r2-c0', 'r3-c0')
    }

    # A result set cut short by a dropped connection ends exactly like a complete
    # one — Read() returns false, no error — so the crawler used to ingest part of
    # the source and report success. A 176,703-row table yielded 22,087 rows and a
    # green job. Failing loudly is the only safe reading of a dead connection.
    It 'fails the read when the connection did not survive it, naming the row count' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        $conn.Healthy = $false
        $seen = 0
        { Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { $seen++ } } |
            Should -Throw '*did not survive the read*7 row(s) arrived*'
    }

    It 'the failure tells a non-paged statement how to avoid it' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        $conn.Healthy = $false
        { Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { } } | Should -Throw '*OFFSET @Offset*'
    }

    It 'a healthy connection is probed exactly once per statement, not per row' {
        # The probe is a round trip; per row it would dwarf the read itself.
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { } | Should -Be 7
        # One command for the read, one for the probe.
        $conn.Commands.Count | Should -Be 2
    }

    It 'an empty result set yields 0 rows and no callbacks' {
        $conn = [FakeConnection]::new(@('id'), @())
        $calls = 0
        Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { $calls++ } | Should -Be 0
        $calls | Should -Be 0
    }

    It 'disposes the reader and command when the callback throws, and propagates the error' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        { Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { throw 'boom' } } | Should -Throw 'boom'
        $conn.Readers[0].Disposed | Should -BeTrue
        $conn.Commands[0].Disposed | Should -BeTrue
    }
}
