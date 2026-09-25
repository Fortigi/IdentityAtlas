<#
.SYNOPSIS
    Helpers for the SQL Database crawler: config resolution, the connection
    string, and the streaming query runner.

.DESCRIPTION
    Dot-sourced into Start-SqlCrawler.ps1's scope. The SQL boundary is
    System.Data.SqlClient, which ships inside PowerShell 7 on every platform the
    worker runs on (no module to install). Every function that touches the server
    takes the connection as a parameter, so the phases can be unit-tested by
    mocking Invoke-SqlQueryStream and the connection-string builder can be tested
    without a server at all.

    The password is never printed: Get-SqlConnectionSummary is the only thing
    that reaches a log line.
#>

#region Configuration

$script:SqlTargets       = @('identities', 'principals', 'identity-members', 'resources', 'assignments', 'relationships')
$script:SqlAssignTypes   = @('Direct', 'Indirect', 'Eligible')
$script:SqlRelTypes      = @('Contains', 'GrantsAccessTo')
$script:SqlPrincipalTypes = @('User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox')

# A statement pages when it binds @Offset (the crawler then also binds @PageSize).
function Test-SqlPagedQuery {
    [CmdletBinding()]
    [OutputType([bool])]
    param([AllowEmptyString()] [string]$Sql)
    return [bool]($Sql -match '@Offset\b')
}

# An operator's `columnMap` (source column → contract column) as a plain
# hashtable, however the JSON arrived (hashtable under -AsHashtable, PSCustomObject
# otherwise). Blank entries are dropped; a non-string target is an error rather
# than a silently ignored mapping.
function ConvertTo-SqlColumnMapTable {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param($Value, [string]$QueryName = 'query')
    $out = @{}
    if ($null -eq $Value) { return $out }
    $pairs = if ($Value -is [System.Collections.IDictionary]) {
        $Value.GetEnumerator() | ForEach-Object { @{ k = [string]$_.Key; v = $_.Value } }
    } else {
        $Value.PSObject.Properties | ForEach-Object { @{ k = [string]$_.Name; v = $_.Value } }
    }
    foreach ($p in $pairs) {
        $from = ([string]$p.k).Trim()
        if (-not $from) { continue }
        if ($p.v -isnot [string]) { throw "Query '$QueryName': columnMap entry '$from' must map to a column name" }
        $to = ([string]$p.v).Trim()
        if ($to) { $out[$from] = $to }
    }
    return $out
}

# One of a slot's fixed-vocabulary fields: the configured value, or the default
# when absent. A value off the list is an operator error worth naming, not a
# silent fallback — it would otherwise become the reconcile scope of the wrong
# partition.
function Get-SqlSlotEnum {
    [CmdletBinding()]
    [OutputType([string])]
    param($Value, [string]$Default, [string[]]$Allowed, [string]$Field, [string]$QueryName)
    $v = if ($Value) { [string]$Value } else { $Default }
    if ($v -notin $Allowed) { throw "Query '$QueryName': $Field '$v' is not one of $($Allowed -join ', ')" }
    return $v
}

# One configured statement → the normalised slot the phases run. Throws an
# operator-readable error for anything the manifest schema cannot express (a
# resources/assignments slot without a resourceType, an enum value off the list).
function Resolve-SqlQuerySlot {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Slot, [int]$Index = 0)
    $name   = if ($Slot.name) { [string]$Slot.name } else { "query $($Index + 1)" }
    $target = ([string]$Slot.target).Trim().ToLowerInvariant()
    if ($target -notin $script:SqlTargets) { throw "Query '$name': target '$($Slot.target)' is not one of $($script:SqlTargets -join ', ')" }
    $sql = [string]$Slot.sql
    if (-not $sql.Trim()) { throw "Query '$name': the SQL statement is empty" }
    $resourceType = ([string]$Slot.resourceType).Trim()
    if ($target -in @('resources', 'assignments') -and -not $resourceType) { throw "Query '$name': a $target query needs a resourceType" }
    $assignmentType   = Get-SqlSlotEnum -Value $Slot.assignmentType   -Default 'Direct'   -Allowed $script:SqlAssignTypes    -Field 'assignmentType'   -QueryName $name
    $relationshipType = Get-SqlSlotEnum -Value $Slot.relationshipType -Default 'Contains' -Allowed $script:SqlRelTypes       -Field 'relationshipType' -QueryName $name
    $principalType    = Get-SqlSlotEnum -Value $Slot.principalType    -Default 'User'     -Allowed $script:SqlPrincipalTypes -Field 'principalType'    -QueryName $name
    return @{
        name             = $name
        target           = $target
        sql              = $sql
        columnMap        = (ConvertTo-SqlColumnMapTable -Value $Slot.columnMap -QueryName $name)
        enabled          = -not ($null -ne $Slot.enabled -and -not [bool]$Slot.enabled)
        resourceType     = $resourceType
        assignmentType   = $assignmentType
        governed         = [bool]$Slot.governed
        relationshipType = $relationshipType
        principalType    = $principalType
        paged            = Test-SqlPagedQuery -Sql $sql
    }
}

