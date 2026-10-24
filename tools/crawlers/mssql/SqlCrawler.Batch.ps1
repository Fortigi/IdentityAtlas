<#
.SYNOPSIS
    The assignments hot path: shape a whole batch of source rows per call.

.DESCRIPTION
    Dot-sourced after SqlCrawler.Phases.ps1. An IdentityIQ source holds tens of
    millions of entitlement grants and a few hundred thousand of everything else,
    so the assignments target is where a full load spends its time.

    The per-row path (Add-SqlStreamedRow → Add-SqlAssignmentRow) makes ten or so
    PowerShell function calls per row — ConvertTo-SqlRow, the watermark, the
    shaper, the extended attributes, the routing, the stream lookup, the buffer —
    and a PowerShell function call costs tens of microseconds. Measured on the 10%
    IdentityIQ fixture: reading a grant from SQL Server takes 1.6 µs and turning
    it into JSON 4.5 µs, while shaping it took ~190 µs. That was the whole run.

    This file does the same work with the calls taken out of the per-row loop:
    the reader hands over 5,000 raw rows at a time (Invoke-SqlReaderPage
    -OnBatch), each function below makes ONE pass over the batch, and every
    system's records join its stream in one Add-CrawlerIngestStreamRecords call.

    THE LOOPS USE OPERATORS, NOT METHODS. Measured in PowerShell 7 per call: a
    method on a generic collection (Dictionary.ContainsKey, List.Add,
    HashSet.Contains) ~10 µs, Dictionary.TryGetValue or [long]::TryParse with a
    [ref] 15-24 µs — while an indexer ($dict[$key], $array[$i] = …), a cast or
    an -is test is well under 1 µs. So a lookup is an indexer that returns $null
    for a missing key, arrays are filled by index, and a parse is a cast guarded
    by a pattern. Every method call left in a loop below is there because it is
    the only exact way to reproduce what the per-row path does (String.Trim).

    It produces exactly the records the per-row path does — same fields, same
    order, same conversions, same skipped / dangling / misrouted counts, same
    watermark — and the streams chunk them at the same boundaries, so the API
    receives the same requests. test/unit/SqlCrawlerBatch.Tests.ps1 holds the two
    paths against each other on the same rows.
#>

#region Plan

# The column positions a batch is read by, resolved once per statement from the
# result set's column names. The per-row path keys a row by name in a
# case-insensitive ordered dictionary, so a name that appears twice keeps its
# FIRST spelling and its LAST value — the positions here follow the same rule.
function Get-SqlBatchPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string[]]$Columns, [Parameter(Mandatory)] [hashtable]$Ctx)
    $ordinal = @{}
    $names = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $Columns.Length; $i++) {
        if (-not $ordinal.ContainsKey($Columns[$i])) { $names.Add($Columns[$i]) }
        $ordinal[$Columns[$i]] = $i
    }
    $overrides = if ($Ctx.Slot.columnMap) { $Ctx.Slot.columnMap } else { @{} }
    $map = Resolve-SqlColumnMap -Columns $names.ToArray() -Target $Ctx.Slot.target -ColumnMap $overrides -WatermarkColumn $Ctx.Slot.watermarkColumn
    $Ctx.Map = $map
    $Ctx.Route = Get-SqlRouteMode -Map $map -Target $Ctx.Slot.target -Routing (Test-SqlSystemRouting -Catalog $Ctx.State.Systems)
    if ($Ctx.Delta) { Resolve-SqlWatermarkColumn -Delta $Ctx.Delta -Columns $names.ToArray() }
    $principal = if ($map.principalId) { $map.principalId } else { $map.identityId }
    return @{
        Resource  = Get-SqlBatchOrdinal -Ordinal $ordinal -Name $map.resourceId
        Principal = Get-SqlBatchOrdinal -Ordinal $ordinal -Name $principal
        Watermark = Get-SqlBatchOrdinal -Ordinal $ordinal -Name $(if ($Ctx.Delta) { $Ctx.Delta.ColumnKey })
        ExtNames  = [string[]]@($map._extended)
        ExtIndex  = [int[]]@($map._extended | ForEach-Object { $ordinal[$_] })
        # Only a statement that routes by its own columns needs them per row:
        # source column name → position.
        RouteCols = Get-SqlBatchRouteColumns -Map $map -Ordinal $ordinal
    }
}

