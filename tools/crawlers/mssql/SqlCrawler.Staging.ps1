<#
.SYNOPSIS
    Staged full load for the SQL crawler's assignment scopes: stream a scope's
    complete row set into a stage, then apply every stage of the run at once.

.DESCRIPTION
    Dot-sourced after SqlCrawler.Phases.ps1. A full sync of an IdentityIQ source
    rewrites tens of millions of assignments. Streamed as delta upserts, every
    batch pays for 13 live indexes on ResourceAssignments, and the timestamp
    reconcile afterwards needs every surviving row TOUCHED — so an unchanged
    re-import rewrites every row and every index entry just to say "still here".

    The API's staged load (POST /ingest/stages, app/api/src/ingest/stages.js)
    exists for exactly this: batches land in an unindexed stage, and one
    finalize inserts what is new, updates only what changed and removes what the
    stage does not hold (deleteMissing) — the same set the timestamp reconcile
    removes. Into an empty table it drops the indexes, inserts bare and rebuilds
    them once. Measured on the scale rig: 1.6x on a first load, 2.9x on an
    unchanged re-import, which writes nothing (docs/architecture/scale-rehearsal.md).

    WHEN. A scope is staged only in a FULL sync, and only when it read its
    complete set — the finalize's deleteMissing would otherwise remove every row
    a window did not return. Delta runs keep streaming. Only resource-assignments
    is staged: every other scope is small enough that the difference is noise.

    ONE STAGE PER (system, scope). Two statements feeding one scope share its
    stage; two stages of one scope finalized with deleteMissing would each
    remove the other's rows.

    WHAT CHANGES FOR THE REST OF THE RUN
      * A staged scope registers no timestamp reconcile: its finalize is the
        reconcile.
      * Its verification counts the scope's WHOLE live row set, not the rows
        touched since the run began: an unchanged row is deliberately not
        touched, and after deleteMissing the scope holds exactly the stage.
      * Nothing reaches the table until the finalize, and a run that fails
        before it leaves the scope as it was — rather than half-loaded.
#>

#region Staging

# Should this stream spec load through a stage?
function Test-SqlStagedSpec {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [string]$Endpoint, [bool]$Reconcile, [bool]$Complete)
    return [bool]($State.StageFullLoads -and $Reconcile -and $Complete -and $Endpoint -eq 'ingest/resource-assignments')
}

# The stage for one (system, scope), opened the first time a stream needs it and
# shared by every statement feeding that scope.
function Get-SqlStage {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [hashtable]$Spec, [int]$SystemId)
    $key = "$SystemId|" + (Get-SqlScopeKey -Endpoint $Spec.Endpoint -Scope $Spec.Scope)
    $stage = $State.Stages[$key]
    if ($stage) { return $stage }
    $entity = $Spec.Endpoint -replace '^ingest/', ''
    $stage = New-CrawlerIngestStage -Entity $entity -SystemId $SystemId -IdPrefix $State.IdPrefix -Scope $Spec.Scope -BatchSize $State.BatchSize
    $State.Stages[$key] = $stage
    return $stage
}

# Apply every stage of the run in one finalize, removing from each scope what
# its stage does not hold. Returns the per-stage results (empty when nothing was
# staged). A failure abandons the stages, so nothing half-applied is left, and
# fails the job — which then reconciles and verifies nothing.
function Complete-SqlStagedLoads {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State)
    $stages = @($State.Stages.Values)
    if ($stages.Count -eq 0) { return @() }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Applying $($stages.Count) staged scope(s)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Applying staged assignments' -Pct 87
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $results = @(Invoke-CrawlerIngestStageFinalize -Stages $stages -DeleteMissing)
    } catch {
        foreach ($s in $stages) { Remove-CrawlerIngestStage -Stage $s }
        throw
    }
    $sw.Stop()
    $State.StagedSeconds = $sw.Elapsed.TotalSeconds
    Write-SqlStagedSummary -Results $results -Seconds $sw.Elapsed.TotalSeconds | Out-Null
    return $results
}

# One line for the whole finalize: what it inserted, updated and removed, and by
# which path (an empty table is loaded bare and indexed once).
function Write-SqlStagedSummary {
    [CmdletBinding()]
    param([object[]]$Results = @(), [double]$Seconds = 0)
    $sum = @{ inserted = [long]0; updated = [long]0; deleted = [long]0; rows = [long]0 }
    foreach ($r in $Results) { foreach ($k in @($sum.Keys)) { $sum[$k] += [long]($r.$k ?? 0) } }
    $paths = (@($Results | ForEach-Object { $_.path } | Sort-Object -Unique) -join ', ')
    Write-Host ("  {0:N0} staged rows applied in {1:N0}s ({2}): {3:N0} inserted, {4:N0} updated, {5:N0} removed" -f `
        $sum.rows, $Seconds, $paths, $sum.inserted, $sum.updated, $sum.deleted) -ForegroundColor Green
    return $sum
}

#endregion Staging