# A positive integer from the config, or the default when absent/invalid.
function Get-SqlConfigInt {
    [CmdletBinding()]
    [OutputType([int])]
    param($Value, [int]$Default, [int]$Minimum = 1)
    $n = 0
    if ($null -ne $Value -and [int]::TryParse([string]$Value, [ref]$n) -and $n -ge $Minimum) { return $n }
    return $Default
}

function Resolve-SqlConfig {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$ConfigPath)
    $raw = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
    foreach ($k in @('server', 'database', 'username', 'password')) {
        if (-not [string]$raw[$k]) { throw "SQL crawler config is missing '$k'" }
    }
    $slots = [System.Collections.Generic.List[hashtable]]::new()
    $i = 0
    foreach ($q in @($raw['queries'])) { if ($q) { $slots.Add((Resolve-SqlQuerySlot -Slot $q -Index $i)) }; $i++ }
    if ($slots.Count -eq 0) { throw 'SQL crawler config has no queries' }
    return @{
        server                 = ([string]$raw['server']).Trim()
        port                   = Get-SqlConfigInt -Value $raw['port'] -Default 0
        database               = ([string]$raw['database']).Trim()
        username               = [string]$raw['username']
        password               = [string]$raw['password']
        encrypt                = -not ($null -ne $raw['encrypt'] -and -not [bool]$raw['encrypt'])
        trustServerCertificate = [bool]$raw['trustServerCertificate']
        connectTimeout         = Get-SqlConfigInt -Value $raw['connectTimeoutSeconds'] -Default 30
        commandTimeout         = Get-SqlConfigInt -Value $raw['commandTimeoutSeconds'] -Default 600 -Minimum 0
        batchSize              = Get-SqlConfigInt -Value $raw['batchSize'] -Default 5000 -Minimum 100
        pageSize               = Get-SqlConfigInt -Value $raw['pageSize'] -Default 10000 -Minimum 100
        systemName             = [string]$raw['systemName']
        configName             = [string]$raw['_configName']
        syncMode               = if ($raw['_syncMode'] -eq 'delta') { 'delta' } else { 'full' }
        queries                = @($slots)
    }
}

#endregion Configuration

#region Connection

function Get-SqlConnectionString {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Cfg)
    # Indexer + canonical keywords: PowerShell resolves `$b.DataSource = …` through
    # the builder's dictionary interface, and that path only knows the keyword
    # spelling ("Data Source"), not the property name.
    $b = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
    $b['Data Source']              = if ($Cfg.port -gt 0) { "$($Cfg.server),$($Cfg.port)" } else { $Cfg.server }
    $b['Initial Catalog']          = $Cfg.database
    $b['User ID']                  = $Cfg.username
    $b['Password']                 = $Cfg.password
    $b['Encrypt']                  = [bool]$Cfg.encrypt
    $b['TrustServerCertificate']   = [bool]$Cfg.trustServerCertificate
    $b['Connect Timeout']          = [int]$Cfg.connectTimeout
    $b['Application Name']         = 'Identity Atlas SQL crawler'
    $b['MultipleActiveResultSets'] = $false
    return $b.ConnectionString
}