function Get-SqlBatchRouteColumns {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [hashtable]$Ordinal)
    $cols = @{}
    foreach ($n in @('systemId', 'systemName')) {
        if ($Map.ContainsKey($n)) { $cols[$Map[$n]] = Get-SqlBatchOrdinal -Ordinal $Ordinal -Name $Map[$n] }
    }
    return $cols
}

function Get-SqlBatchOrdinal {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$Ordinal, [AllowNull()] [AllowEmptyString()] [string]$Name)
    if ($Name -and $Ordinal.ContainsKey($Name)) { return [int]$Ordinal[$Name] }
    return -1
}

#endregion Plan

#region One pass per concern

# One raw cell → the value the per-row path stores for it (ConvertTo-SqlRow):
# strings, integers, booleans and decimals as they are, NULL as $null, anything
# else through ConvertFrom-SqlValue. Callers inline the common cases and come
# here only for the rest.
function ConvertFrom-SqlBatchCell {
    [CmdletBinding()]
    param($Value)
    if ($Value -is [System.DBNull]) { return $null }
    return ConvertFrom-SqlValue -Value $Value
}

# One column of every row as text, as the per-row path reads it ([string] of the
# converted cell), with $null for a NULL cell. An object[], not a string[]:
# PowerShell stores $null into a string[] element as '', and the watermark must
# tell a NULL (ignored) from an empty string (not a number).
function Get-SqlBatchText {
    [CmdletBinding()]
    [OutputType([object[]])]
    param([Parameter(Mandatory)] [object[]]$Rows, [int]$Ordinal = -1)
    $text = [object[]]::new($Rows.Length)
    if ($Ordinal -lt 0) { return , $text }
    $i = 0
    foreach ($r in $Rows) {
        $v = $r[$Ordinal]
        $text[$i++] = if ($v -is [string]) { $v }
                      elseif ($null -eq $v -or $v -is [System.DBNull]) { $null }
                      elseif ($v -is [int] -or $v -is [long] -or $v -is [decimal]) { [string]$v }
                      else { [string](ConvertFrom-SqlValue -Value $v) }
    }
    return , $text
}

# The trimmed string key in one column of every row ('' when the statement has no
# such column, or the cell is NULL) — what `([string]$Row[$col]).Trim()` gives on
# the per-row path.
function Get-SqlBatchKeys {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [object[]]$Rows, [int]$Ordinal = -1)
    $keys = [string[]]::new($Rows.Length)
    $i = 0
    foreach ($s in (Get-SqlBatchText -Rows $Rows -Ordinal $Ordinal)) {
        $keys[$i++] = if ($null -eq $s) { '' } else { $s.Trim() }
    }
    return , $keys
}
# The extendedAttributes of every row, or $null for the whole batch when the
# statement returns no column outside the contract. The conversion is
# ConvertFrom-SqlValue's, inlined for the types a source actually returns —
# NULL above all, which is most cells of a sparse attribute — so that a function
# call is only paid for the rare ones (a GUID, a timespan, binary).
function Get-SqlBatchExtended {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [object[]]$Rows, [Parameter(Mandatory)] [hashtable]$Plan)
    if ($Plan.ExtIndex.Length -eq 0) { return $null }
    $out = [object[]]::new($Rows.Length)
    $names = $Plan.ExtNames; $index = $Plan.ExtIndex; $w = $index.Length
    $i = 0
    foreach ($r in $Rows) {
        $ext = @{}
        for ($k = 0; $k -lt $w; $k++) {
            $v = $r[$index[$k]]
            if ($v -is [System.DBNull]) { $v = $null }
            elseif ($v -is [string] -or $v -is [int] -or $v -is [long] -or $v -is [decimal] -or $v -is [bool]) { }
            elseif ($v -is [datetime] -or $v -is [System.DateTimeOffset]) { $v = $v.ToString('o') }
            else { $v = ConvertFrom-SqlValue -Value $v }
            $ext[$names[$k]] = $v
        }
        $out[$i++] = $ext
    }
    return , $out
}

