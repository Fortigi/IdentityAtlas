<#
.SYNOPSIS
    Sync phases for the SQL Database crawler: system registration, one phase per
    configured query slot, the end-of-run reconcile, and completion.

.DESCRIPTION
    Dot-sourced into Start-SqlCrawler.ps1's scope after the shared ingest and
    streaming helpers, SqlCrawler.Functions.ps1 and SqlCrawler.Transform.ps1.

    A slot phase opens one streaming ingest per (endpoint, scope) it feeds, runs
    the statement through Invoke-SqlQueryStream, and shapes + buffers each row as
    it arrives — nothing is held beyond one batch. Slots run in dependency order
    (identities → principals → resources → identity-members → assignments →
    relationships) regardless of configuration order, and the ids of every
    resource / principal emitted are remembered so a dangling assignment or
    relationship is counted instead of sent.

    The reconcile (full sync only) runs once per distinct (endpoint, scope) after
    every slot has streamed cleanly. A slot that throws aborts the job before it,
    so a partial read can never delete anything.
#>

#region Run state

$script:SqlTargetOrder = @('identities', 'principals', 'resources', 'identity-members', 'assignments', 'relationships')

# The enabled slots in dependency order (stable within a target).
function Get-SqlSlotsInOrder {
    [CmdletBinding()]
    param([hashtable[]]$Slots = @())
    # CALLERS MUST WRAP THIS IN @(). PowerShell unrolls a returned collection, so
    # a ONE-slot result arrives as the bare hashtable: `.Count` then reports the
    # number of KEYS in the slot and `[0]` is $null. Start-SqlCrawler.ps1 indexes
    # the result, and without the wrapper a crawler with a single enabled query
    # died on its first slot with "Cannot bind argument to parameter 'Slot'
    # because it is null".
    #
    # A leading comma here would fix that case and break the empty one: an empty
    # array written to the pipeline emits nothing, the caller's variable becomes
    # $null, and `@($null)` is one element — a phantom slot. @() at the call site
    # is the one form that is correct at 0, 1 and many.
    $enabled = @($Slots | Where-Object { $_.enabled })
    return @($enabled | Sort-Object -Stable { [array]::IndexOf($script:SqlTargetOrder, $_.target) })
}

function New-SqlRunState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [Parameter(Mandatory)] [string]$ServerTime,
        [hashtable[]]$Slots = @(),
        [int]$BatchSize = 5000,
        [int]$PageSize = 10000,
        [int]$CommandTimeout = 600,
        [string]$SyncMode = 'full'
    )
    $targets = @($Slots | Where-Object { $_.enabled } | ForEach-Object { $_.target })
    return @{
        SystemId        = $SystemId
        IdPrefix        = "sql-$SystemId"
        ServerTime      = $ServerTime
        BatchSize       = $BatchSize
        PageSize        = $PageSize
        CommandTimeout  = $CommandTimeout
        SyncMode        = $SyncMode
        KnownResources  = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        KnownPrincipals = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        HasResources    = ($targets -contains 'resources')
        HasPrincipals   = ($targets -contains 'identities' -or $targets -contains 'principals')
        Scopes          = [System.Collections.Generic.List[hashtable]]::new()
        Totals          = [ordered]@{}
    }
}

# Remember an (endpoint, scope) for the end-of-run reconcile — once, however
# many slots feed it.
function Add-SqlReconcileScope {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [string]$Endpoint, [hashtable]$Scope = @{})
    $key = $Endpoint + '|' + (($Scope.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ';')
    if ($State.Scopes | Where-Object { $_.Key -eq $key }) { return }
    $State.Scopes.Add(@{ Key = $key; Endpoint = $Endpoint; Scope = $Scope })
}

#endregion Run state

#region Streams per slot

function New-SqlStream {
    [CmdletBinding()]
    param([hashtable]$State, [string]$Endpoint, [hashtable]$Scope = @{}, [string[]]$KeyFields = @('externalId'), [switch]$Reconcile)
    if ($Reconcile) { Add-SqlReconcileScope -State $State -Endpoint $Endpoint -Scope $Scope }
    return New-CrawlerIngestStream -Endpoint $Endpoint -SystemId $State.SystemId -IdPrefix $State.IdPrefix -Scope $Scope -BatchSize $State.BatchSize -KeyFields $KeyFields
}