# What the log may say about the connection — never the password.
function Get-SqlConnectionSummary {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Cfg)
    $ds = if ($Cfg.port -gt 0) { "$($Cfg.server),$($Cfg.port)" } else { $Cfg.server }
    $tls = if ($Cfg.encrypt) { if ($Cfg.trustServerCertificate) { 'encrypted, server certificate trusted' } else { 'encrypted' } } else { 'not encrypted' }
    return "$ds / $($Cfg.database) as $($Cfg.username) ($tls)"
}

function Connect-SqlSource {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Cfg)
    Write-Host "Connecting to $(Get-SqlConnectionSummary -Cfg $Cfg)..." -ForegroundColor Cyan
    $conn = [System.Data.SqlClient.SqlConnection]::new((Get-SqlConnectionString -Cfg $Cfg))
    try { $conn.Open() }
    catch { throw "Could not connect to SQL Server $($Cfg.server): $($_.Exception.GetBaseException().Message)" }
    Write-Host "Connected (SQL Server $($conn.ServerVersion))" -ForegroundColor Green
    return $conn
}

#endregion Connection

#region Query streaming

# One cell → a JSON-friendly value. NULL → $null; dates → ISO-8601; GUIDs →
# string; binary → $null (JSON has no binary and a photo does not belong in
# extendedAttributes). Everything else (string, number, bool) passes through.
function ConvertFrom-SqlValue {
    [CmdletBinding()]
    param($Value)
    if ($null -eq $Value -or $Value -is [System.DBNull]) { return $null }
    if ($Value -is [datetime])       { return $Value.ToString('o') }
    if ($Value -is [System.DateTimeOffset]) { return $Value.ToString('o') }
    if ($Value -is [guid])           { return $Value.ToString() }
    if ($Value -is [byte[]])         { return $null }
    if ($Value -is [timespan])       { return $Value.ToString() }
    return $Value
}

function Get-SqlReaderColumns {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] $Reader)
    $cols = [string[]]::new($Reader.FieldCount)
    for ($i = 0; $i -lt $Reader.FieldCount; $i++) { $cols[$i] = $Reader.GetName($i) }
    return , $cols
}

# The current reader row as an ordered hashtable (column name → converted value).
# Strings and numbers skip the converter call: on a 40 M-row read the per-cell
# function call is the dominant cost, and those types need no conversion.
function Read-SqlRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Reader, [Parameter(Mandatory)] [string[]]$Columns)
    $row = [ordered]@{}
    for ($i = 0; $i -lt $Columns.Length; $i++) {
        $v = $Reader.GetValue($i)
        if ($v -is [string] -or $v -is [int] -or $v -is [long] -or $v -is [bool]) { $row[$Columns[$i]] = $v }
        else { $row[$Columns[$i]] = ConvertFrom-SqlValue -Value $v }
    }
    return $row
}

function New-SqlCommand {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Connection, [Parameter(Mandatory)] [string]$Sql, [int]$CommandTimeout = 600, [bool]$Paged = $false, [int]$Offset = 0, [int]$PageSize = 10000)
    $cmd = $Connection.CreateCommand()
    $cmd.CommandText    = $Sql
    $cmd.CommandTimeout = $CommandTimeout
    if ($Paged) {
        $pOffset = $cmd.Parameters.Add('@Offset', [System.Data.SqlDbType]::Int)
        $pOffset.Value = $Offset
        $pSize = $cmd.Parameters.Add('@PageSize', [System.Data.SqlDbType]::Int)
        $pSize.Value = $PageSize
    }
    return $cmd
}

