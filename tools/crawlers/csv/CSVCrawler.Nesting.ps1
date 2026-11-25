<#
.SYNOPSIS
    Inherited access through nested resources, for the CSV crawler.

.DESCRIPTION
    The CSV crawler stores nesting (ResourceRelationships.csv) but nothing used
    to turn it into access: the matrix reads a declared-only matview and never
    walks nesting itself, so someone who held group B only through membership of
    group A simply did not appear on B. An Active Directory export — where
    nested groups are the norm — therefore under-reported who has access, which
    is the worst failure an access-review tool has. The Entra ID and SCIM
    crawlers already materialise the inherited rows at crawl time; this is the
    same capability for any CSV source (AD, LDAP, SAP composite roles).

    WHICH ROWS COUNT AS NESTING. Only `GrantsAccessTo`, whose documented meaning
    IS the expansion rule — "holding the parent implies access to the child".
    `Contains` is never expanded: in a CSV it also means a business role's
    resource grants, and `ResourceType` is free-form, so the two uses cannot be
    told apart. Direction: PARENT is the resource held, CHILD is the resource its
    holders gain — for AD nesting, parent = the member group, child = the
    containing group.

    Only `Direct` holders propagate (an `Eligible`, PIM-style membership is not
    active access), and a user-supplied `Indirect` row never seeds another hop —
    both mirroring ConvertTo-EntraNestedGroupIndirectAssignments. Someone who
    holds a resource both directly and by inheritance keeps the one `Direct` row:
    it is the stronger statement.

    THE WALK IS NOT WRITTEN AGAIN. Get-NestedGroupUserSet
    (tools/crawlers/shared/) is the one cycle-safe closure walk every crawler
    materialises from; it takes a "walk into these next" adjacency, so the graph
    here is built REVERSED — per edge, Parents[child] += parent — and the walk
    from a target climbs to everything that grants it.

    WHAT IT COSTS. The graph comes from ResourceRelationships.csv (small). During
    the existing Assignments.csv stream, holder sets are collected only for
    resources that are nodes of that graph, so an export with no `GrantsAccessTo`
    row collects nothing at all and the 40M-row case is untouched. There is no
    second pass over Assignments.csv.

    Dot-sourced into Start-CSVCrawler.ps1's scope like the other CSVCrawler.*
    files, and reads the crawler's state at call time:
      $script:CsvNesting       → the graph, created once per run
      $SystemType              → the deterministic idPrefix
      $fallbackSystemId        → the system a row without one belongs to
      $script:CsvStreamBatchSize → the streamed batch size (CSVCrawler.Phases.ps1)
      $script:CsvNestingRelationshipType → the expanded type (CSVCrawler.Transform.ps1)
#>

# The nested-group closure walk is shared with every other crawler that
# materialises Indirect assignments — see tools/crawlers/shared/.
. (Join-Path $PSScriptRoot '..' 'shared' 'Get-NestedGroupUserSet.ps1')

# The one relationshipType that means "holding the parent grants the child" is
# $script:CsvNestingRelationshipType, declared with the rest of the relationship
# vocabulary in CSVCrawler.Transform.ps1 (dot-sourced before this file) so the
# type this file expands and the types the phase reconciles cannot drift apart.

# The reconcile + full-sync scope of every row this file computes. Named once so
# the emit and the reconcile below cannot drift apart.
$script:CsvIndirectScope = @{ assignmentType = 'Indirect' }

# ─── The graph ───────────────────────────────────────────────────
# Ordinal dictionaries, not @{}: PowerShell's hashtables compare keys
# case-INsensitively, which would merge two resources whose externalIds differ
# only in case into one node — the ingest keys them apart, so the expansion must
# too (the same reason Get-CsvDedupedBatch uses an ordinal Dictionary).
function New-CsvNestingGraph {
    [CmdletBinding()]
    param()
    return [pscustomobject]@{
        # child externalId → the resources whose holders gain it
        Parents = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
        # child externalId → the systemId of the edge that granted it (D7)
        Granted = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::Ordinal)
        # node externalId → its Direct holders, collected during the stream
        Holders = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
        # every externalId on either side of an edge — the only resources whose
        # holders are worth collecting
        Nodes   = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        # the systems the assignments phase fed; empty means it read nothing,
        # and nothing may then be reconciled away
        Systems = [System.Collections.Generic.HashSet[int]]::new()
        # the API clock read before the assignments phase sent its first row —
        # the bound of the Indirect reconcile (see Sync-CsvNestedAccess)
        Before  = $null
    }
}

