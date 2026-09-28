<#
.SYNOPSIS
    The key sweep: read a statement's COMPLETE key set, stage it, and remove
    from Identity Atlas whatever the source no longer has.

.DESCRIPTION
    A watermark finds additions and changes. It can never find a removal: a row
    deleted at the source does not bump its own timestamp on the way out. The
    timestamp reconcile cannot help in a delta run either — it removes the rows
    a run did not touch, and a delta run touches almost nothing.

    So removals are found by set difference instead. The statement is run again
    with @Since bound to zero and wrapped as SELECT DISTINCT <resource>,
    <principal>, so each row is two ids and nothing else; the pairs stream into
    a STAGE (POST /ingest/stages), and the finalize deletes every row of the
    system + scope that is not in it — one anti-join inside PostgreSQL.

    Why not "touch every row that is still there and let the reconcile find the
    rest": that rewrites 40 million rows and every one of their index entries
    per refresh. Measured on a tenth of the data: 171 s to touch everything
    against 63.5 s for the change-only path.

    Two things make this safe to schedule and leave alone:

      * The sweep is DUE-based, not every-run. It reads the whole key set, which
        is cheap next to a full load but not free, so it runs at most every
        `sweepIntervalHours` and a removal shows within one interval.
      * The finalize carries a SHARE CEILING (default 5%). A source read during
        aggregation — rows deleted and about to be re-inserted — looks exactly
        like a mass revocation, and deleting is the one operation here with no
        undo. Past the ceiling the API writes nothing and the job fails saying
        so; `sweepOverride` is the deliberate way through.
#>

#region Eligibility

$script:SqlSweepEntity = 'resource-assignments'

# Did this slot read the source's complete set this run? True when it has no
# watermark at all, and when it has one but bound zero — a first run, an edited
# statement, or a full sync.
function Test-SqlSlotReadInFull {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [hashtable]$Slot)
    $delta = @($State.Deltas | Where-Object { $_.Slot -eq $Slot.name })
    if ($delta.Count -eq 0) { return $true }
    return -not $delta[0].Windowed
}

# May this statement's scope be swept at all? A sweep stages keys per SYSTEM,
# and an assignment follows its resource's system — so when the run routes into
# several systems, the sweep needs every resource id this run's resources
# statements produced. If those were themselves windowed, the sweep would place
# rows in the crawler's own system and the finalize would then remove the routed
# systems' entire scope, which the share ceiling would catch but only after a
# wasted read. Refuse it up front and say why.
function Get-SqlSweepEligibility {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [hashtable]$Slot)
    if (-not $Slot.sweep) { return @{ ok = $false; reason = $null } }
    if ($State.SweepIntervalHours -le 0) { return @{ ok = $false; reason = 'sweepIntervalHours is 0' } }
    # This run already read the statement's complete set — a first run, an edited
    # statement, or a forced full sync. Its scope is therefore reconciled, which
    # removes exactly what a sweep would and has already touched every surviving
    # row. Sweeping as well would read the whole table a SECOND time for nothing:
    # on the rehearsal fixture, a full load of 4 million grants and then a sweep
    # of the same 4 million keys.
    if (Test-SqlSlotReadInFull -State $State -Slot $Slot) {
        return @{ ok = $false; covered = $true; reason = 'this run read the statement in full, so the reconcile already removed what is gone' }
    }
    if ($Slot.paged) { return @{ ok = $false; reason = 'the statement pages with @Offset, so its key set cannot be read as one distinct set' } }
    if ((Test-SqlSystemRouting -Catalog $State.Systems) -and -not $State.ResourcesComplete) {
        return @{ ok = $false; reason = 'this run routes into several systems but did not read its resources in full, so a swept key could not be placed in the right one' }
    }
    return @{ ok = $true; reason = $null }
}

