<#
.SYNOPSIS
    Streaming ingest for sources too large to hold in memory or in one sync session.

.DESCRIPTION
    The chunked sync-session protocol (syncSession start/continue/end, see
    Invoke-CrawlerIngest.ps1) needs the whole run inside one 30-minute session,
    one pinned connection, one upsert of the entire payload at 'end', and a
    duplicate-free payload. A source of tens of millions of rows (the SQL
    crawler's entitlement assignments) satisfies none of that.

    This helper streams instead:

      New-CrawlerIngestStream        one stream per (endpoint, scope)
      Add-CrawlerIngestStreamRecord  buffer a record; every BatchSize records are
                                     POSTed as an INDEPENDENT delta upsert
      Add-CrawlerIngestStreamRecords the same for a whole collection in one call
      Complete-CrawlerIngestStream   flush the remainder, return the totals
      Invoke-CrawlerReconcile        the full-sync delete: POST /ingest/reconcile
                                     removes every row of the scope that no ingest
                                     touched since -Before
      Get-CrawlerServerTime          the API container's clock (whoami.serverTime),
                                     which is what -Before must be

    Each chunk commits on its own, so memory stays flat and a cross-chunk
    duplicate is only an update. Within one chunk duplicates are collapsed on
    -KeyFields, because a single upsert cannot touch the same key twice.

    Ids are deterministic: every record carries externalId (and *ExternalId
    references) and the API derives the UUIDs in the "<IdPrefix>-<entity>"
    namespace, exactly as the CSV crawler's batches do.

    Reads $ApiBaseUrl / $ApiKey / $JobId from the caller's scope through
    Invoke-IngestAPI — dot-source Invoke-CrawlerIngest.ps1 first.
#>

#region Functions

# The API container's clock, for a timestamp reconcile. Falls back to the local
# UTC clock only when talking to an API that predates the field.
#
# NOT `[string]$who.serverTime`. Invoke-RestMethod parses an ISO-8601 string in a
# JSON body into a [datetime] IN LOCAL TIME, and [string] on a datetime formats it
# with the CURRENT CULTURE — so the exact instant the API sent, say
# "2026-09-28T13:51:49.472Z", came back as "09/28/2026 13:51:49": no offset, and
# no milliseconds.
#
# WAS HISTORICAL DATA DAMAGED BY THIS? No. Every crawler that streams (the SQL
# connector and CSV) sent that truncated value as the `before` of its reconcile,
# and has done since the helper was written — but the truncation moves `before`
# EARLIER, by under a second, never later. The reconcile deletes
# `updatedAt < before`, so an earlier bound matches a strictly SMALLER set: it
# under-deletes and can never reach a row the run just wrote. The worst case is a
# row that left the source, whose last write landed in the same second the
# previous run started, surviving one extra run. On a first import, zero effect.
#
# The lost OFFSET is the half that could have hurt, and only under a
# misconfiguration: both shipped images run UTC with TZ unset (and the worker's
# PowerShell culture is the image's en-US, so the rendering is stable whatever the
# host is), which leaves the two halves agreeing. Set TZ on the worker alone and
# the value shifts by a whole offset — behind the API it still under-deletes;
# ahead of it the API refuses a future `before` outright, EXCEPT on a run longer
# than the offset, where rows written early in the run would be reconciled away.
# Normalising to an unambiguous UTC round-trip removes that path entirely.
#
# What made it visible: a full sync touches every row, so a bound a fraction of a
# second early changes nothing it counts. A DELTA verifies a window, and two runs
# a fraction of a second apart then count each other's rows — a delta that wrote
# one row verified as 48 and failed the job.
function Get-CrawlerServerTime {
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $who = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
    if ($who.serverTime) { return ConvertTo-CrawlerIsoTime -Value $who.serverTime }
    Write-Host "  whoami carries no serverTime — falling back to the worker clock for the reconcile" -ForegroundColor Yellow
    return [DateTime]::UtcNow.ToString('o')
}

# Whatever a JSON field carrying an instant deserialised into → an unambiguous
# round-trip UTC string. A [datetime] is normalised to UTC; anything else is
# passed through as the API spelled it.
function ConvertTo-CrawlerIsoTime {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()] $Value)
    if ($Value -is [datetime])       { return ([datetime]$Value).ToUniversalTime().ToString('o') }
    if ($Value -is [DateTimeOffset]) { return ([DateTimeOffset]$Value).UtcDateTime.ToString('o') }
    return [string]$Value
}

function New-CrawlerIngestStream {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [Parameter(Mandatory)] [int]$SystemId,
        [Parameter(Mandatory)] [string]$IdPrefix,
        [hashtable]$Scope = @{},
        [int]$BatchSize = 5000,
        [string[]]$KeyFields = @('externalId')
    )
    return [pscustomobject]@{
        Endpoint  = $Endpoint
        Entity    = ($Endpoint -replace '^ingest/', '')
        SystemId  = $SystemId
        IdPrefix  = $IdPrefix
        Scope     = $Scope
        BatchSize = $BatchSize
        KeyFields = $KeyFields
        Buffer    = [System.Collections.Generic.List[object]]::new($BatchSize)
        Records   = 0      # offered
        Sent      = 0      # after in-chunk dedup
        Deduped   = 0
        Batches   = 0
        Inserted  = 0
        Updated   = 0
    }
}

