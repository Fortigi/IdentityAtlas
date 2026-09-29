<#
.SYNOPSIS
    Per-statement watermarks for the SQL Database crawler: what `@Since` is
    bound to, how far it moves, and when that is allowed to be remembered.

.DESCRIPTION
    A full read of an identity-governance source is a migration, not an
    operation. A statement opts out of that by binding `@Since` and naming the
    column it advances on (`watermarkColumn`); the crawler then reads only the
    rows whose watermark moved since the last VERIFIED run.

    Three properties are the whole point, and each is here on purpose:

      * The token's key carries a HASH OF THE STATEMENT. Editing a query changes
        the key, so the edited query starts from zero instead of silently
        skipping the rows its new shape would have returned.
      * The token is written only AFTER the run verified. A failed or unverified
        run re-reads the same window; every ingest is an upsert, so a re-read
        costs time, never correctness.
      * The stored value is the largest watermark READ, minus an OVERLAP. Several
        application servers write the source, their clocks drift, and a long
        transaction can commit rows stamped before rows already read. The
        overlap (default 15 minutes) is what stops those rows being stepped over.
        Too large an overlap re-reads rows; too small loses them, silently.

    Timestamps are epoch MILLISECONDS written by the application — `numeric`
    columns holding 13-digit values, confirmed against the production source
    (assumption A1 in docs/architecture/sql-connector-delta.md). `@Since` is
    therefore bound as a bigint. A statement whose watermark column does not
    convert to one is reported and its token is NOT written, so it keeps reading
    in full rather than advancing a mark it cannot compare.
#>

#region Watermark keys

# Epoch milliseconds are ~1.7e12 today, so a long is the only sane carrier: an
# int overflows in 1970 + 24 days.
$script:SqlWatermarkNone = [long]::MinValue

# A stable, short digest of the statement text. It does not have to be
# collision-proof against an adversary — it has to change when an operator
# edits the query, which the first 16 hex characters of SHA-256 do.
function Get-SqlStatementHash {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowEmptyString()] [string]$Sql)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Sql)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').Substring(0, 16).ToLowerInvariant()
    } finally { $sha.Dispose() }
}

# The API validates a delta-token endpoint as ^[a-zA-Z0-9/_\-.:]+$ and at most
# 200 characters, and a slot is named by a human ("Entitlement grants via a
# role"). Fold everything else to '-' so the name stays readable in the table
# without making the key a 400.
function ConvertTo-SqlTokenSlug {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowEmptyString()] [string]$Name)
    $slug = ([string]$Name).Trim() -replace '[^a-zA-Z0-9._-]', '-'
    $slug = $slug -replace '-{2,}', '-'
    $slug = $slug.Trim('-')
    if (-not $slug) { $slug = 'query' }
    if ($slug.Length -gt 60) { $slug = $slug.Substring(0, 60) }
    return $slug
}

# Where one statement's watermark lives: 'sql:<slot name>:<hash of the SQL>'.
# The hash is what makes an edited statement a deliberate reset.
function Get-SqlWatermarkKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Slot)
    return "sql:$(ConvertTo-SqlTokenSlug -Name $Slot.name):$(Get-SqlStatementHash -Sql $Slot.sql)"
}

# Where the same statement's last key sweep is recorded. A separate row: the two
# advance on different schedules and neither may reset the other.
function Get-SqlSweepKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Slot)
    return "sql:sweep:$(ConvertTo-SqlTokenSlug -Name $Slot.name):$(Get-SqlStatementHash -Sql $Slot.sql)"
}

#endregion Watermark keys

#region Per-slot delta state

# A stored token → the bigint to bind. Anything that is not a whole number is
# treated as no token: reading everything is slow, reading from a mark that
# means nothing is wrong.
function Get-SqlWatermarkFromToken {
    [CmdletBinding()]
    [OutputType([long])]
    param([AllowNull()] [AllowEmptyString()] [string]$Token)
    $n = [long]0
    if ($Token -and [long]::TryParse($Token.Trim(), [ref]$n) -and $n -gt 0) { return $n }
    return [long]0
}