# Is the sweep due? The marker is a row of its own in DeltaTokens, keyed on the
# statement's hash like the watermark, so an edited statement sweeps at once
# rather than waiting out an interval measured against the old query.
function Test-SqlSweepDue {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [hashtable]$Slot, [datetime]$Now = [datetime]::UtcNow)
    $key = Get-SqlSweepKey -Slot $Slot
    $row = Get-CrawlerDeltaTokenRow -SystemId $State.SystemId -Endpoint $key
    if (-not $row -or -not $row.lastSyncAt) { return @{ due = $true; key = $key; reason = 'never swept' } }
    $last = [datetime]::MinValue
    if (-not [datetime]::TryParse([string]$row.lastSyncAt, [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$last)) {
        return @{ due = $true; key = $key; reason = 'the last sweep time could not be read' }
    }
    $hours = ($Now - $last).TotalHours
    if ($hours -ge $State.SweepIntervalHours) { return @{ due = $true; key = $key; reason = "last swept $([Math]::Round($hours, 1))h ago" } }
    return @{ due = $false; key = $key; reason = "swept $([Math]::Round($hours, 1))h ago, interval is $($State.SweepIntervalHours)h" }
}

#endregion Eligibility

#region Reading the key set

# The statement's result columns WITHOUT running it. The sweep needs to know
# which columns carry the two ids before it can ask for them distinctly, and in
# a delta run the statement it would learn that from may legitimately have
# returned no rows at all.
function Get-SqlSweepResultColumns {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowNull()] $Connection, [Parameter(Mandatory)] [hashtable]$Slot, [int]$CommandTimeout = 600)
    if ($null -eq $Connection) { return $null }
    $cmd = $null; $reader = $null
    try {
        $cmd = $Connection.CreateCommand()
        $cmd.CommandText = 'SELECT name FROM sys.dm_exec_describe_first_result_set(@tsql, @params, 0) WHERE is_hidden = 0 ORDER BY column_ordinal'
        $cmd.CommandTimeout = $CommandTimeout
        [void]$cmd.Parameters.AddWithValue('@tsql', [string]$Slot.sql)
        [void]$cmd.Parameters.AddWithValue('@params', $(if ($Slot.watermarkColumn) { '@Since bigint' } else { [DBNull]::Value }))
        $reader = $cmd.ExecuteReader()
        $names = [System.Collections.Generic.List[string]]::new()
        while ($reader.Read()) { $names.Add([string]$reader.GetValue(0)) }
        if ($names.Count -eq 0) { return $null }
        return $names.ToArray()
    } catch {
        Write-Host "  (could not describe the statement's columns: $($_.Exception.GetBaseException().Message))" -ForegroundColor DarkGray
        return $null
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($cmd) { $cmd.Dispose() }
    }
}

# The complete key set as two columns. Falls back to the statement itself when
# the columns could not be described: the stage tolerates duplicates and extra
# columns are only bytes, so a wider read is slower but not wrong.
function Get-SqlSweepSql {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Slot, [AllowNull()] [hashtable]$Map)
    $p = if ($Map -and $Map.principalId) { $Map.principalId } elseif ($Map) { $Map.identityId } else { $null }
    $r = if ($Map) { $Map.resourceId } else { $null }
    if (-not $p -or -not $r) { return $Slot.sql }
    $rq = $r -replace '\]', ']]'
    $pq = $p -replace '\]', ']]'
    return "SELECT DISTINCT q.[$rq], q.[$pq] FROM (`n$($Slot.sql)`n) q"
}

#endregion Reading the key set

#region Staging and finalizing

