# MidpointCrawler.Functions.ps1
#
# Extracted top-level functions from Start-MidpointCrawler.ps1 so they can be
# dot-sourced and unit-tested in isolation (the Start script's Main body would
# otherwise run on import). Bodies are moved verbatim — behaviour is unchanged;
# the Start script dot-sources this file before its Main body runs, which is
# identical to defining the functions inline. The only addition is a leading
# [CmdletBinding()] in each body (required by the Pester quality gate).
#
# These functions read script-scoped state ($SyncMode, $CrossSystemEntities,
# $Script:ingestStats, $Script:fetchStats, $Script:phaseErrors, and the shadow
# label lookup maps) from the caller's scope at call time, exactly as before.

# Cross-system tables have no per-system delete scope → never reconcile-delete them
# (would remove other sources' data). Always upsert-only (delta) for these.
function Get-EntitySyncMode {
    [CmdletBinding()]
    param([string]$Entity)
    if ($CrossSystemEntities -contains $Entity) { return 'delta' }
    return $SyncMode
}

# Thin adapter over the shared Invoke-CrawlerIngestBatch (tools/crawlers/shared/
# Invoke-CrawlerIngest.ps1), wiring midPoint's crawler-specific bits:
#   • per-endpoint sync mode via Get-EntitySyncMode (unless -SyncModeOverride)
#     — cross-system tables are forced to delta so a full sync never wipes
#     another source's data;
#   • -SkipWhenEmpty (a phase with no records must NOT scoped-delete);
#   • Add-IngestStat timing via -OnStat.
function Send-IngestBatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [int]$SystemId      = 0,
        [string]$SyncModeOverride = $null,
        [hashtable]$Scope   = @{},
        [array]$Records     = @(),
        [int]$BatchSize     = 5000
    )
    $params = @{
        Endpoint      = $Endpoint
        SystemId      = $SystemId
        Scope         = $Scope
        Records       = $Records
        BatchSize     = $BatchSize
        SkipWhenEmpty = $true
        OnStat        = { param($e, $s, $c) Add-IngestStat -Endpoint $e -Seconds $s -Records $c }
    }
    if ($SyncModeOverride) { $params['SyncMode'] = $SyncModeOverride }
    else { $params['SyncModeResolver'] = { param($e) Get-EntitySyncMode -Entity $e } }
    Invoke-CrawlerIngestBatch @params
}