# The ingest streams a slot feeds, by role. Identities and identity-members are
# cross-system tables (no systemId) and are never reconciled — same rule as
# midPoint and CSV.
function New-SqlSlotStreams {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$State)
    $memberKeys = @('identityExternalId', 'principalExternalId')
    switch ($Slot.target) {
        'identities' {
            return @{
                identity  = New-SqlStream -State $State -Endpoint 'ingest/identities'
                principal = New-SqlStream -State $State -Endpoint 'ingest/principals' -Scope @{ principalType = $Slot.principalType } -Reconcile
                member    = New-SqlStream -State $State -Endpoint 'ingest/identity-members' -KeyFields $memberKeys
            }
        }
        'principals' {
            return @{
                principal = New-SqlStream -State $State -Endpoint 'ingest/principals' -Scope @{ principalType = $Slot.principalType } -Reconcile
                member    = New-SqlStream -State $State -Endpoint 'ingest/identity-members' -KeyFields $memberKeys
            }
        }
        'identity-members' { return @{ member = New-SqlStream -State $State -Endpoint 'ingest/identity-members' -KeyFields $memberKeys } }
        'resources'        { return @{ resource = New-SqlStream -State $State -Endpoint 'ingest/resources' -Scope @{ resourceType = $Slot.resourceType } -Reconcile } }
        'assignments' {
            $scope = @{ assignmentType = $Slot.assignmentType; resourceType = $Slot.resourceType; governed = [bool]$Slot.governed }
            return @{ assignment = New-SqlStream -State $State -Endpoint 'ingest/resource-assignments' -Scope $scope -KeyFields @('resourceExternalId', 'principalExternalId') -Reconcile }
        }
        'relationships' {
            return @{ relationship = New-SqlStream -State $State -Endpoint 'ingest/resource-relationships' -Scope @{ relationshipType = $Slot.relationshipType } -KeyFields @('parentExternalId', 'childExternalId') -Reconcile }
        }
    }
    throw "No streams for target '$($Slot.target)'"
}

#endregion Streams per slot

#region Row handlers

# Each handler shapes one row for its target and buffers the record(s), or
# counts the row as skipped (unusable) / dangling (names an id this run has not
# seen). $Ctx: Slot, Map, Streams, State, Skipped, Dangling.

function Add-SqlIdentityRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $identity = ConvertTo-SqlIdentityRecord -Row $Row -Map $Ctx.Map
    if (-not $identity) { $Ctx.Skipped++; return }
    $principal = ConvertTo-SqlPrincipalRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.identity  -Record $identity
    Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.principal -Record $principal
    Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.member    -Record (New-SqlIdentityMemberRecord -IdentityId $identity.externalId -PrincipalId $identity.externalId)
    [void]$Ctx.State.KnownPrincipals.Add($identity.externalId)
}

function Add-SqlPrincipalRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $principal = ConvertTo-SqlPrincipalRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $principal) { $Ctx.Skipped++; return }
    Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.principal -Record $principal
    [void]$Ctx.State.KnownPrincipals.Add($principal.externalId)
    $identityId = ([string](Get-SqlMapped -Row $Row -Map $Ctx.Map -Name 'identityId')).Trim()
    if ($identityId) {
        Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.member -Record (New-SqlIdentityMemberRecord -IdentityId $identityId -PrincipalId $principal.externalId -IsPrimary $false -AccountType 'Linked')
    }
}

function Add-SqlMemberRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = ConvertTo-SqlIdentityMemberRecord -Row $Row -Map $Ctx.Map
    if (-not $rec) { $Ctx.Skipped++; return }
    Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.member -Record $rec
}

function Add-SqlResourceRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = ConvertTo-SqlResourceRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $rec) { $Ctx.Skipped++; return }
    Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.resource -Record $rec
    [void]$Ctx.State.KnownResources.Add($rec.externalId)
}