# The stage one swept row belongs in, opened the first time that system appears.
function Get-SqlSweepStage {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [int]$SystemId)
    $stage = $null
    if ($Ctx.Stages.TryGetValue($SystemId, [ref]$stage)) { return $stage }
    $stage = New-CrawlerIngestStage -Entity $script:SqlSweepEntity -SystemId $SystemId -IdPrefix $Ctx.State.IdPrefix `
        -Scope $Ctx.Scope -BatchSize $Ctx.State.BatchSize
    $Ctx.Stages[$SystemId] = $stage
    return $stage
}

# One row of the key set → the key columns of a ResourceAssignment, and nothing
# else. resourceType is deliberately absent: it is the stage's SCOPE, not part
# of the key, and sending it would make the stage look like an ordinary load
# with every other attribute null.
function Add-SqlSweepRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    if (-not $Ctx.Map) {
        $overrides = if ($Ctx.Slot.columnMap) { $Ctx.Slot.columnMap } else { @{} }
        $Ctx.Map = Resolve-SqlColumnMap -Columns @($Row.Keys) -Target 'assignments' -ColumnMap $overrides
        $Ctx.Route = Get-SqlRouteMode -Map $Ctx.Map -Target 'assignments' -Routing (Test-SqlSystemRouting -Catalog $Ctx.State.Systems)
    }
    $rec = ConvertTo-SqlAssignmentRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $rec) { $Ctx.Skipped++; return }
    $sid = Get-SqlRowSystemId -Ctx $Ctx -Row $Row -Ref $rec.resourceExternalId
    Add-CrawlerIngestStageRecord -Stage (Get-SqlSweepStage -Ctx $Ctx -SystemId $sid) -Record @{
        resourceExternalId  = $rec.resourceExternalId
        principalExternalId = $rec.principalExternalId
        assignmentType      = $rec.assignmentType
        governed            = $rec.governed
    }
    $Ctx.Rows++
}

# The per-row callback. Not a closure, for the same reason the slot's is not:
# GetNewClosure() rebinds to a scope where the crawler's own functions are
# invisible. See New-SqlRowCallback.
function New-SqlSweepCallback {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx)
    $script:SqlSweepCtx = $Ctx
    return { param($Row) Add-SqlSweepRow -Row $Row -Ctx $script:SqlSweepCtx }
}

# Apply one statement's staged key set. Every stage of the sweep is finalized
# together, and the ceiling travels with the call that deletes.
function Complete-SqlSweepStages {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx)
    $stages = @($Ctx.Stages.Values)
    foreach ($s in $stages) { Complete-CrawlerIngestStage -Stage $s | Out-Null }
    if ($stages.Count -eq 0) { return @() }
    try {
        return Invoke-CrawlerIngestStageFinalize -Stages $stages -DeleteMissing -MaxDeleteShare $Ctx.State.SweepMaxDeleteShare
    } catch {
        foreach ($s in $stages) { Remove-CrawlerIngestStage -Stage $s }
        throw
    }
}

#endregion Staging and finalizing

#region The phase

# Sweep one statement. Returns the record kept in $State.Sweeps.
function Invoke-SqlSweepSlot {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [AllowNull()] $Connection,
          [Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [string]$Key)
    $columns = Get-SqlSweepResultColumns -Connection $Connection -Slot $Slot -CommandTimeout $State.CommandTimeout
    $map = if ($columns) { Resolve-SqlColumnMap -Columns $columns -Target 'assignments' -ColumnMap $(if ($Slot.columnMap) { $Slot.columnMap } else { @{} }) } else { $null }
    $sql = Get-SqlSweepSql -Slot $Slot -Map $map
    $distinct = $sql -ne $Slot.sql
    Write-Host "  reading the complete key set$(if (-not $distinct) { ' (whole statement — its columns could not be described)' })..." -ForegroundColor Gray
    $ctx = @{ Slot = $Slot; State = $State; Map = $null; Route = 'fixed'; Scope = (Get-SqlAssignmentScope -Slot $Slot)
              Stages = [System.Collections.Generic.Dictionary[int, object]]::new(); Rows = 0; Skipped = 0; Misrouted = 0 }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # @Since zero: a sweep is the complete set by definition, whatever window
    # the delta half of this run read.
    $read = Invoke-SqlQueryStream -Connection $Connection -Sql $sql -OnRow (New-SqlSweepCallback -Ctx $ctx) `
        -CommandTimeout $State.CommandTimeout -Since $(if ($Slot.watermarkColumn) { [long]0 } else { $null })
    $results = Complete-SqlSweepStages -Ctx $ctx
    $sw.Stop()
    $deleted = ($results | Measure-Object -Property deleted -Sum).Sum
    return @{ Slot = $Slot.name; Key = $Key; Read = [long]$read; Staged = [long]$ctx.Rows; Skipped = [long]$ctx.Skipped
              Deleted = [long]($deleted ?? 0); Distinct = $distinct; Systems = @($ctx.Stages.Keys)
              Scope = $ctx.Scope; Seconds = $sw.Elapsed.TotalSeconds }
}