# A result set that ends because the CONNECTION went away is indistinguishable
# from one that ends because the rows ran out: Read() returns $false in both
# cases, with no error. So a proxy, gateway or firewall that closes a TLS session
# mid-stream truncates the crawl SILENTLY — the job ingests part of the source and
# reports success, which is worse than failing.
#
# Observed in the field: a 176,703-row table returned 22,087 rows in 59 seconds
# and the run was reported as complete. The crawler holds one result set open for
# the whole statement while stopping every batch to POST into the API, so that
# connection sits idle mid-stream for seconds at a time — exactly what an idle-
# session timeout kills.
#
# After the rows stop, ask the connection to do one more trivial thing. A dead
# connection cannot, and that turns silent data loss into a failed job naming the
# fix. It is a best-effort check rather than a proof: SqlClient's own connection
# resiliency can transparently re-establish an idle connection, in which case the
# probe succeeds even though rows were lost. Paging is the actual cure, because
# each page is then a short-lived query with nothing held open across an ingest.
function Assert-SqlReadCompleted {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Connection, [int]$RowsRead, [bool]$Paged = $false)
    try {
        $probe = $Connection.CreateCommand()
        try {
            $probe.CommandText = 'SELECT 1'
            $probe.CommandTimeout = 30
            [void]$probe.ExecuteScalar()
        }
        finally { $probe.Dispose() }
    }
    catch {
        $hint = if ($Paged) { 'The statement is already paged, so re-running resumes from the start of the failed page.' }
                else { 'Add an ORDER BY and OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY to the statement: the crawler then reads it one short-lived page at a time instead of holding a single result set open for the whole table.' }
        throw ("The SQL connection did not survive the read: $($RowsRead.ToString('N0')) row(s) arrived before it dropped, so the result set was cut short rather than finished. " +
               "Treating that as a complete read would silently ingest part of the source. $hint Underlying error: $($_.Exception.GetBaseException().Message)")
    }
}

# Run one page (or the whole statement) and hand every row to -OnRow. Returns the
# number of rows read.
function Invoke-SqlReaderPage {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] $Command, [Parameter(Mandatory)] [scriptblock]$OnRow)
    # Default, NOT SequentialAccess. SequentialAccess looks like the right choice
    # for a streaming reader, but it forbids revisiting a column once the row has
    # moved past it — and that includes going back to ordinal 0 for the NEXT row's
    # first column, which fails as soon as a statement returns more columns than
    # the crawler happens to read in step:
    #   "Invalid attempt to read from column ordinal '0'. With
    #    CommandBehavior.SequentialAccess, you may only read from column ordinal
    #    '26' or greater."
    # It buys nothing here either: its purpose is to stream large BLOBs without
    # buffering, and this crawler skips binary columns outright. Default buffers
    # one row at a time, which is what the shapers need and costs nothing at any
    # row count.
    $reader = $Command.ExecuteReader([System.Data.CommandBehavior]::Default)
    $n = 0
    try {
        $columns = Get-SqlReaderColumns -Reader $reader
        while ($reader.Read()) {
            & $OnRow (Read-SqlRow -Reader $reader -Columns $columns)
            $n++
        }
    } finally { $reader.Dispose() }
    # The reader is closed before probing, so the probe reuses the connection
    # rather than competing with an open result set for it.
    Assert-SqlReadCompleted -Connection $Command.Connection -RowsRead $n -Paged $Paged
    return $n
}

# Stream a statement's rows through -OnRow without ever holding the result set.
# A paged statement (binds @Offset) is re-run with a growing offset until a page
# comes back short; a plain statement runs once, forward-only, to the end.
function Invoke-SqlQueryStream {
    [CmdletBinding()]
    [OutputType([long])]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)] [string]$Sql,
        [Parameter(Mandatory)] [scriptblock]$OnRow,
        [int]$CommandTimeout = 600,
        [bool]$Paged = $false,
        [int]$PageSize = 10000
    )
    [long]$total = 0
    $offset = 0
    do {
        $cmd = New-SqlCommand -Connection $Connection -Sql $Sql -CommandTimeout $CommandTimeout -Paged $Paged -Offset $offset -PageSize $PageSize
        try { $n = Invoke-SqlReaderPage -Command $cmd -OnRow $OnRow }
        finally { $cmd.Dispose() }
        $total += $n
        $offset += $PageSize
        if ($Paged) { Write-Host "    page done: $($n.ToString('N0')) rows (offset now $($offset.ToString('N0')))" -ForegroundColor DarkGray }
    } while ($Paged -and $n -eq $PageSize)
    return $total
}

#endregion Query streaming
