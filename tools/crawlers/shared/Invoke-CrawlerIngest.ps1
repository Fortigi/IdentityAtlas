<#
.SYNOPSIS
    Shared ingest helpers used by all Identity Atlas crawlers.
.DESCRIPTION
    Invoke-IngestAPI     — POST to the Ingest API with retry and exponential backoff.
    Update-CrawlerProgress — Report job progress; throws on HTTP 409 (job terminated).
    ConvertTo-JsonArray  — Wrap a collection in List[object] so it always serialises
                           as a JSON array regardless of element count.

    These functions reference $ApiBaseUrl, $ApiKey, and $JobId from the calling
    crawler's script scope. Dot-source this file from the crawler entry point:

        . (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
#>

#region Functions

function Invoke-IngestAPI {
    [CmdletBinding()]
    param(
        [string]$Endpoint,
        [hashtable]$Body
    )

    $headers     = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    $json        = $Body | ConvertTo-Json -Depth 20 -Compress
    $uri         = "$ApiBaseUrl/$Endpoint"
    $maxAttempts = 5
    $attempt     = 0

    while ($true) {
        $attempt++
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $json -TimeoutSec 300
            if ($attempt -gt 1) { Write-Host "  Recovered on attempt $attempt" -ForegroundColor Green }
            return $response
        } catch {
            $statusCode   = $null
            $responseBody = $null
            try {
                $statusCode = $_.Exception.Response.StatusCode.value__
                # PS7 drains the response stream before the exception bubbles up, so the body
                # is in ErrorDetails.Message. Fall back to the stream for older engines.
                if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                    $responseBody = $_.ErrorDetails.Message
                } else {
                    $stream = $_.Exception.Response.GetResponseStream()
                    if ($stream) {
                        $reader       = [System.IO.StreamReader]::new($stream)
                        $responseBody = $reader.ReadToEnd()
                        $reader.Close()
                    }
                }
            } catch {}

            $isTransient = (-not $statusCode) -or ($statusCode -ge 500) -or ($statusCode -eq 429)

            if ($isTransient -and $attempt -lt $maxAttempts) {
                $delay  = [Math]::Pow(2, $attempt)  # 2, 4, 8, 16, 32 seconds
                $reason = if ($statusCode) { "HTTP $statusCode" } else { $_.Exception.Message }
                Write-Host "  Transient failure on $Endpoint ($reason) — retry $attempt/$($maxAttempts - 1) in ${delay}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
                continue
            }

            $payloadMB = [Math]::Round($json.Length / 1MB, 2)
            Write-Host "  ERROR: $Endpoint returned $statusCode after $attempt attempt(s) (payload: ${payloadMB} MB)" -ForegroundColor Red
            if ($responseBody) {
                Write-Host "  Response: $responseBody" -ForegroundColor Yellow
            } else {
                Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
            }
            throw
        }
    }
}

