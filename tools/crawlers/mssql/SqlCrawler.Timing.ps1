<#
.SYNOPSIS
    Where a statement's time went: reading the source, shaping rows, turning them
    into JSON, waiting for the API, and counting the source for verification.

.DESCRIPTION
    Dot-sourced after SqlCrawler.Phases.ps1. A full load of a large governance
    source runs for hours, and "it is slow" has five different fixes depending on
    which of these it is — a slow source query, the crawler's own per-row work,
    serialisation, the database behind the API, or the verification counts. So
    every statement measures them separately and says so in the job log, and the
    run ends with one table of all of them.

    Measured in Stopwatch ticks (Stopwatch.GetTimestamp), accumulated by the
    places that do the work:

      ReadTicks       Invoke-SqlReaderPage: ExecuteReader, Read(), GetValues()
      SerializeTicks  Invoke-IngestAPI -Timing, per stream: ConvertTo-Json
      SendTicks       Invoke-IngestAPI -Timing, per stream: the POST, retries included
      CountTicks      Invoke-SqlSlot: the source counts before and after the read
      TotalTicks      Invoke-SqlSlot: the whole statement

    Shaping is what is left of the total. It is everything the crawler does per
    row in PowerShell — mapping columns, building records, routing, dangling
    checks, buffering — and it is measured as the remainder rather than directly
    because timing it row by row would cost more than some of what it measures.
#>

#region Timing

function New-SqlTiming {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()
    return @{ ReadTicks = [long]0; SerializeTicks = [long]0; SendTicks = [long]0; CountTicks = [long]0; TotalTicks = [long]0 }
}

# Fold the serialise/send time of every stream a slot opened into its timing.
# $Streams is the slot's role → stream-spec map (New-SqlSlotStreams).
function Add-SqlStreamTiming {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Timing, [hashtable]$Streams = @{})
    foreach ($spec in $Streams.Values) {
        foreach ($s in $spec.Streams.Values) {
            $Timing.SerializeTicks += $s.Timing.SerializeTicks
            $Timing.SendTicks      += $s.Timing.SendTicks
        }
    }
}

# Ticks → seconds per stage. Shaping is the remainder, never negative: the parts
# are measured by separate clock reads, and rounding between them must not show
# up as a negative number of seconds.
function Get-SqlTimingBreakdown {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Timing, [long]$Frequency = [System.Diagnostics.Stopwatch]::Frequency)
    $measured = $Timing.ReadTicks + $Timing.SerializeTicks + $Timing.SendTicks + $Timing.CountTicks
    $shape = [Math]::Max([long]0, $Timing.TotalTicks - $measured)
    return [ordered]@{
        total     = $Timing.TotalTicks / $Frequency
        read      = $Timing.ReadTicks / $Frequency
        shape     = $shape / $Frequency
        serialize = $Timing.SerializeTicks / $Frequency
        api       = $Timing.SendTicks / $Frequency
        counts    = $Timing.CountTicks / $Frequency
    }
}

# One statement's split, as the job log shows it.
function Format-SqlTimingLine {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Breakdown)
    $b = $Breakdown
    $ic = [System.Globalization.CultureInfo]::InvariantCulture
    return [string]::Format($ic, 'time: source read {0:0.0}s · shaping {1:0.0}s · JSON {2:0.0}s · API {3:0.0}s · source counts {4:0.0}s',
        $b.read, $b.shape, $b.serialize, $b.api, $b.counts)
}

# The run's table: one line per statement with its rows per second and the split,
# then the same for the whole run. $Totals is $State.Totals (slot name → totals
# with `rows` and `timing`, a breakdown). Returns the lines it wrote.
function Write-SqlRunTiming {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [System.Collections.IDictionary]$Totals)
    $ic = [System.Globalization.CultureInfo]::InvariantCulture
    $fmt = '  {0,-32} {1,12:N0} rows {2,8:0}s {3,9:N0}/s   read {4,6:0}s  shape {5,7:0}s  JSON {6,5:0}s  API {7,7:0}s  counts {8,5:0}s'
    $sum = [ordered]@{ total = 0.0; read = 0.0; shape = 0.0; serialize = 0.0; api = 0.0; counts = 0.0 }
    [long]$rows = 0
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('Where the time went:')
    foreach ($e in $Totals.GetEnumerator()) {
        $t = $e.Value.timing
        if (-not $t) { continue }
        $rows += [long]$e.Value.rows
        foreach ($k in @($sum.Keys)) { $sum[$k] += $t[$k] }
        $lines.Add([string]::Format($ic, $fmt, $e.Key, [long]$e.Value.rows, $t.total, (Get-SqlRate -Rows $e.Value.rows -Seconds $t.total), $t.read, $t.shape, $t.serialize, $t.api, $t.counts))
    }
    $lines.Add([string]::Format($ic, $fmt, 'all statements', $rows, $sum.total, (Get-SqlRate -Rows $rows -Seconds $sum.total), $sum.read, $sum.shape, $sum.serialize, $sum.api, $sum.counts))
    foreach ($l in $lines) { Write-Host $l -ForegroundColor Gray }
    return $lines.ToArray()
}

# Rows per second, 0 when no time passed rather than a division by zero.
function Get-SqlRate {
    [CmdletBinding()]
    [OutputType([double])]
    param([long]$Rows = 0, [double]$Seconds = 0)
    if ($Seconds -le 0) { return [double]0 }
    return $Rows / $Seconds
}

#endregion Timing