# One slot's delta state for this run, or $null when the statement reads in
# full. A FULL run ignores any stored token and binds zero — that is what
# "Force full sync next run" has to mean — but still records where the
# watermark got to, so the next delta run starts from this run's high mark
# rather than from zero.
function New-SqlDeltaState {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$State)
    if (-not $Slot.watermarkColumn) { return $null }
    $key   = Get-SqlWatermarkKey -Slot $Slot
    $since = [long]0
    if ($State.SyncMode -eq 'delta') {
        $row = Get-CrawlerDeltaTokenRow -SystemId $State.SystemId -Endpoint $key
        if ($row) { $since = Get-SqlWatermarkFromToken -Token ([string]$row.token) }
    }
    return @{
        Slot = $Slot.name; Key = $key; Since = $since; Column = $Slot.watermarkColumn
        # The actual result-set column name, resolved on the first row.
        ColumnKey = $null
        Max = $script:SqlWatermarkNone; Rows = [long]0
        # A window was read only when the mark was non-zero. A first run, an
        # edited statement and a full run all read EVERYTHING, which is what
        # lets their scope still be reconciled (see Test-SqlScopeComplete).
        Windowed = ($since -gt 0)
        Unusable = $null
    }
}

# Which result-set column carries the watermark, matched by the same
# case-insensitive, underscore-ignoring rule as every other column.
function Resolve-SqlWatermarkColumn {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Delta, [Parameter(Mandatory)] [string[]]$Columns)
    $want = ConvertTo-SqlColumnKey -Name $Delta.Column
    foreach ($c in $Columns) {
        if ((ConvertTo-SqlColumnKey -Name $c) -eq $want) { $Delta.ColumnKey = $c; return }
    }
    $Delta.Unusable = "the statement does not return a '$($Delta.Column)' column"
}

# One streamed row's contribution to the high-water mark. Called per row on a
# watermarked slot only, and deliberately does nothing but compare: at tens of
# millions of rows anything else here is minutes.
function Update-SqlWatermark {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Delta, [Parameter(Mandatory)] $Row)
    $Delta.Rows++
    if ($Delta.Unusable -or -not $Delta.ColumnKey) { return }
    $v = $Row[$Delta.ColumnKey]
    if ($null -eq $v) { return }
    $n = [long]0
    if (-not [long]::TryParse([string]$v, [ref]$n)) {
        $Delta.Unusable = "the watermark column '$($Delta.Column)' returned '$v', which is not epoch milliseconds"
        return
    }
    if ($n -gt $Delta.Max) { $Delta.Max = $n }
}

#endregion Per-slot delta state

#region Storing the mark

# What this run would store: the largest watermark read, less the overlap, and
# never behind where it started. $null means "do not move it" — no rows, or a
# column this statement cannot advance on.
function Get-SqlNextWatermark {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Delta, [long]$OverlapMs = 900000)
    if ($Delta.Unusable) { return $null }
    if ($Delta.Max -eq $script:SqlWatermarkNone) { return $null }
    $next = $Delta.Max - $OverlapMs
    if ($next -lt $Delta.Since) { $next = $Delta.Since }
    if ($next -le 0) { return $null }
    return [long]$next
}

# Called ONLY after the run verified (Start-SqlCrawler.ps1). A run that threw
# anywhere before this leaves every token where it was, so the next run re-reads
# the same window instead of stepping over rows it never loaded.
function Save-SqlWatermarks {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$State)
    $saved = 0
    foreach ($d in $State.Deltas) {
        if ($d.Unusable) {
            Write-Host "  watermark for '$($d.Slot)' NOT stored: $($d.Unusable) — the statement will keep reading in full" -ForegroundColor Yellow
            continue
        }
        $next = Get-SqlNextWatermark -Delta $d -OverlapMs $State.OverlapMs
        if ($null -eq $next) { continue }
        Set-CrawlerDeltaToken -SystemId $State.SystemId -Endpoint $d.Key -Token ([string]$next) -RecordsLastSeen ([int][Math]::Min($d.Rows, [int]::MaxValue))
        Write-Host "  watermark '$($d.Slot)' → $next (high mark $($d.Max), overlap $([int]($State.OverlapMs / 1000))s)" -ForegroundColor DarkGray
        $saved++
    }
    return $saved
}

#endregion Storing the mark