function Add-SqlAssignmentRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = ConvertTo-SqlAssignmentRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $rec) { $Ctx.Skipped++; return }
    $st = $Ctx.State
    if (($st.HasResources -and -not $st.KnownResources.Contains($rec.resourceExternalId)) -or
        ($st.HasPrincipals -and -not $st.KnownPrincipals.Contains($rec.principalExternalId))) {
        $Ctx.Dangling++; return
    }
    Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.assignment -Record $rec
}

function Add-SqlRelationshipRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = ConvertTo-SqlRelationshipRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $rec) { $Ctx.Skipped++; return }
    $known = $Ctx.State.KnownResources
    if ($Ctx.State.HasResources -and -not ($known.Contains($rec.parentExternalId) -and $known.Contains($rec.childExternalId))) {
        $Ctx.Dangling++; return
    }
    Add-CrawlerIngestStreamRecord -Stream $Ctx.Streams.relationship -Record $rec
}

function Get-SqlRowHandler {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [string]$Target)
    switch ($Target) {
        'identities'       { return 'Add-SqlIdentityRow' }
        'principals'       { return 'Add-SqlPrincipalRow' }
        'identity-members' { return 'Add-SqlMemberRow' }
        'resources'        { return 'Add-SqlResourceRow' }
        'assignments'      { return 'Add-SqlAssignmentRow' }
        'relationships'    { return 'Add-SqlRelationshipRow' }
    }
    throw "No row handler for target '$Target'"
}

#endregion Row handlers

#region Phases

function Register-SqlSystem {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Cfg)
    $serverTime  = Get-CrawlerServerTime
    $displayName = Get-CrawlerSystemName -TypeDefault "SQL Database ($($Cfg.server)/$($Cfg.database))" -ConfigName $Cfg.configName -SystemName $Cfg.systemName
    $tenantId    = "$($Cfg.server)/$($Cfg.database)".ToLowerInvariant()
    Write-Host "Registering system '$displayName'..." -ForegroundColor Cyan
    $r = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'delta'
        records  = @(@{ systemType = 'SQL'; displayName = $displayName; tenantId = $tenantId; description = "SQL Server $($Cfg.server), database $($Cfg.database)"; enabled = $true; syncEnabled = $true })
    }
    $id = if ($r.systemIds) { [int]$r.systemIds[0] } elseif ($r.systemId) { [int]$r.systemId } else { 0 }
    # Every reconcile is scoped to this id; guessing one would point it at another system.
    if ($id -le 0) { throw 'Could not resolve the system id after registration' }
    Write-Host "  System id $id (API clock $serverTime)" -ForegroundColor Gray
    return @{ systemId = $id; serverTime = $serverTime; displayName = $displayName }
}

# One streamed row: resolve the column map on the first row of the result set,
# then dispatch to the target's handler.
function Add-SqlStreamedRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row)
    $ctx = $script:SqlRowCtx
    if (-not $ctx.Map) {
        $overrides = if ($ctx.Slot.columnMap) { $ctx.Slot.columnMap } else { @{} }
        $ctx.Map = Resolve-SqlColumnMap -Columns @($Row.Keys) -Target $ctx.Slot.target -ColumnMap $overrides
    }
    & $script:SqlRowHandler $Row $ctx
    $ctx.Rows++
    if ($ctx.Rows % 100000 -eq 0) { Update-CrawlerProgress -Detail "$($ctx.Slot.name): $($ctx.Rows.ToString('N0')) rows" }
}

# The per-row callback for one slot.
#
# Deliberately NOT a closure: GetNewClosure() rebinds the scriptblock to a fresh
# module scope, where the crawler's own dot-sourced functions (Resolve-SqlColumnMap,
# the shapers) are not visible — so the callback threw "is not recognized" as soon
# as anything other than its defining scope invoked it. The callback instead keeps
# the script session state and reads the slot's context from script scope. Only one
# slot streams at a time, so a single context is all there is to hold.
function New-SqlRowCallback {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [Parameter(Mandatory)] [string]$Handler)
    $script:SqlRowCtx     = $Ctx
    $script:SqlRowHandler = $Handler
    return { param($Row) Add-SqlStreamedRow -Row $Row }
}