# The dedup key of one record: its key-field values joined with '|'. A record is
# a hashtable (the shapers' output) or an object with properties.
function Get-CrawlerStreamRecordKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Record, [string[]]$KeyFields)
    $parts = foreach ($f in $KeyFields) {
        if ($Record -is [System.Collections.IDictionary]) { [string]$Record[$f] } else { [string]$Record.$f }
    }
    return ($parts -join '|')
}

# Collapse duplicate keys within one chunk (last one wins, order otherwise kept).
# The key of a hashtable record — what every shaper emits — is built inline: a
# function call per record is the single largest cost of a streamed run at tens
# of millions of rows. Other record shapes go through Get-CrawlerStreamRecordKey.
function Get-CrawlerStreamDedupedBatch {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stream)
    $kf = $Stream.KeyFields
    if (-not $kf -or $kf.Count -eq 0) { return , $Stream.Buffer }
    $seen = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    foreach ($r in $Stream.Buffer) {
        if ($r -isnot [System.Collections.IDictionary]) { $seen[(Get-CrawlerStreamRecordKey -Record $r -KeyFields $kf)] = $r; continue }
        # String concatenation and an indexer, not StringBuilder calls: in
        # PowerShell a .NET method call costs microseconds, an operator does not.
        $k = ''
        foreach ($f in $kf) { $k += [string]$r[$f] + '|' }
        $seen[$k] = $r
    }
    if ($seen.Count -eq $Stream.Buffer.Count) { return , $Stream.Buffer }
    $out = [System.Collections.Generic.List[object]]::new($seen.Count)
    foreach ($v in $seen.Values) { [void]$out.Add($v) }
    $Stream.Deduped += ($Stream.Buffer.Count - $out.Count)
    return , $out
}

function Send-CrawlerIngestStreamBatch {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stream)
    $batch = Get-CrawlerStreamDedupedBatch -Stream $Stream
    $body = @{
        systemId     = $Stream.SystemId
        syncMode     = 'delta'
        scope        = $Stream.Scope
        idGeneration = 'deterministic'
        idPrefix     = "$($Stream.IdPrefix)-$($Stream.Entity)"
        records      = ConvertTo-JsonArray @($batch)
    }
    $r = Invoke-IngestAPI -Endpoint $Stream.Endpoint -Body $body
    $Stream.Batches++
    $Stream.Sent     += $batch.Count
    $Stream.Inserted += [int]($r.inserted ?? 0)
    $Stream.Updated  += [int]($r.updated ?? 0)
    $Stream.Buffer.Clear()
    Write-Host "  $($Stream.Endpoint): batch $($Stream.Batches) sent ($($Stream.Sent.ToString('N0')) records so far)" -ForegroundColor DarkGray
}

function Add-CrawlerIngestStreamRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stream, [Parameter(Mandatory)] $Record)
    [void]$Stream.Buffer.Add($Record)
    $Stream.Records++
    if ($Stream.Buffer.Count -ge $Stream.BatchSize) { Send-CrawlerIngestStreamBatch -Stream $Stream }
}

# Buffer a whole collection in one call. Same chunking as the per-record form —
# no chunk ever exceeds BatchSize, and each goes out as soon as it is full —
# without paying anything per record: one AddRange for the collection, and the
# overflow past a full chunk is set aside while that chunk is sent. A per-record
# Add is ~10 µs in PowerShell, which at tens of millions of rows is minutes.
function Add-CrawlerIngestStreamRecords {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stream, [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]]$Records)
    $buf = $Stream.Buffer
    $size = $Stream.BatchSize
    $buf.AddRange($Records)
    $Stream.Records += $Records.Length
    while ($buf.Count -ge $size) {
        $rest = $buf.GetRange($size, $buf.Count - $size)
        $buf.RemoveRange($size, $buf.Count - $size)
        Send-CrawlerIngestStreamBatch -Stream $Stream
        $buf.AddRange($rest)
    }
}

# Flush what is left and return the totals. A stream that never received a
# record sends nothing — an empty delta batch says nothing.
function Complete-CrawlerIngestStream {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stream)
    if ($Stream.Buffer.Count -gt 0) { Send-CrawlerIngestStreamBatch -Stream $Stream }
    Write-Host "  $($Stream.Endpoint): $($Stream.Sent.ToString('N0')) records in $($Stream.Batches) batch(es) — $($Stream.Inserted.ToString('N0')) inserted, $($Stream.Updated.ToString('N0')) updated$(if ($Stream.Deduped) { ", $($Stream.Deduped.ToString('N0')) duplicates collapsed" })" -ForegroundColor Green
    return @{ records = $Stream.Records; sent = $Stream.Sent; batches = $Stream.Batches; inserted = $Stream.Inserted; updated = $Stream.Updated; deduped = $Stream.Deduped }
}

# The full-sync delete for a streamed run. Returns the number of rows reconciled.
function Invoke-CrawlerReconcile {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [Parameter(Mandatory)] [int]$SystemId,
        [Parameter(Mandatory)] [string]$Before,
        [hashtable]$Scope = @{}
    )
    $entity = ($Endpoint -replace '^ingest/', '')
    $r = Invoke-IngestAPI -Endpoint 'ingest/reconcile' -Body @{ entity = $entity; systemId = $SystemId; scope = $Scope; before = $Before }
    $deleted = [int]($r.deleted ?? 0)
    $scopeText = if ($Scope.Count) { ' ' + (($Scope.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', ') } else { '' }
    Write-Host "  reconcile $entity$scopeText`: $($deleted.ToString('N0')) stale row(s) removed" -ForegroundColor Green
    return $deleted
}

#endregion Functions