# The watermark's high mark over the batch — Update-SqlWatermark's rule, once
# per batch: every row counts towards Rows, a NULL is ignored, and the first
# value that is not a whole number makes the column unusable for the run.
#
# The rule is [long]::TryParse of the value as text, which costs ~15 µs a call.
# A plain run of up to 18 ASCII digits cannot fail that parse or overflow a
# cast, so it takes the cast; anything else — a sign, spaces, a fraction, 19
# digits — goes through TryParse itself, so the verdict is always TryParse's.
function Update-SqlBatchWatermark {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [object[]]$Rows, [Parameter(Mandatory)] [hashtable]$Plan, [AllowNull()] [hashtable]$Delta)
    if (-not $Delta) { return }
    $Delta.Rows += $Rows.Length
    if ($Delta.Unusable -or $Plan.Watermark -lt 0) { return }
    $max = $Delta.Max
    $n = [long]0
    foreach ($s in (Get-SqlBatchText -Rows $Rows -Ordinal $Plan.Watermark)) {
        if ($null -eq $s) { continue }
        if ($s -match '^[0-9]{1,18}$') { $n = [long]$s }
        elseif (-not [long]::TryParse($s, [ref]$n)) {
            $Delta.Max = $max
            $Delta.Unusable = "the watermark column '$($Delta.Column)' returned '$s', which is not epoch milliseconds"
            return
        }
        if ($n -gt $max) { $max = $n }
    }
    $Delta.Max = $max
}

# The system each row is addressed to, when a statement routes by its OWN
# columns — the one routing mode that needs row values. Goes through the per-row
# resolver, which also keeps the misrouted count; a statement routing this way
# is rare on this target (assignments follow their resource by default).
function Get-SqlBatchRowSystem {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [object[]]$Row, [Parameter(Mandatory)] [hashtable]$Ctx, [Parameter(Mandatory)] [hashtable]$Plan)
    $cells = @{}
    foreach ($e in $Plan.RouteCols.GetEnumerator()) { $cells[$e.Key] = ConvertFrom-SqlBatchCell $Row[$e.Value] }
    return Get-SqlRowSystemId -Ctx $Ctx -Row $cells
}

#endregion One pass per concern

#region The batch

# Shape one batch of an assignments statement and hand each system's records to
# its stream. The counters and the order are the per-row path's: a row missing
# either key is skipped, one naming an id this run did not load is dangling, and
# an assignment follows its resource's system unless the statement names one.
function Add-SqlAssignmentBatch {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string[]]$Columns, [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]]$Rows, [Parameter(Mandatory)] [hashtable]$Ctx)
    if ($Rows.Length -eq 0) { return }
    if (-not $Ctx.Plan) { $Ctx.Plan = Get-SqlBatchPlan -Columns $Columns -Ctx $Ctx }
    $plan = $Ctx.Plan
    Update-SqlBatchWatermark -Rows $Rows -Plan $plan -Delta $Ctx.Delta
    $res = Get-SqlBatchKeys -Rows $Rows -Ordinal $plan.Resource
    $pri = Get-SqlBatchKeys -Rows $Rows -Ordinal $plan.Principal
    $ext = Get-SqlBatchExtended -Rows $Rows -Plan $plan
    $shaped = ConvertTo-SqlAssignmentBatch -Rows $Rows -Resources $res -Principals $pri -Extended $ext -Ctx $Ctx
    $split = Split-SqlBatchBySystem -Records $shaped.Records -Systems $shaped.Systems -Count $shaped.Count
    foreach ($sid in $split.Order) {
        Add-CrawlerIngestStreamRecords -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'assignment' -SystemId $sid) -Records $split.Arrays[$sid]
    }
    Step-SqlBatchProgress -Ctx $Ctx -Count $Rows.Length
}