# Record the GrantsAccessTo edges of one ResourceRelationships.csv in the graph.
# Records are the shaped relationship records, so they still carry _systemId.
# A self-loop is dropped: it grants its own holders nothing, and would only make
# the walk's visited set do the work.
function Add-CsvNestingEdges {
    [CmdletBinding()]
    param($Graph, $Records)
    if (-not $Graph) { return }
    foreach ($r in $Records) {
        if ($r['relationshipType'] -ne $script:CsvNestingRelationshipType) { continue }
        $parent = [string]$r['parentExternalId']
        $child  = [string]$r['childExternalId']
        if (-not $parent -or -not $child -or $parent -ceq $child) { continue }
        $parents = $null
        if (-not $Graph.Parents.TryGetValue($child, [ref]$parents)) {
            $parents = [System.Collections.Generic.List[string]]::new()
            $Graph.Parents[$child] = $parents
            $Graph.Granted[$child] = [int]$r['_systemId']
        }
        $parents.Add($parent)
        [void]$Graph.Nodes.Add($parent)
        [void]$Graph.Nodes.Add($child)
    }
}

# Collect the Direct holders of the graph's nodes out of one shaped
# Assignments.csv batch, and note the system that batch fed.
#
# The system is recorded whatever the graph holds, because the Indirect
# reconcile needs it even when the file has no nesting at all — that is what
# clears rows inherited through nesting that has since been removed. The
# per-record pass is skipped entirely when there are no nodes, so a file without
# a single GrantsAccessTo row pays one hashtable write per system per batch.
function Add-CsvNestingHolders {
    [CmdletBinding()]
    param($Graph, [int]$SystemId, $Records)
    if (-not $Graph) { return }
    [void]$Graph.Systems.Add($SystemId)
    if ($Graph.Nodes.Count -eq 0) { return }
    $nodes   = $Graph.Nodes
    $holders = $Graph.Holders
    foreach ($rec in $Records) {
        if ($rec['assignmentType'] -ne 'Direct') { continue }
        $res = [string]$rec['resourceExternalId']
        if (-not $nodes.Contains($res)) { continue }
        $set = $null
        if (-not $holders.TryGetValue($res, [ref]$set)) {
            $set = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            $holders[$res] = $set
        }
        [void]$set.Add([string]$rec['principalExternalId'])
    }
}

# The Assignments.csv stream's collect hook (Sync-CsvStreamedFile -Spec.Collect).
# Takes the graph from the crawler's scope so the stream spec stays a plain
# data table, and does nothing when no run is in progress — which is what keeps
# every other phase, and every test that drives one, unchanged.
#
# The first call also reads the API clock into the graph. The hook runs on each
# shaped batch BEFORE that batch is handed to its stream, so the first call is
# earlier than any row step 6 writes: every Indirect row Assignments.csv still
# declares is touched after this bound, and survives the step 6b reconcile.
function Add-CsvNestingStreamBatch {
    [CmdletBinding()]
    param([int]$SystemId, $Records)
    $graph = $script:CsvNesting
    if (-not $graph) { return }
    if (-not $graph.Before) { $graph.Before = Get-CrawlerServerTime }
    Add-CsvNestingHolders -Graph $graph -SystemId $SystemId -Records $Records
}