# Sweep every eligible statement whose sweep is due. Runs after every slot has
# streamed, so the delta half of the run has already inserted whatever is new
# and the only difference left between source and database is what is gone.
function Invoke-SqlSweep {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [AllowNull()] $Connection, [hashtable[]]$Slots = @())
    foreach ($slot in @($Slots | Where-Object { $_.enabled -and $_.sweep })) {
        $eligible = Get-SqlSweepEligibility -State $State -Slot $slot
        if (-not $eligible.ok) {
            if ($eligible.reason) {
                $colour = if ($eligible.covered) { 'DarkGray' } else { 'Yellow' }
                Write-Host "`n  sweep skipped for '$($slot.name)': $($eligible.reason)" -ForegroundColor $colour
            }
            # A complete read is at least as good as a sweep, so it restarts the
            # interval — recorded like any other sweep, and therefore stored only
            # if the run verifies.
            if ($eligible.covered) {
                $State.Sweeps.Add(@{ Slot = $slot.name; Key = (Get-SqlSweepKey -Slot $slot); Read = [long]0; Staged = [long]0
                                     Skipped = [long]0; Deleted = [long]0; Distinct = $false; Covered = $true
                                     Systems = @(); Scope = (Get-SqlAssignmentScope -Slot $slot); Seconds = 0 })
            }
            continue
        }
        $due = Test-SqlSweepDue -State $State -Slot $slot
        if (-not $due.due) { Write-Host "`n  sweep not due for '$($slot.name)' ($($due.reason))" -ForegroundColor DarkGray; continue }
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Key sweep: $($slot.name) — $($due.reason)" -ForegroundColor Cyan
        Update-CrawlerProgress -Step "Key sweep: $($slot.name)" -Pct 88
        $r = Invoke-SqlSweepSlot -State $State -Connection $Connection -Slot $slot -Key $due.key
        $State.Sweeps.Add($r)
        Write-Host ("  {0:N0} keys staged across {1} system(s) in {2}s — {3:N0} row(s) removed" -f `
            $r.Staged, @($r.Systems).Count, [Math]::Round($r.Seconds), $r.Deleted) -ForegroundColor Green
    }
    return @($State.Sweeps).Count
}

# A sweep read the complete key set, so it is also the moment a scope's TOTAL
# can be checked rather than only the part this run touched. Only exact when the
# read was the distinct two-column one; otherwise the staged rows may repeat a
# pair and the comparison is a bound, which is not worth asserting.
function Test-SqlSweepTotals {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State)
    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($s in $State.Sweeps) {
        if (-not $s.Distinct) { continue }
        $expect = @{ Endpoint = "ingest/$script:SqlSweepEntity"; Scope = $s.Scope
                     Systems = [System.Collections.Generic.HashSet[int]]::new([int[]]@($s.Systems)) }
        # Everything live, not just what this run touched.
        $atlas = Measure-SqlScopeRows -State $State -Expectation $expect -Before $script:SqlBeginningOfTime
        $verdict = if ($atlas -eq $s.Staged) { @{ ok = $true; reason = $null } }
                   else { @{ ok = $false; reason = "the source's complete key set holds $($s.Staged.ToString('N0')) pairs but the scope holds $($atlas.ToString('N0')) rows after the sweep" } }
        $results.Add((Write-SqlVerdictLine -Label "sweep: $($s.Slot)" -Verdict $verdict -Expected $s.Staged -Actual $atlas))
    }
    return $results.ToArray()
}

# Called ONLY after the run verified, beside Save-SqlWatermarks: the marker is
# what stops the next run sweeping again, so a sweep that was not proven must
# not set it.
function Save-SqlSweepMarks {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$State)
    $saved = 0
    foreach ($s in $State.Sweeps) {
        Set-CrawlerDeltaToken -SystemId $State.SystemId -Endpoint $s.Key -Token ([DateTime]::UtcNow.ToString('o')) -RecordsLastSeen ([int][Math]::Min($s.Staged, [int]::MaxValue))
        $saved++
    }
    return $saved
}

#endregion The phase