# ── Streaming ingest ──────────────────────────────────────────────────────────
# Flush records in BatchSize chunks within ONE sync session so a full-sync's scoped
# delete still sees the complete set — without ever holding all records in memory.
# Mirrors Send-IngestBatch's chunked-session protocol (start → continue → end), or a
# single full-sync call when everything fits in one batch.
function New-IngestStream {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Endpoint, [int]$SystemId = 0, [hashtable]$Scope = @{}, [int]$BatchSize = 5000)
    [pscustomobject]@{
        Endpoint = $Endpoint; SystemId = $SystemId; Scope = $Scope; BatchSize = $BatchSize
        Buffer = [System.Collections.Generic.List[object]]::new(); SyncId = $null; Started = $false
        Records = 0; Inserted = 0; Updated = 0; Deleted = 0
    }
}
function Send-IngestStreamChunk {
    [CmdletBinding()]
    param($Stream, [string]$Session)   # 'start' | 'continue' | 'end' | 'single'
    $entity = ($Stream.Endpoint -replace '^ingest/', '')
    $mode   = Get-EntitySyncMode -Entity $entity
    $count  = $Stream.Buffer.Count
    $body   = @{ systemId = $Stream.SystemId; syncMode = $mode; scope = $Stream.Scope; records = ConvertTo-JsonArray @($Stream.Buffer) }
    if ($Session -ne 'single') {
        $body['syncSession'] = $Session
        if ($Stream.SyncId) { $body['syncId'] = $Stream.SyncId }
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $R  = Invoke-IngestAPI -Endpoint $Stream.Endpoint -Body $body
    $sw.Stop()
    if ($Session -in @('start', 'single') -and $R.syncId) { $Stream.SyncId = $R.syncId }
    $Stream.Inserted += ($R.inserted ?? 0); $Stream.Updated += ($R.updated ?? 0); $Stream.Deleted += ($R.deleted ?? 0)
    Add-IngestStat -Endpoint $entity -Seconds $sw.Elapsed.TotalSeconds -Records $count
    $Stream.Buffer.Clear()
}
function Add-IngestStreamRecord {
    [CmdletBinding()]
    param($Stream, $Record)
    $Stream.Buffer.Add($Record); $Stream.Records++
    # Flush only once we hold MORE than a full batch, so a non-empty remainder is always
    # left for the closing 'end' (the ingest API rejects an empty records array, and the
    # scoped delete fires on 'end').
    if ($Stream.Buffer.Count -gt $Stream.BatchSize) {
        $remainder = [System.Collections.Generic.List[object]]::new()
        for ($i = $Stream.BatchSize; $i -lt $Stream.Buffer.Count; $i++) { $remainder.Add($Stream.Buffer[$i]) }
        while ($Stream.Buffer.Count -gt $Stream.BatchSize) { $Stream.Buffer.RemoveAt($Stream.Buffer.Count - 1) }
        Send-IngestStreamChunk -Stream $Stream -Session ($(if ($Stream.Started) { 'continue' } else { 'start' }))
        $Stream.Started = $true
        $Stream.Buffer = $remainder
    }
}
function Complete-IngestStream {
    [CmdletBinding()]
    param($Stream)
    if ($Stream.Records -eq 0) { return }   # nothing → no scoped delete (matches Send-IngestBatch empty-skip)
    Send-IngestStreamChunk -Stream $Stream -Session ($(if ($Stream.Started) { 'end' } else { 'single' }))
}

function Write-Step {
    [CmdletBinding()]
    param([string]$Msg) Write-Host "  → $Msg" -ForegroundColor DarkGray
}

function Add-PhaseError {
    [CmdletBinding()]
    param([string]$Phase, [string]$Msg)
    Write-Host "  $Phase failed: $Msg" -ForegroundColor Red
    $Script:phaseErrors.Add("${Phase}: $Msg")
}

function Add-IngestStat {
    [CmdletBinding()]
    param([string]$Endpoint, [double]$Seconds, [int]$Records)
    if (-not $Script:ingestStats.Contains($Endpoint)) { $Script:ingestStats[$Endpoint] = @{ seconds = 0.0; calls = 0; records = 0 } }
    $Script:ingestStats[$Endpoint].seconds += $Seconds
    $Script:ingestStats[$Endpoint].calls++
    $Script:ingestStats[$Endpoint].records += $Records
}
function Measure-MidpointFetch {
    [CmdletBinding()]
    param([string]$Label, [scriptblock]$Script)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $result = & $Script
    $sw.Stop()
    $n = @($result).Count
    $Script:fetchStats[$Label] = @{ seconds = $sw.Elapsed.TotalSeconds; count = $n }
    return $result
}

# Build a human-readable label for a shadow account. Some connectors (e.g. DatabaseTable)
# name shadows by a numeric key; prefer a readable attribute, then the owner's name +
# resource, and only fall back to the raw (possibly numeric) shadow name as a last resort.
function Get-MidpointShadowLabel {
    [CmdletBinding()]
    param($Shadow, [string]$ShadowOid, [string]$ResourceOid)
    $readable = Get-MidpointAttrValue -Shadow $Shadow -Keys @('fullName', 'cn', 'displayName', 'sAMAccountName', 'login', 'name')
    if (-not $readable) { $readable = Format-AccountLabel (Get-MidpointString $Shadow.name '') }
    else { $readable = Format-AccountLabel $readable }
    if ($readable -and $readable -match '[A-Za-z]') { return $readable }
    if ($ShadowOidToUserOid.ContainsKey($ShadowOid)) {
        $ownerOid = $ShadowOidToUserOid[$ShadowOid]
        if ($UserOidToName.ContainsKey($ownerOid)) {
            $rn = if ($ResourceOidToName.ContainsKey($ResourceOid)) { $ResourceOidToName[$ResourceOid] } else { 'account' }
            return ($UserOidToName[$ownerOid] + ' (' + $rn + ')')
        }
    }
    return (Get-MidpointString $Shadow.name $ShadowOid)
}