# ─── The expansion ───────────────────────────────────────────────
# One Indirect assignment record per (resource gained, user), for every resource
# with at least one incoming edge: everyone who holds a resource that grants it,
# at any depth, except those who already hold it Direct.
#
# Cycles and diamonds are the walk's business: its visited set terminates
# A ∈ B ∈ A, and its user set is a HashSet, so a user reachable by two paths is
# emitted once.
function Get-CsvNestingAssignments {
    [CmdletBinding()]
    param($Graph)
    $out = [System.Collections.Generic.List[object]]::new()
    if (-not $Graph) { return , $out }
    foreach ($target in $Graph.Parents.Keys) {
        $users = Get-NestedGroupUserSet -SeedGroups $Graph.Parents[$target] `
            -ChildGroups $Graph.Parents -DirectUsers $Graph.Holders
        if ($users.Count -eq 0) { continue }
        $direct = $null
        [void]$Graph.Holders.TryGetValue($target, [ref]$direct)
        $sid = $Graph.Granted[$target]
        foreach ($u in $users) {
            if ($direct -and $direct.Contains($u)) { continue }
            [void]$out.Add(@{
                _systemId           = $sid
                resourceExternalId  = $target
                principalExternalId = $u
                assignmentType      = 'Indirect'
            })
        }
    }
    return , $out
}

# Stream the computed rows out, one delta stream per system, and answer with
# every system that has to be reconciled afterwards: the ones the assignments
# phase fed, plus the ones an edge granted a resource in. A system can be in
# only one of the two — an edge may name a system no assignment row did, and a
# system that lost its nesting entirely has rows to clear and no edge left.
function Send-CsvNestedAssignments {
    [CmdletBinding()]
    param($Graph, $Records)
    $streams = @{}
    foreach ($rec in $Records) {
        $sid = [int]$rec['_systemId']
        if ($sid -le 0) { $sid = $fallbackSystemId }
        $rec.Remove('_systemId')
        $stream = $streams[$sid]
        if (-not $stream) {
            $stream = New-CrawlerIngestStream -Endpoint 'ingest/resource-assignments' -SystemId $sid -IdPrefix $SystemType `
                -Scope $script:CsvIndirectScope -BatchSize $script:CsvStreamBatchSize -KeyFields $script:CsvAssignmentKeyFields
            $streams[$sid] = $stream
        }
        Add-CrawlerIngestStreamRecord -Stream $stream -Record $rec
    }
    foreach ($s in $streams.Values) { Complete-CrawlerIngestStream -Stream $s | Out-Null }
    $all = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($sid in $Graph.Systems) { [void]$all.Add($sid) }
    foreach ($sid in $streams.Keys) { [void]$all.Add([int]$sid) }
    return , [int[]]@($all)
}

# ─── Step 6b: inherited access through nesting ───────────────────
# Runs after Assignments.csv, because it is built from what that file declared.
#
# The reconcile is scoped to assignmentType='Indirect' and bounded by the server
# clock read BEFORE step 6 wrote its first row (Add-CsvNestingStreamBatch). The
# Indirect scope has two writers in one run — step 6, for the Indirect rows
# Assignments.csv supplies, and this step, for the computed ones — so the bound
# must precede both. Read here, after step 6, it made every supplied Indirect
# row look stale and reconciled it away. Read before, a row either writer
# touched this run survives, and one neither did (nesting removed, or a
# supplied row dropped from the file) does not. It is skipped when the
# assignments run fed no system at all (a missing, empty or all-skipped
# Assignments.csv), the same fail-safe every other full sync in this crawler
# has: a run that read nothing never deletes anything — nor when no bound was
# read, which only a graph filled outside a run can be.
function Sync-CsvNestedAccess {
    [CmdletBinding()]
    param()
    $graph = $script:CsvNesting
    if (-not $graph -or $graph.Systems.Count -eq 0 -or -not $graph.Before) { return }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Step 6b: Inherited access through nesting..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Expanding inherited access' -Pct 60
    $records = Get-CsvNestingAssignments -Graph $graph
    Write-Host "  $($records.Count) inherited assignment(s) across $($graph.Parents.Count) nested resource(s)" -ForegroundColor Gray
    $systems = Send-CsvNestedAssignments -Graph $graph -Records $records
    foreach ($sid in $systems) {
        Invoke-CrawlerReconcile -Endpoint 'ingest/resource-assignments' -SystemId $sid `
            -Scope $script:CsvIndirectScope -Before $graph.Before | Out-Null
    }
    $script:CsvNesting = $null
    [System.GC]::Collect()
}
