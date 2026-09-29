<#
.SYNOPSIS
    Crawler-side client for the staged load — POST /ingest/stages.

.DESCRIPTION
    A stage is the API's "here is the complete set, apply it in one step"
    primitive: open a stage for (entity, system, scope), stream batches into an
    unindexed staging table, then finalize. Finalize inserts what is new,
    updates only what changed, and — with -DeleteMissing — removes the
    system+scope's rows that are not in the stage. That removal is an anti-join
    inside PostgreSQL, which is what makes it usable for a KEY SWEEP: a stage
    carrying nothing but key columns inserts and updates nothing and only
    removes what the source no longer has.

    Why a sweep rather than the timestamp reconcile: the reconcile finds what a
    run did not touch, so it needs every surviving row touched — 40 million
    rewritten rows and index entries per refresh. Measured on the scale rig at a
    tenth of the data: 171 s to touch everything against 63.5 s for the
    change-only path (docs/architecture/scale-rehearsal.md).

    Nothing reaches the target table before finalize, and an abandoned stage
    changes nothing — so a read that fails part-way can never delete anything.

        New-CrawlerIngestStage         open one stage
        Add-CrawlerIngestStageRecord   buffer a record; flushed every BatchSize
        Complete-CrawlerIngestStage    flush the remainder (does NOT apply it)
        Invoke-CrawlerIngestStageFinalize  apply a run's stages together
        Remove-CrawlerIngestStage      abandon a stage

    Reads $ApiBaseUrl / $ApiKey from the caller's scope through Invoke-IngestAPI
    — dot-source Invoke-CrawlerIngest.ps1 first.
#>

#region Functions

function New-CrawlerIngestStage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Entity,
        [Parameter(Mandatory)] [int]$SystemId,
        [Parameter(Mandatory)] [string]$IdPrefix,
        [hashtable]$Scope = @{},
        [int]$BatchSize = 5000,
        # This stage only says what still exists — a key sweep. Finalize then
        # inserts and updates nothing and only removes what is missing. It has to
        # be DECLARED: the rows endpoint stamps systemId on every record, so a
        # sweep's stage looks exactly like an ordinary load of a scope whose rows
        # carry no optional attributes, and those two want opposite things.
        [switch]$KeysOnly
    )
    $body = @{ entity = $Entity; systemId = $SystemId; scope = $Scope
               idGeneration = 'deterministic'; idPrefix = "$IdPrefix-$Entity"; keysOnly = [bool]$KeysOnly }
    $r = Invoke-IngestAPI -Endpoint 'ingest/stages' -Body $body
    if (-not $r.stageId) { throw "The API did not return a stageId for a $Entity stage on system $SystemId" }
    return [pscustomobject]@{
        StageId   = [string]$r.stageId
        Entity    = $Entity
        SystemId  = $SystemId
        Scope     = $Scope
        BatchSize = $BatchSize
        Buffer    = [System.Collections.Generic.List[object]]::new($BatchSize)
        Sent      = 0
        Batches   = 0
    }
}

function Send-CrawlerIngestStageBatch {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stage)
    if ($Stage.Buffer.Count -eq 0) { return }
    Invoke-IngestAPI -Endpoint "ingest/stages/$($Stage.StageId)/rows" -Body @{ records = ConvertTo-JsonArray @($Stage.Buffer) } | Out-Null
    $Stage.Batches++
    $Stage.Sent += $Stage.Buffer.Count
    $Stage.Buffer.Clear()
}

function Add-CrawlerIngestStageRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stage, [Parameter(Mandatory)] $Record)
    [void]$Stage.Buffer.Add($Record)
    if ($Stage.Buffer.Count -ge $Stage.BatchSize) { Send-CrawlerIngestStageBatch -Stage $Stage }
}

# Flush what is left. The stage is NOT applied — finalizing is a separate,
# deliberate step, and every stage of a run is finalized together.
function Complete-CrawlerIngestStage {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stage)
    Send-CrawlerIngestStageBatch -Stage $Stage
    return @{ stageId = $Stage.StageId; sent = $Stage.Sent; batches = $Stage.Batches }
}

# Apply a run's stages in one call. Finalizing together is what lets a first
# load take the empty-table path for the whole run rather than for its first
# system only.
#
# -MaxDeleteShare is the safety catch, and it belongs on the call that deletes:
# the API counts what the anti-join would remove, and refuses (HTTP 409, nothing
# written) when that is more than this share of the scope. A sweep that suddenly
# wants a third of all grants has far more likely read a half-aggregated source
# than found a third of access revoked. 0 disables it.
function Invoke-CrawlerIngestStageFinalize {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]]$Stages,
        [switch]$DeleteMissing,
        [double]$MaxDeleteShare = 0
    )
    if ($Stages.Count -eq 0) { return @() }
    $body = @{ stageIds = @($Stages | ForEach-Object { $_.StageId }); deleteMissing = [bool]$DeleteMissing }
    if ($MaxDeleteShare -gt 0) { $body['maxDeleteShare'] = $MaxDeleteShare }
    $r = Invoke-IngestAPI -Endpoint 'ingest/stages/finalize' -Body $body
    return @($r.results)
}

# Abandon a stage: its staging table is dropped and the target table is
# untouched. Best-effort — an unfinalized stage also expires on its own.
function Remove-CrawlerIngestStage {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stage)
    try {
        Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/stages/$($Stage.StageId)" -Method Delete `
            -Headers @{ 'Authorization' = "Bearer $ApiKey" } -TimeoutSec 30 | Out-Null
    } catch {
        Write-Host "  (could not abandon stage $($Stage.StageId): $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}

#endregion Functions