function Invoke-SqlSlot {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] $Connection, [Parameter(Mandatory)] [hashtable]$State, [int]$Pct = 10)
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] $($Slot.name) → $($Slot.target)$(if ($Slot.paged) { ' (paged)' })" -ForegroundColor Cyan
    Update-CrawlerProgress -Step "Query: $($Slot.name)" -Pct $Pct
    $ctx = @{ Slot = $Slot; Map = $null; Streams = (New-SqlSlotStreams -Slot $Slot -State $State); State = $State; Rows = 0; Skipped = 0; Dangling = 0 }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $rows = Invoke-SqlQueryStream -Connection $Connection -Sql $Slot.sql -OnRow (New-SqlRowCallback -Ctx $ctx -Handler (Get-SqlRowHandler -Target $Slot.target)) `
        -CommandTimeout $State.CommandTimeout -Paged $Slot.paged -PageSize $State.PageSize
    $sent = 0
    foreach ($s in $ctx.Streams.Values) { $sent += (Complete-CrawlerIngestStream -Stream $s).sent }
    $sw.Stop()
    $note = @()
    if ($ctx.Skipped)  { $note += "$($ctx.Skipped.ToString('N0')) skipped (no id / required columns)" }
    if ($ctx.Dangling) { $note += "$($ctx.Dangling.ToString('N0')) dangling (unknown resource or principal id)" }
    $colour = if ($ctx.Dangling -or $ctx.Skipped) { 'Yellow' } else { 'Gray' }
    Write-Host "  $($rows.ToString('N0')) rows read in $([Math]::Round($sw.Elapsed.TotalSeconds))s$(if ($note) { ' — ' + ($note -join ', ') })" -ForegroundColor $colour
    if ($rows -gt 0 -and $ctx.Skipped -eq $rows) {
        Write-Host "  WARNING: every row was skipped — check that the statement returns the required columns for '$($Slot.target)'" -ForegroundColor Red
    }
    $State.Totals[$Slot.name] = @{ target = $Slot.target; rows = $rows; sent = $sent; skipped = $ctx.Skipped; dangling = $ctx.Dangling }
    return $State.Totals[$Slot.name]
}

# Full sync only: remove every row of each fed scope that this run did not touch.
function Invoke-SqlReconcile {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State)
    if ($State.SyncMode -ne 'full') {
        Write-Host "`nDelta sync — stale rows are kept" -ForegroundColor Gray
        return 0
    }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Reconciling rows not seen since $($State.ServerTime)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Reconciling stale rows' -Pct 90
    $deleted = 0
    foreach ($s in $State.Scopes) {
        $deleted += Invoke-CrawlerReconcile -Endpoint $s.Endpoint -SystemId $State.SystemId -Scope $s.Scope -Before $State.ServerTime
    }
    return $deleted
}

function Complete-SqlRun {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [datetime]$SyncStart)
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
    try { Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null; Write-Host "`nViews refreshed" -ForegroundColor Green }
    catch { Write-Host "`nView refresh failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow }
    $elapsed = (Get-Date) - $SyncStart
    Write-Host "`n=== SQL sync complete in $([Math]::Round($elapsed.TotalSeconds))s ===" -ForegroundColor Green
    foreach ($e in $State.Totals.GetEnumerator()) {
        Write-Host ("  {0,-32} {1,12:N0} rows  {2,12:N0} sent" -f $e.Key, $e.Value.rows, $e.Value.sent) -ForegroundColor Gray
    }
    try {
        Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{ syncType = 'SQL-Crawl'; startTime = $SyncStart.ToString('o'); endTime = (Get-Date).ToString('o'); status = 'Success'; systemId = $State.SystemId } | Out-Null
    } catch { Write-Host "  sync-log write failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow }
    Update-CrawlerProgress -Step 'Complete' -Pct 100
}

#endregion Phases
