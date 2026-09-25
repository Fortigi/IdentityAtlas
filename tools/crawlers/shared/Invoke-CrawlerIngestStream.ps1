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
function Get-CrawlerServerTime {
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $who = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
    if ($who.serverTime) { return [string]$who.serverTime }
    Write-Host "  whoami carries no serverTime — falling back to the worker clock for the reconcile" -ForegroundColor Yellow
    return [DateTime]::UtcNow.ToString('o')
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
function Get-CrawlerStreamDedupedBatch {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stream)
    if (-not $Stream.KeyFields -or $Stream.KeyFields.Count -eq 0) { return , $Stream.Buffer }
    $seen = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    foreach ($r in $Stream.Buffer) { $seen[(Get-CrawlerStreamRecordKey -Record $r -KeyFields $Stream.KeyFields)] = $r }
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
