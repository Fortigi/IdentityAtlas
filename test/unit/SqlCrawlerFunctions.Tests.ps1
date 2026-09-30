#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Functions.ps1.

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
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql' 'SqlCrawler.Functions.ps1')

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
    #
    # The double is ENUMERABLE the way SqlDataReader is (DbDataReader implements
    # IEnumerable, and each step of its enumerator calls Read()). A double that was
    # not hid a data-loss bug for the life of the crawler: while a transcript runs —
    # and the worker runs every job under one — binding the reader to a function
    # parameter enumerates it for the log, which consumed 7 rows per call. Reading
    # one row and then passing the reader on kept 1 row in 8. Measured against SQL
    # Server: 125 of 1,000 rows.
    class FakeReaderEnumerator : System.Collections.IEnumerator {
        [object]$Reader; [object]$Current
        FakeReaderEnumerator([object]$r) { $this.Reader = $r }
        [bool]MoveNext() { $this.Current = $this.Reader; return $this.Reader.Read() }
        [void]Reset() { throw 'A data reader cannot be rewound' }
    }
    class FakeReader : System.Collections.IEnumerable {
        [string[]]$Columns; [object[]]$Rows; [int]$Pos = -1; [bool]$Disposed = $false; [int]$FieldCount
        [bool]$Sequential = $false; [int]$MinOrdinal = 0
        [int]$ReadDelayMs = 0   # a slow source, for the read-timing test
        FakeReader([string[]]$c, [object[]]$r) { $this.Columns = $c; $this.Rows = $r; $this.FieldCount = $c.Length }
        [string]GetName([int]$i) { return $this.Columns[$i] }
        [bool]Read() {
            if ($this.ReadDelayMs -gt 0) { [System.Threading.Thread]::Sleep($this.ReadDelayMs) }
            $this.Pos++; $this.MinOrdinal = 0; return $this.Pos -lt $this.Rows.Count
        }
        [object]GetValue([int]$i) {
            if ($this.Pos -lt 0 -or $this.Pos -ge $this.Rows.Count) { throw 'Invalid attempt to read when no data is present.' }
            if ($this.Sequential -and $i -lt $this.MinOrdinal) {
                throw "Invalid attempt to read from column ordinal '$i'.  With CommandBehavior.SequentialAccess, you may only read from column ordinal '$($this.MinOrdinal)' or greater."
            }
            if ($this.Sequential) { $this.MinOrdinal = $i + 1 }
            return $this.Rows[$this.Pos][$i]
        }
        [int]GetValues([object[]]$values) {
            $n = [Math]::Min($values.Length, $this.FieldCount)
            for ($i = 0; $i -lt $n; $i++) { $values[$i] = $this.GetValue($i) }
            return $n
        }
        [System.Collections.IEnumerator]GetEnumerator() { return [FakeReaderEnumerator]::new($this) }
        [void]Dispose() { $this.Disposed = $true }
    }
    # The TYPE is recorded, not just the value: @Since carries epoch milliseconds,
    # which overflow an Int 24 days after 1970, so binding it as anything but
    # BigInt is a failure that would only show against a real server.
    class FakeParam { [string]$Name; [object]$Value; [object]$Type; FakeParam([string]$n, [object]$t) { $this.Name = $n; $this.Type = $t } }
    class FakeParams {
        [System.Collections.Generic.List[object]]$Items = [System.Collections.Generic.List[object]]::new()
        [object]Add([string]$name, [object]$type) { $p = [FakeParam]::new($name, $type); $this.Items.Add($p); return $p }
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
        [int]$ReadDelayMs = 0    # handed to every reader it opens
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
            $r = [FakeReader]::new($this.Columns, $rows); $r.ReadDelayMs = $this.ReadDelayMs; $this.Readers.Add($r); return $r
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

Describe 'Test-SqlDeltaQuery' {
    It 'is true only when the statement binds @Since (any case, whole word)' {
        Test-SqlDeltaQuery -Sql 'SELECT 1 WHERE modified >= @Since' | Should -BeTrue
        Test-SqlDeltaQuery -Sql 'select 1 where modified >= @since' | Should -BeTrue
        Test-SqlDeltaQuery -Sql 'SELECT @SinceDays FROM t' | Should -BeFalse
        Test-SqlDeltaQuery -Sql 'SELECT 1' | Should -BeFalse
        Test-SqlDeltaQuery -Sql '' | Should -BeFalse
    }
}

# @Since and watermarkColumn are two halves of one thing. Either alone is a
# delta that does not work, and neither failure announces itself at run time:
# one reads the same window for ever, the other never narrows at all.
Describe 'Resolve-SqlQuerySlot — watermarks and the sweep' {
    It 'keeps a watermark column on a statement that binds @Since' {
        $s = Resolve-SqlQuerySlot -Slot @{ name = 'G'; target = 'assignments'; resourceType = 'Entitlement'
                                           sql = 'SELECT a, modified FROM g WHERE modified >= @Since'; watermarkColumn = ' modified ' }
        $s.watermarkColumn | Should -Be 'modified'
        $s.sweep | Should -BeFalse
    }

    It 'rejects each half without the other' {
        { Resolve-SqlQuerySlot -Slot @{ name = 'G'; target = 'resources'; resourceType = 'E'; sql = 'SELECT 1'; watermarkColumn = 'modified' } } |
            Should -Throw '*needs the statement to bind @Since*'
        { Resolve-SqlQuerySlot -Slot @{ name = 'G'; target = 'resources'; resourceType = 'E'; sql = 'SELECT 1 WHERE m >= @Since' } } |
            Should -Throw '*names no watermarkColumn*'
    }

    # A buffered target is sent whole, as one full sync: a window presented as the
    # complete set would delete every row the statement did not return.
    It 'refuses a watermark on a target that is sent as one full sync' {
        foreach ($t in @('systems', 'contexts', 'context-members')) {
            $slot = @{ name = 'C'; target = $t; sql = 'SELECT 1 WHERE m >= @Since'; watermarkColumn = 'modified'; contextType = 'Application' }
            { Resolve-SqlQuerySlot -Slot $slot } | Should -Throw "*cannot read a window*"
        }
    }

    It 'allows a sweep only on a windowed assignments statement' {
        $ok = Resolve-SqlQuerySlot -Slot @{ name = 'G'; target = 'assignments'; resourceType = 'Entitlement'
                                            sql = 'SELECT a, modified FROM g WHERE modified >= @Since'; watermarkColumn = 'modified'; sweep = $true }
        $ok.sweep | Should -BeTrue
        { Resolve-SqlQuerySlot -Slot @{ name = 'R'; target = 'resources'; resourceType = 'E'
                                        sql = 'SELECT a, modified FROM r WHERE modified >= @Since'; watermarkColumn = 'modified'; sweep = $true } } |
            Should -Throw '*only supported on an assignments query*'
        # Read in full already: the timestamp reconcile removes what is gone, so a
        # sweep would be a second complete read for nothing.
        { Resolve-SqlQuerySlot -Slot @{ name = 'G'; target = 'assignments'; resourceType = 'E'; sql = 'SELECT 1'; sweep = $true } } |
            Should -Throw '*bind @Since, or turn the sweep off*'
    }
}

Describe 'Get-SqlSweepShare' {
    It 'defaults to 5% and keeps a share inside (0, 1]' {
        Get-SqlSweepShare -Value $null -Override $false | Should -Be 0.05
        Get-SqlSweepShare -Value 0.2 -Override $false | Should -Be 0.2
        Get-SqlSweepShare -Value 1 -Override $false | Should -Be 1
    }

    It 'falls back to the default for anything that is not a share' {
        # 5 would mean 500%, i.e. no guard at all — the one outcome the setting exists to avoid.
        foreach ($v in @(0, -0.1, 5, 'half', '')) { Get-SqlSweepShare -Value $v -Override $false | Should -Be 0.05 }
    }

    It 'reads a decimal the invariant way, so a comma locale cannot turn 0.05 into 5' {
        $prev = [System.Threading.Thread]::CurrentThread.CurrentCulture
        try {
            [System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::new('nl-NL')
            Get-SqlSweepShare -Value '0.05' -Override $false | Should -Be 0.05
        } finally { [System.Threading.Thread]::CurrentThread.CurrentCulture = $prev }
    }

    It 'an explicit override removes the ceiling entirely' {
        Get-SqlSweepShare -Value 0.05 -Override $true | Should -Be 1
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
        # The delta defaults: 15 minutes of overlap (clock drift plus the longest
        # write transaction), a nightly sweep, and a 5% ceiling on what it removes.
        $cfg.watermarkOverlapSeconds | Should -Be 900
        $cfg.sweepIntervalHours | Should -Be 24
        $cfg.sweepMaxDeleteShare | Should -Be 0.05
    }

    It 'honours the delta settings, and sweepOverride lifts the ceiling for one run' {
        $c = Merge-Cfg -Base $script:BaseCfg -Over @{ watermarkOverlapSeconds = 0; sweepIntervalHours = 0; sweepMaxDeleteShare = 0.5 }
        $cfg = Resolve-SqlConfig -ConfigPath (New-ConfigFile -Cfg $c)
        $cfg.watermarkOverlapSeconds | Should -Be 0     # 0 is a legitimate choice, not "unset"
        $cfg.sweepIntervalHours | Should -Be 0          # sweeping off
        $cfg.sweepMaxDeleteShare | Should -Be 0.5
        $over = Resolve-SqlConfig -ConfigPath (New-ConfigFile -Cfg (Merge-Cfg -Base $script:BaseCfg -Over @{ sweepMaxDeleteShare = 0.05; sweepOverride = $true }))
        $over.sweepMaxDeleteShare | Should -Be 1
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

Describe 'ConvertTo-SqlRow' {
    It 'produces an ordered hashtable in column order with converted cells' {
        $when = [datetime]::new(2026, 1, 2, 3, 4, 5, [DateTimeKind]::Utc)
        $row = ConvertTo-SqlRow -Values @('a1', [System.DBNull]::Value, [byte[]](1), 7, $when) -Columns @('id', 'gone', 'blob', 'n', 'when')
        @($row.Keys) | Should -Be @('id', 'gone', 'blob', 'n', 'when')
        $row.id | Should -Be 'a1'
        $row.gone | Should -BeNull
        $row.blob | Should -BeNull
        $row.n | Should -Be 7
        $row.when | Should -Be '2026-01-02T03:04:05.0000000Z'
    }
}

Describe 'Invoke-SqlQueryStream' {
    BeforeAll {
        $script:Rows = @(1..7 | ForEach-Object { , @("r$_", $_) })
    }

    # 29 rows, not a multiple of 8: the old code then threw on the last row instead
    # of silently returning an eighth, so both failure shapes fail this test.
    It 'keeps every row while a transcript is running, as it is in the worker' {
        $rows = @(1..29 | ForEach-Object { , @("r$_", $_) })
        $conn = [FakeConnection]::new(@('id', 'n'), $rows)
        $seen = [System.Collections.Generic.List[string]]::new()
        Start-Transcript -Path (Join-Path $TestDrive 'job.log') -UseMinimalHeader | Out-Null
        try {
            $n = Invoke-SqlQueryStream -Connection $conn -Sql 'SELECT id, n FROM t' -OnRow { param($Row) $seen.Add($Row.id) }
        } finally { Stop-Transcript | Out-Null }
        $n | Should -Be 29
        @($seen) | Should -Be @(1..29 | ForEach-Object { "r$_" })
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

    It 'binds @Since as a BIGINT, and only when the caller gave one' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        Invoke-SqlQueryStream -Connection $conn -Sql 'SELECT id, n FROM t WHERE n >= @Since' -OnRow { } -Since ([long]1758700000000) | Out-Null
        $p = $conn.ReadCommands[0].Parameters.Get('@Since')
        $p | Should -Not -BeNullOrEmpty
        # Epoch milliseconds are ~1.7e12: an Int parameter overflows and the
        # statement would either fail or read from a meaningless mark.
        $p.Type | Should -Be ([System.Data.SqlDbType]::BigInt)
        [long]$p.Value | Should -Be 1758700000000

        $plain = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        Invoke-SqlQueryStream -Connection $plain -Sql 'SELECT id, n FROM t' -OnRow { } | Out-Null
        $plain.ReadCommands[0].Parameters.Get('@Since') | Should -BeNullOrEmpty
    }

    It 'binds a zero @Since — the beginning of time, not "no window"' {
        # A first run, an edited statement and a forced full sync all read
        # everything, and they do it by binding 0, not by dropping the parameter
        # the statement references (which would be a syntax error).
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        Invoke-SqlQueryStream -Connection $conn -Sql 'SELECT id, n FROM t WHERE n >= @Since' -OnRow { } -Since ([long]0) | Out-Null
        [long]$conn.ReadCommands[0].Parameters.Get('@Since').Value | Should -Be 0
    }

    It 'binds @Since on EVERY page of a paged statement, not only the first' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        Invoke-SqlQueryStream -Connection $conn -Sql 'SELECT id FROM t WHERE n >= @Since ORDER BY n OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY' `
            -OnRow { } -Paged $true -PageSize 3 -Since ([long]99) | Out-Null
        $conn.ReadCommands.Count | Should -Be 3
        foreach ($c in $conn.ReadCommands) { [long]$c.Parameters.Get('@Since').Value | Should -Be 99 }
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

    # The split the job log reports: time waiting on the SOURCE, apart from what
    # the crawler then does with each row. Six Read() calls at 50 ms (five rows and
    # the one that finds no more) are ~0.3 s; five callbacks at 100 ms are 0.5 s.
    # Timing the callback as well would put the figure at 0.8 s or more.
    It 'adds the time spent in the reader to -Timing, and not the time spent in the callback' {
        $conn = [FakeConnection]::new(@('id', 'n'), @($script:Rows | Select-Object -First 5))
        $conn.ReadDelayMs = 50
        $t = @{ ReadTicks = [long]0 }
        Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { Start-Sleep -Milliseconds 100 } -Timing $t | Should -Be 5
        $sec = $t.ReadTicks / [System.Diagnostics.Stopwatch]::Frequency
        $sec | Should -BeGreaterOrEqual 0.28
        $sec | Should -BeLessThan 0.7
    }

    It 'accumulates over the pages of a paged statement' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        $conn.ReadDelayMs = 20
        $t = @{ ReadTicks = [long]0 }
        # 3 pages: 3+1, 3+1 and 1+1 Read() calls = 10 x 20 ms.
        Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { } -Paged $true -PageSize 3 -Timing $t | Should -Be 7
        ($t.ReadTicks / [System.Diagnostics.Stopwatch]::Frequency) | Should -BeGreaterOrEqual 0.19
    }

    It 'disposes the reader and command when the callback throws, and propagates the error' {
        $conn = [FakeConnection]::new(@('id', 'n'), $script:Rows)
        { Invoke-SqlQueryStream -Connection $conn -Sql 'x' -OnRow { throw 'boom' } } | Should -Throw 'boom'
        $conn.Readers[0].Disposed | Should -BeTrue
        $conn.Commands[0].Disposed | Should -BeTrue
    }
}