function Update-CrawlerProgress {
    [CmdletBinding()]
    param([string]$Step, [int]$Pct = -1, [string]$Detail = '')
    if (-not $JobId -or $JobId -le 0) { return }
    $body = @{ jobId = $JobId }
    if ($PSBoundParameters.ContainsKey('Step'))   { $body['step']   = $Step }
    if ($Pct -ge 0)                                { $body['pct']    = $Pct }
    if ($PSBoundParameters.ContainsKey('Detail')) { $body['detail'] = $Detail }
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post `
            -Headers $headers -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 10 | Out-Null
    } catch {
        $statusCode = $null
        try { $statusCode = $_.Exception.Response.StatusCode.value__ } catch {}
        if ($statusCode -eq 409) {
            # The job was terminated server-side (container restart, manual cancel). Propagate so
            # the dispatcher breaks out of the crawl and moves on to the next queued job.
            throw "Job $JobId terminated server-side (HTTP 409) — aborting crawl"
        }
        # Transient errors are non-fatal for progress reporting
    }
}

# Force a collection to always serialise as a JSON array — even when it contains
# exactly 0 or 1 items. PowerShell's ConvertTo-Json collapses a single-element
# array stored as a hashtable value into a bare object, which makes single-record
# delta batches fail at the server with "records must be an array". List[object]
# always round-trips as a JSON array regardless of count; the leading unary comma
# stops the pipeline from re-unwrapping the list back into individual items.
function ConvertTo-JsonArray {
    [CmdletBinding()]
    param([object[]]$Items)
    $list = [System.Collections.Generic.List[object]]::new()
    if ($null -ne $Items) {
        foreach ($it in @($Items)) { [void]$list.Add($it) }
    }
    return ,$list
}

# ─── Shared ingest-batch protocol ────────────────────────────────────────────
# The one canonical implementation of the crawler ingest protocol. Every crawler
# used to carry its own near-identical Send-IngestBatch (single batch, chunked
# start/continue/end sessions, empty handling) and they had DRIFTED — different
# batch sizes, delete handling, id-generation, empty-batch behaviour. This
# consolidates them: each crawler keeps only a thin Send-IngestBatch adapter that
# forwards to this function, wiring its crawler-specific bits as opt-in params:
#   -DeletedIds        delta tombstones sent alongside the upserts (Entra, Omada)
#   -BatchSize         chunk threshold (default 5000; CSV uses 10000)
#   -IdGeneration / -IdPrefix   deterministic-id contract (CSV: idPrefix becomes
#                      "<IdPrefix>-<entity>", matching normalization.js)
#   -SyncModeResolver  scriptblock ($entity) -> mode, for a per-endpoint sync
#                      mode (midPoint forces cross-system tables to delta)
#   -SkipWhenEmpty     on no records, skip the call entirely instead of sending
#                      an empty full-sync batch (midPoint/CSV: never scoped-wipe)
#   -OnStat            scriptblock ($entity,$seconds,$recordCount) for timing stats
# ConvertTo-JsonArray is applied to every records payload so single-record delta
# batches always serialise as an array (previously only some crawlers did this).

function Get-FGIngestBodyBase {
    [CmdletBinding()]
    param([int]$SystemId, [string]$SyncMode, [hashtable]$Scope, $Records, [string]$IdGeneration, [string]$IdPrefix)
    $body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = ConvertTo-JsonArray $Records }
    if ($IdGeneration) { $body['idGeneration'] = $IdGeneration }
    if ($IdPrefix)     { $body['idPrefix']     = $IdPrefix }
    return $body
}

function Write-FGIngestBatchHeader {
    [CmdletBinding()]
    param($Endpoint, $Records, $DeletedIds, [bool]$HaveRecords, [bool]$HaveDeletes)
    $count = if ($HaveRecords) { $Records.Count } else { $DeletedIds.Count }
    $what  = if ($HaveRecords) { 'records' } else { 'deletes' }
    Write-Host "  Sending $count $what to $Endpoint..." -NoNewline -ForegroundColor Cyan
    if ($HaveRecords -and $HaveDeletes) { Write-Host " (+$($DeletedIds.Count) deletes)" -ForegroundColor Cyan }
    else { Write-Host '' -ForegroundColor Cyan }
}

function Send-FGSingleIngestBatch {
    [CmdletBinding()]
    param($Endpoint, [int]$SystemId, [string]$SyncMode, [hashtable]$Scope, $Records, [string[]]$DeletedIds, [bool]$HaveRecords, [bool]$HaveDeletes, [string]$IdGeneration, [string]$IdPrefix)
    $recs = if ($HaveRecords) { $Records } else { $null }
    $body = Get-FGIngestBodyBase -SystemId $SystemId -SyncMode $SyncMode -Scope $Scope -Records $recs -IdGeneration $IdGeneration -IdPrefix $IdPrefix
    if ($HaveDeletes) { $body['deletedIds'] = ConvertTo-JsonArray $DeletedIds }
    $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
    Write-Host "  Result: $($result.inserted) inserted, $($result.updated) updated, $($result.deleted) deleted" -ForegroundColor Green
    return $result
}

function Send-FGChunkedIngestBatches {
    [CmdletBinding()]
    param($Endpoint, [int]$SystemId, [string]$SyncMode, [hashtable]$Scope, [array]$Records, [string[]]$DeletedIds, [bool]$HaveDeletes, [int]$BatchSize, [string]$IdGeneration, [string]$IdPrefix)
    $totalDeleted = 0
    if ($HaveDeletes) {
        $delBody = Get-FGIngestBodyBase -SystemId $SystemId -SyncMode $SyncMode -Scope $Scope -Records $null -IdGeneration $IdGeneration -IdPrefix $IdPrefix
        $delBody['deletedIds'] = ConvertTo-JsonArray $DeletedIds
        $totalDeleted = ((Invoke-IngestAPI -Endpoint $Endpoint -Body $delBody).deleted ?? 0)
    }
    $totalInserted = 0; $totalUpdated = 0; $syncId = $null; $result = $null
    for ($i = 0; $i -lt $Records.Count; $i += $BatchSize) {
        $batch   = $Records[$i..([Math]::Min($i + $BatchSize - 1, $Records.Count - 1))]
        $isFirst = ($i -eq 0)
        $body = Get-FGIngestBodyBase -SystemId $SystemId -SyncMode $SyncMode -Scope $Scope -Records $batch -IdGeneration $IdGeneration -IdPrefix $IdPrefix
        $body['syncSession'] = if ($isFirst) { 'start' } elseif ($i + $BatchSize -ge $Records.Count) { 'end' } else { 'continue' }
        if ($syncId) { $body['syncId'] = $syncId }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        if ($isFirst) { $syncId = $result.syncId }
        $totalInserted += ($result.inserted ?? 0)
        $totalUpdated  += ($result.updated ?? 0)
        Write-Host "  Batch $([Math]::Floor($i / $BatchSize) + 1)/$([Math]::Ceiling($Records.Count / $BatchSize)) done" -ForegroundColor Gray
    }
    $deleted = ($result.deleted ?? 0) + $totalDeleted
    Write-Host "  Total: $totalInserted inserted, $totalUpdated updated, $deleted deleted" -ForegroundColor Green
    return @{ inserted = $totalInserted; updated = $totalUpdated; deleted = $deleted }
}

function Invoke-CrawlerIngestBatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [int]$SystemId = 0,
        [string]$SyncMode = 'full',
        [hashtable]$Scope = @{},
        [array]$Records = @(),
        [string[]]$DeletedIds = @(),
        [int]$BatchSize = 5000,
        [string]$IdGeneration,
        [string]$IdPrefix,
        [scriptblock]$SyncModeResolver,
        [switch]$SkipWhenEmpty,
        [scriptblock]$OnStat
    )
    $entity = ($Endpoint -replace '^ingest/', '')
    $mode   = if ($SyncModeResolver) { & $SyncModeResolver $entity } else { $SyncMode }
    # CSV's deterministic idPrefix is per-endpoint: "<prefix>-<entity>".
    $fullIdPrefix = if ($IdPrefix) { "$IdPrefix-$entity" } else { $null }

    $haveRecords = $Records -and $Records.Count -gt 0
    $haveDeletes = $DeletedIds -and $DeletedIds.Count -gt 0

    if (-not $haveRecords -and -not $haveDeletes) {
        if ($SkipWhenEmpty) {
            Write-Host "  (no records for $Endpoint - skipping)" -ForegroundColor DarkGray
            return @{ inserted = 0; updated = 0; deleted = 0 }
        }
        # Empty full-sync batch so the server scoped-deletes stale rows.
        $body = Get-FGIngestBodyBase -SystemId $SystemId -SyncMode $mode -Scope $Scope -Records @() -IdGeneration $IdGeneration -IdPrefix $fullIdPrefix
        return (Invoke-IngestAPI -Endpoint $Endpoint -Body $body)
    }

    Write-FGIngestBatchHeader -Endpoint $Endpoint -Records $Records -DeletedIds $DeletedIds -HaveRecords $haveRecords -HaveDeletes $haveDeletes
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $result =
        if (-not $haveRecords -or $Records.Count -le $BatchSize) {
            Send-FGSingleIngestBatch -Endpoint $Endpoint -SystemId $SystemId -SyncMode $mode -Scope $Scope `
                -Records $Records -DeletedIds $DeletedIds -HaveRecords $haveRecords -HaveDeletes $haveDeletes `
                -IdGeneration $IdGeneration -IdPrefix $fullIdPrefix
        }
        else {
            Send-FGChunkedIngestBatches -Endpoint $Endpoint -SystemId $SystemId -SyncMode $mode -Scope $Scope `
                -Records $Records -DeletedIds $DeletedIds -HaveDeletes $haveDeletes -BatchSize $BatchSize `
                -IdGeneration $IdGeneration -IdPrefix $fullIdPrefix
        }
    $sw.Stop()
    if ($OnStat) { & $OnStat $entity $sw.Elapsed.TotalSeconds $Records.Count }
    return $result
}

#endregion Functions