# One batch's records, in row order, each with the system it is addressed to.
# Returns Records / Systems (parallel arrays) and Count, the slots filled.
function ConvertTo-SqlAssignmentBatch {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [object[]]$Rows, [string[]]$Resources, [string[]]$Principals, [AllowNull()] [object[]]$Extended, [Parameter(Mandatory)] [hashtable]$Ctx)
    $st = $Ctx.State; $slot = $Ctx.Slot
    # Indexers, not ContainsKey/TryGetValue: a missing key reads as $null. The
    # values are system ids, never $null themselves.
    $known = $st.KnownResources; $people = $st.KnownPrincipals
    $checkRes = [bool]$st.HasResources; $checkPri = [bool]$st.HasPrincipals
    $byResource = $Ctx.Route -eq 'resource'; $byColumn = $Ctx.Route -eq 'column'; $own = $st.SystemId
    $type = $slot.assignmentType; $rtype = $slot.resourceType; $gov = [bool]$slot.governed
    $n = $Resources.Length
    $recs = [object[]]::new($n); $sids = [int[]]::new($n)
    $m = 0; $skipped = 0; $dangling = 0
    for ($i = 0; $i -lt $n; $i++) {
        $r = $Resources[$i]; $p = $Principals[$i]
        if (-not $r -or -not $p) { $skipped++; continue }
        if (($checkRes -and $null -eq $known[$r]) -or ($checkPri -and $null -eq $people[$p])) { $dangling++; continue }
        $rec = [ordered]@{ resourceExternalId = $r; principalExternalId = $p; assignmentType = $type; resourceType = $rtype; governed = $gov }
        if ($null -ne $Extended) { $rec['extendedAttributes'] = $Extended[$i] }
        $sid = $own
        if ($byColumn) { $sid = Get-SqlBatchRowSystem -Row $Rows[$i] -Ctx $Ctx -Plan $Ctx.Plan }
        elseif ($byResource -and $null -ne $known[$r]) { $sid = $known[$r] }
        $recs[$m] = $rec; $sids[$m] = $sid; $m++
    }
    $Ctx.Skipped += $skipped; $Ctx.Dangling += $dangling
    return @{ Records = $recs; Systems = $sids; Count = $m }
}

# Records grouped by system: Order lists the systems in the order they first
# appear, Arrays holds each system's records in row order. Counted first, then
# filled by index, so no collection's Add is called per record.
function Split-SqlBatchBySystem {
    [CmdletBinding()]
    param([object[]]$Records = @(), [int[]]$Systems = @(), [int]$Count = 0)
    $counts = @{}
    $order = [System.Collections.ArrayList]::new()
    for ($i = 0; $i -lt $Count; $i++) {
        $s = $Systems[$i]
        $c = $counts[$s]
        if ($null -eq $c) { [void]$order.Add($s); $counts[$s] = 1 } else { $counts[$s] = $c + 1 }
    }
    $arrays = @{}; $pos = @{}
    foreach ($s in $order) { $arrays[$s] = [object[]]::new($counts[$s]); $pos[$s] = 0 }
    for ($i = 0; $i -lt $Count; $i++) {
        $s = $Systems[$i]; $p = $pos[$s]
        $arrays[$s][$p] = $Records[$i]
        $pos[$s] = $p + 1
    }
    return @{ Order = [int[]]@($order); Arrays = $arrays }
}
# The row count and the progress line every 100,000 rows, as the per-row path
# reports them.
function Step-SqlBatchProgress {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [int]$Count)
    $before = [Math]::Floor($Ctx.Rows / 100000)
    $Ctx.Rows += $Count
    if ([Math]::Floor($Ctx.Rows / 100000) -gt $before) {
        Update-CrawlerProgress -Detail "$($Ctx.Slot.name): $(([long]$Ctx.Rows).ToString('N0')) rows"
    }
}

# The per-batch callback for one slot. Not a closure, for the reason
# New-SqlRowCallback gives: the slot's context lives in script scope.
function New-SqlBatchCallback {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx)
    $script:SqlBatchCtx = $Ctx
    return { param($Columns, $Rows) Add-SqlAssignmentBatch -Columns $Columns -Rows $Rows -Ctx $script:SqlBatchCtx }
}

#endregion The batch
