<#
.SYNOPSIS
    Staged load for the SQL crawler's assignment scopes: stream what a statement
    read into a stage, then apply the run's stages together.

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

    WHEN. Every assignment scope is staged, in a full sync and a delta run
    alike. What the run mode does NOT decide, completeness does:

      * A scope whose statements all read their COMPLETE set is applied with
        deleteMissing, so the finalize is also its reconcile. That is every
        scope of a full sync — and, in a delta run, every statement without a
        watermark and every watermarked one that has no stored mark yet. Run
        mode used to gate this, so a delta run that had never verified (and so
        had no watermark) streamed all 42 million assignments as upserts: the
        slow path, on exactly the run that needed the fast one.
      * A scope any statement read a WINDOW of is applied without deleteMissing
        — a window says nothing about the rows it did not return; the key sweep
        removes those. It is staged all the same, because a batched upsert
        rewrites every row it is handed and a stage writes only the ones whose
        values changed. IdentityIQ re-stamps millions of unchanged grants a day,
        and every one of them lands in the next window.

    Only resource-assignments is staged: every other scope is small enough that
    the difference is noise.

    ONE STAGE PER (system, scope). Two statements feeding one scope share its
    stage; two stages of one scope finalized with deleteMissing would each
    remove the other's rows. For the same reason a scope is complete only when
    EVERY statement feeding it was: one window among them and none of its stages
    may delete.

    ORDER. Windows are applied before the key sweep and complete scopes after
    the source connection is closed (Start-SqlCrawler.ps1). The sweep asserts a
    scope's total against the key set it read, which only holds once the run's
    additions are in the table; and a finalize of tens of millions of rows must
    not hold a source connection idle for an hour.

    WHAT CHANGES FOR THE REST OF THE RUN
      * A staged scope registers no timestamp reconcile: a complete one's
        finalize is the reconcile, and a windowed one is never reconciled.
      * A complete scope's verification counts its WHOLE live row set, not the
        rows touched since the run began: an unchanged row is deliberately not
        touched, and after deleteMissing the scope holds exactly the stage.
        That count is compared with the number of distinct assignments the
        finalize says its stages held — exactly, with no slack for a moving
        source, because neither number comes from the source.
      * A windowed scope's total proves nothing about the window, so it is
        held to something else: every distinct assignment the stage held must
        be live in the table afterwards, as the finalize counted them.
      * Nothing reaches the table until the finalize, and a run that fails
        before it leaves the scope as it was — rather than half-loaded.
#>

#region Staging

# Should this stream spec load through a stage?
function Test-SqlStagedSpec {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [string]$Endpoint, [bool]$Reconcile)
    return [bool]($State.StageLoads -and $Reconcile -and $Endpoint -eq 'ingest/resource-assignments')
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
    # The scope's expectation travels with its stage, so the finalize can tell it
    # what was applied (Set-SqlStagedExpectations).
    $stage | Add-Member -NotePropertyName Expect -NotePropertyValue $Spec.Expect -Force
    $State.Stages[$key] = $stage
    return $stage
}

# The expectation a stage carries, or $null (a stage built by hand has none).
function Get-SqlStageExpectation {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stage)
    return $Stage.PSObject.Properties['Expect']?.Value
}

# Did any statement feeding this stage's scope read a window? Asked when the
# stages are applied, by which time every statement has run — so every stage of
# one scope gets the same answer, whichever statement opened it.
function Test-SqlStageWindowed {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] $Stage)
    $expect = Get-SqlStageExpectation -Stage $Stage
    return [bool]($expect -and $expect.Windowed)
}

# Does a finalize result carry the counts this expectation is held to? Every
# scope needs `distinct`; a windowed one needs `present` as well.
function Test-SqlStageResultCounted {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] $Expect, $Result)
    if ($null -eq $Result -or $null -eq $Result.distinct) { return $false }
    return -not ($Expect.Windowed -and $null -eq $Result.present)
}

# Forget what a scope was told it held: one of its stages came back without
# counts, so the sum over the others would be a wrong number, not a smaller one.
function Clear-SqlStagedExpectation {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Expect)
    $Expect.Applied = $null; $Expect.Present = $null
    if ($Expect.Windowed) { $Expect.Unverifiable = 'the API did not report what the staged window held' }
}

# Add one stage's counts to what its scope held.
function Add-SqlStagedExpectation {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Expect, [Parameter(Mandatory)] $Result)
    $Expect.Applied = [long]($Expect.Applied ?? 0) + [long]$Result.distinct
    if ($Expect.Windowed) { $Expect.Present = [long]($Expect.Present ?? 0) + [long]$Result.present }
}

# Tell each staged scope how many distinct assignments its stages held. For a
# complete scope that is what the scope must hold now that the finalize has
# removed everything else; for a windowed one the finalize also reports how many
# of them are live in the table (`present`), and the two must be equal. Either
# way these are the numbers the verification compares
# (Get-SqlStagedScopeVerdict): the crawler's own data on both sides, so a source
# that is still being written to cannot move them.
#
# All or nothing per scope. An API that does not report the counts leaves a
# complete scope to the source's count; a windowed one has nothing else to be
# held to — an unchanged row is not touched, so "rows touched by this run" no
# longer means anything — and is reported as not verified.
function Set-SqlStagedExpectations {
    [CmdletBinding()]
    param([object[]]$Stages = @(), [object[]]$Results = @())
    $byId = @{}
    foreach ($r in $Results) { if ($r.stageId) { $byId[[string]$r.stageId] = $r } }
    $unknown = [System.Collections.Generic.HashSet[object]]::new()
    foreach ($s in $Stages) {
        $expect = Get-SqlStageExpectation -Stage $s
        if ($null -eq $expect) { continue }
        $r = $byId[[string]$s.StageId]
        if (-not (Test-SqlStageResultCounted -Expect $expect -Result $r)) { [void]$unknown.Add($expect); continue }
        Add-SqlStagedExpectation -Expect $expect -Result $r
    }
    foreach ($expect in $unknown) { Clear-SqlStagedExpectation -Expect $expect }
}

# Apply the run's stages in one finalize. Without -Windowed: every COMPLETE
# scope, removing from each what its stage does not hold. With -Windowed: every
# scope a statement read a window of, removing nothing. Each stage is applied by
# exactly one of the two calls, and forgotten once applied.
#
# Returns the per-stage results (empty when there was nothing to apply). A
# failure abandons the stages, so nothing half-applied is left, and fails the
# job — which then reconciles and verifies nothing.
function Complete-SqlStagedLoads {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [switch]$Windowed)
    $keys = @($State.Stages.Keys | Where-Object { (Test-SqlStageWindowed -Stage $State.Stages[$_]) -eq [bool]$Windowed })
    $stages = @($keys | ForEach-Object { $State.Stages[$_] })
    if ($stages.Count -eq 0) { return @() }
    $what = if ($Windowed) { 'staged window(s)' } else { 'staged scope(s)' }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Applying $($stages.Count) $what..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Applying staged assignments' -Pct $(if ($Windowed) { 86 } else { 87 })
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $results = @(Invoke-CrawlerIngestStageFinalize -Stages $stages -DeleteMissing:(-not $Windowed))
    } catch {
        foreach ($s in $stages) { Remove-CrawlerIngestStage -Stage $s }
        throw
    }
    $sw.Stop()
    foreach ($k in $keys) { $State.Stages.Remove($k) }
    $State.StagedSeconds += $sw.Elapsed.TotalSeconds
    Set-SqlStagedExpectations -Stages $stages -Results $results
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
