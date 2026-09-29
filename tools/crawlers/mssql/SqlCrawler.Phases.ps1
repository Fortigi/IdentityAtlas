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

# `systems` runs first: everything after it may name one of the systems it
# creates, and a row cannot be routed to a system that does not exist yet.
$script:SqlTargetOrder = @('systems', 'identities', 'principals', 'resources', 'contexts', 'identity-members', 'context-members', 'assignments', 'relationships')
$script:SqlBufferedTargets = @('systems', 'contexts', 'context-members')

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
        [string]$SyncMode = 'full',
        [string]$SystemType = 'SQL',
        [string]$Tenant = '',
        [int]$OverlapSeconds = 900,
        [int]$SweepIntervalHours = 24,
        [double]$SweepMaxDeleteShare = 0.05
    )
    $targets = @($Slots | Where-Object { $_.enabled } | ForEach-Object { $_.target })
    return @{
        SystemId        = $SystemId
        # The namespace for EVERY batch of this run, whichever system the batch
        # is addressed to — never per system. A reference is resolved in the
        # namespace of the batch carrying it, so a per-system namespace would
        # break every assignment that spans two systems, silently. The value is
        # unchanged from the single-system crawler, so existing ids are stable.
        # SqlCrawler.Systems.ps1 → "One namespace per run".
        IdPrefix        = "sql-$SystemId"
        SystemType      = $SystemType
        Tenant          = $Tenant
        ServerTime      = $ServerTime
        BatchSize       = $BatchSize
        PageSize        = $PageSize
        CommandTimeout  = $CommandTimeout
        SyncMode        = $SyncMode
        # external id -> the system that emitted it. The system is what makes a
        # cross-system duplicate visible (Add-SqlKnownKey); membership alone is
        # what the dangling checks ask about.
        KnownResources  = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::Ordinal)
        KnownPrincipals = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::Ordinal)
        # employee number -> the account key that account is stored under. A
        # catalogue names a person the way people are named on paper; principals
        # are keyed on the directory's own id. See Resolve-SqlContextOwner.
        PrincipalsByEmployeeId = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        # What the ownership columns produced across the run (one tally, however
        # many statements ask for owners). SqlCrawler.Ownership.ps1.
        Ownership       = New-SqlOwnershipTally
        HasResources    = ($targets -contains 'resources')
        HasPrincipals   = ($targets -contains 'identities' -or $targets -contains 'principals')
        # Did every resources statement read its complete set this run? A key
        # sweep places each swept pair in its resource's system, so a windowed
        # resources statement leaves it unable to do that (SqlCrawler.Sweep.ps1).
        ResourcesComplete = $true
        Scopes          = [System.Collections.Generic.List[hashtable]]::new()
        Contexts        = New-SqlContextCatalog
        Systems         = New-SqlSystemCatalog
        SystemReport    = $null
        # (endpoint, scope) -> what the source said, for Test-SqlRunCounts.
        Expect          = @{}
        # One entry per statement: rows read against rows the source returns.
        Reads           = [System.Collections.Generic.List[hashtable]]::new()
        # One entry per WATERMARKED statement: where it read from and how far it
        # got. Written back only after the run verifies (Save-SqlWatermarks).
        Deltas          = [System.Collections.Generic.List[hashtable]]::new()
        OverlapMs       = [long]$OverlapSeconds * 1000
        SweepIntervalHours  = $SweepIntervalHours
        SweepMaxDeleteShare = $SweepMaxDeleteShare
        Sweeps          = [System.Collections.Generic.List[hashtable]]::new()
        Verification    = $null
        ContextReport   = $null
        Totals          = [ordered]@{}
    }
}

function Get-SqlScopeKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [string]$Endpoint, [hashtable]$Scope = @{})
    return $Endpoint + '|' + (($Scope.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ';')
}

# Remember a (system, endpoint, scope) for the end-of-run reconcile — once,
# however many slots feed it. The system is part of the key because the
# reconcile is per system: one call per system a scope was fed into, or the
# systems left out keep rows this run no longer has.
#
# -Complete says this feed read the source's COMPLETE set rather than a window.
# The timestamp reconcile removes what the run did not touch, which is only a
# removal when everything that survives was touched — so a scope may reconcile
# in any run, delta included, as long as EVERY slot feeding it was complete.
# One windowed slot makes the whole scope unreconcilable, which is why this ANDs
# rather than overwrites.
function Add-SqlReconcileScope {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [string]$Endpoint, [hashtable]$Scope = @{},
          [int]$SystemId = 0, [bool]$Complete = $true)
    $key = "$SystemId|" + (Get-SqlScopeKey -Endpoint $Endpoint -Scope $Scope)
    $existing = @($State.Scopes | Where-Object { $_.Key -eq $key })
    if ($existing.Count -gt 0) {
        if (-not $Complete) { $existing[0].Complete = $false }
        return
    }
    $State.Scopes.Add(@{ Key = $key; Endpoint = $Endpoint; Scope = $Scope; SystemId = $SystemId; Complete = $Complete })
}

#endregion Run state

#region Streams per slot

# One role of a slot: where its records go, and the streams opened for it — one
# per system the slot turns out to feed, created on the first row that needs it.
# A slot that routes nothing therefore opens exactly the one stream it always did.
function New-SqlStreamSpec {
    [CmdletBinding()]
    param([hashtable]$State, [string]$Endpoint, [hashtable]$Scope = @{}, [string[]]$KeyFields = @('externalId'),
          [switch]$Reconcile, [switch]$Keyed, [bool]$Complete = $true)
    $expect = $null
    if ($Reconcile) {
        # Every reconciled scope is also verified at the end of the run. The
        # expectation spans the scope's SYSTEMS (the reconcile does not): the
        # source's own counts are per statement, not per system, so the only
        # honest comparison sums the database's rows over the systems fed.
        $expect = Get-SqlExpectation -State $State -Key (Get-SqlScopeKey -Endpoint $Endpoint -Scope $Scope) -Endpoint $Endpoint -Scope $Scope -Keyed:$Keyed
        $expect.Slots++
    }
    return @{ Endpoint = $Endpoint; Scope = $Scope; KeyFields = $KeyFields; Reconcile = [bool]$Reconcile
              Complete = $Complete; Expect = $expect
              Streams = [System.Collections.Generic.Dictionary[int, object]]::new() }
}

# The stream one role uses for one system, opened the first time that system
# appears. Registering the reconcile scope here — rather than when the slot
# starts — is what stops a run reconciling a system it never wrote a row to.
function Get-SqlSlotStream {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [Parameter(Mandatory)] [string]$Role, [int]$SystemId = 0)
    $spec = $Ctx.Streams[$Role]
    $stream = $null
    if ($spec.Streams.TryGetValue($SystemId, [ref]$stream)) { return $stream }
    $state = $Ctx.State
    $stream = New-CrawlerIngestStream -Endpoint $spec.Endpoint -SystemId $SystemId -IdPrefix $state.IdPrefix `
        -Scope $spec.Scope -BatchSize $state.BatchSize -KeyFields $spec.KeyFields
    if ($spec.Reconcile) {
        Add-SqlReconcileScope -State $state -Endpoint $spec.Endpoint -Scope $spec.Scope -SystemId $SystemId -Complete $spec.Complete
        [void]$spec.Expect.Systems.Add($SystemId)
    }
    $spec.Streams[$SystemId] = $stream
    return $stream
}

# The ingest streams a slot feeds, by role. Identities and identity-members are
# cross-system tables (no systemId) and are never reconciled — same rule as
# midPoint and CSV — so they are never routed either.
function New-SqlSlotStreams {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$State, [bool]$Complete = $true)
    $memberKeys = @('identityExternalId', 'principalExternalId')
    switch ($Slot.target) {
        'identities' {
            return @{
                identity  = New-SqlStreamSpec -State $State -Endpoint 'ingest/identities'
                principal = New-SqlStreamSpec -State $State -Endpoint 'ingest/principals' -Scope @{ principalType = $Slot.principalType } -Reconcile -Complete $Complete
                member    = New-SqlStreamSpec -State $State -Endpoint 'ingest/identity-members' -KeyFields $memberKeys
            }
        }
        'principals' {
            return @{
                principal = New-SqlStreamSpec -State $State -Endpoint 'ingest/principals' -Scope @{ principalType = $Slot.principalType } -Reconcile -Complete $Complete
                member    = New-SqlStreamSpec -State $State -Endpoint 'ingest/identity-members' -KeyFields $memberKeys
            }
        }
        'identity-members' { return @{ member = New-SqlStreamSpec -State $State -Endpoint 'ingest/identity-members' -KeyFields $memberKeys } }
        'resources' {
            $streams = @{ resource = New-SqlStreamSpec -State $State -Endpoint 'ingest/resources' -Scope @{ resourceType = $Slot.resourceType } -Reconcile -Complete $Complete }
            # The ownership scopes are derived from the SAME statement, so they
            # read exactly as much of the source as it did: a windowed resources
            # statement leaves them windowed too, and none of them may reconcile.
            if ($Slot.ownership) { foreach ($e in (New-SqlOwnershipStreams -State $State -Complete $Complete).GetEnumerator()) { $streams[$e.Key] = $e.Value } }
            return $streams
        }
        'assignments' {
            $scope = Get-SqlAssignmentScope -Slot $Slot
            return @{ assignment = New-SqlStreamSpec -State $State -Endpoint 'ingest/resource-assignments' -Scope $scope -KeyFields @('resourceExternalId', 'principalExternalId') -Reconcile -Complete $Complete }
        }
        # Buffered, not streamed: sent whole by Send-SqlSlotBuffer when the slot ends.
        { $_ -in $script:SqlBufferedTargets } { return @{} }
        'relationships' {
            return @{ relationship = New-SqlStreamSpec -State $State -Endpoint 'ingest/resource-relationships' -Scope @{ relationshipType = $Slot.relationshipType } -KeyFields @('parentExternalId', 'childExternalId') -Reconcile -Complete $Complete }
        }
    }
    throw "No streams for target '$($Slot.target)'"
}

# The one definition of an assignment slot's partition: the reconcile scope, the
# stage's scope and the sweep's scope are the same three columns, and a second
# spelling of it would let a sweep delete a neighbouring statement's rows.
function Get-SqlAssignmentScope {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)] [hashtable]$Slot)
    return @{ assignmentType = $Slot.assignmentType; resourceType = $Slot.resourceType; governed = [bool]$Slot.governed }
}

#endregion Streams per slot

#region Row handlers

# Each handler shapes one row for its target and buffers the record(s), or
# counts the row as skipped (unusable) / dangling (names an id this run has not
# seen). $Ctx: Slot, Map, Streams, State, Skipped, Dangling.

# Index an account by its employee number so a catalogue that names its owner
# that way can be resolved to the account key (SqlCrawler.Contexts.ps1).
# First one wins: two accounts sharing an employee number is a defect in the
# source, and choosing a different one each run would make the owner flap
# between two people for no reason the reader could see.
function Register-SqlPrincipalAlias {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Record, [Parameter(Mandatory)] [hashtable]$State)
    $employeeId = ([string]$Record.employeeId).Trim()
    if (-not $employeeId) { return }
    if ($State.PrincipalsByEmployeeId.ContainsKey($employeeId)) { return }
    $State.PrincipalsByEmployeeId[$employeeId] = [string]$Record.externalId
}

function Add-SqlIdentityRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $identity = ConvertTo-SqlIdentityRecord -Row $Row -Map $Ctx.Map
    if (-not $identity) { $Ctx.Skipped++; return }
    $principal = ConvertTo-SqlPrincipalRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    # Identities and the link to their accounts have no systemId column at all,
    # so they are never routed: one stream, the crawler's own system.
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'identity' -SystemId $Ctx.State.SystemId) -Record $identity
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'principal' -SystemId $Ctx.State.SystemId) -Record $principal
    Add-SqlExpectedKey -Expectation $Ctx.Streams.principal.Expect -Key $identity.externalId
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'member' -SystemId $Ctx.State.SystemId) `
        -Record (New-SqlIdentityMemberRecord -IdentityId $identity.externalId -PrincipalId $identity.externalId)
    Add-SqlKnownKey -Known $Ctx.State.KnownPrincipals -Key $identity.externalId -SystemId $Ctx.State.SystemId -Catalog $Ctx.State.Systems
    Register-SqlPrincipalAlias -Record $principal -State $Ctx.State
}

function Add-SqlPrincipalRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $principal = ConvertTo-SqlPrincipalRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $principal) { $Ctx.Skipped++; return }
    $sid = Get-SqlRowSystemId -Ctx $Ctx -Row $Row
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'principal' -SystemId $sid) -Record $principal
    Add-SqlExpectedKey -Expectation $Ctx.Streams.principal.Expect -Key $principal.externalId
    Add-SqlKnownKey -Known $Ctx.State.KnownPrincipals -Key $principal.externalId -SystemId $sid -Catalog $Ctx.State.Systems
    Register-SqlPrincipalAlias -Record $principal -State $Ctx.State
    $identityId =([string](Get-SqlMapped -Row $Row -Map $Ctx.Map -Name 'identityId')).Trim()
    if ($identityId) {
        Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'member' -SystemId $Ctx.State.SystemId) `
            -Record (New-SqlIdentityMemberRecord -IdentityId $identityId -PrincipalId $principal.externalId -IsPrimary $false -AccountType 'Linked')
    }
}

function Add-SqlMemberRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = ConvertTo-SqlIdentityMemberRecord -Row $Row -Map $Ctx.Map
    if (-not $rec) { $Ctx.Skipped++; return }
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'member' -SystemId $Ctx.State.SystemId) -Record $rec
}

function Add-SqlResourceRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = ConvertTo-SqlResourceRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $rec) { $Ctx.Skipped++; return }
    $sid = Get-SqlRowSystemId -Ctx $Ctx -Row $Row
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'resource' -SystemId $sid) -Record $rec
    Add-SqlExpectedKey -Expectation $Ctx.Streams.resource.Expect -Key $rec.externalId
    Add-SqlKnownKey -Known $Ctx.State.KnownResources -Key $rec.externalId -SystemId $sid -Catalog $Ctx.State.Systems
    if ($Ctx.Slot.ownership) { Add-SqlOwnershipRow -Row $Row -Ctx $Ctx -Resource $rec -SystemId $sid }
}

function Add-SqlAssignmentRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = ConvertTo-SqlAssignmentRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $rec) { $Ctx.Skipped++; return }
    $st = $Ctx.State
    if (($st.HasResources -and -not $st.KnownResources.ContainsKey($rec.resourceExternalId)) -or
        ($st.HasPrincipals -and -not $st.KnownPrincipals.ContainsKey($rec.principalExternalId))) {
        $Ctx.Dangling++; return
    }
    # An assignment belongs to whatever grants it, so by default it inherits its
    # RESOURCE's system — which is why the largest statement in the source needs
    # no extra join to be routed. Its principal may live anywhere; the run's one
    # id namespace is what lets the two halves still meet.
    $sid = Get-SqlRowSystemId -Ctx $Ctx -Row $Row -Ref $rec.resourceExternalId
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'assignment' -SystemId $sid) -Record $rec
}

function Add-SqlRelationshipRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = ConvertTo-SqlRelationshipRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot
    if (-not $rec) { $Ctx.Skipped++; return }
    $known = $Ctx.State.KnownResources
    if ($Ctx.State.HasResources -and -not ($known.ContainsKey($rec.parentExternalId) -and $known.ContainsKey($rec.childExternalId))) {
        $Ctx.Dangling++; return
    }
    # A composition edge belongs with its parent — a role's system, not the
    # system of whichever connector the entitlement it contains came from.
    $sid = Get-SqlRowSystemId -Ctx $Ctx -Row $Row -Ref $rec.parentExternalId
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'relationship' -SystemId $sid) -Record $rec
    Add-SqlExpectedKey -Expectation $Ctx.Streams.relationship.Expect -Key "$($rec.parentExternalId)|$($rec.childExternalId)"
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
        'contexts'         { return 'Add-SqlContextRow' }
        'context-members'  { return 'Add-SqlContextMemberRow' }
        'systems'          { return 'Add-SqlSystemRow' }
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
    return @{ systemId = $id; serverTime = $serverTime; displayName = $displayName; tenantId = $tenantId }
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
        # Decided once per statement, not per row: at tens of millions of rows a
        # per-row decision is minutes spent re-deriving a constant.
        $ctx.Route = Get-SqlRouteMode -Map $ctx.Map -Target $ctx.Slot.target -Routing (Test-SqlSystemRouting -Catalog $ctx.State.Systems)
        if ($ctx.Delta) { Resolve-SqlWatermarkColumn -Delta $ctx.Delta -Columns @($Row.Keys) }
    }
    if ($ctx.Delta) { Update-SqlWatermark -Delta $ctx.Delta -Row $Row }
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

# The order a slot's streams must be flushed in: a role is listed AFTER
# everything its records point at. An unlisted role flushes last, in whatever
# order the hashtable gives.
#
# This is not cosmetic. `IdentityMembers.identityId` has a real foreign key, and
# a slot's final, PARTIAL batch is only sent here — the full batches before it
# went out from Add-CrawlerIngestStreamRecord as they filled, in the order the
# records were added, which is already correct. So the last batch of an
# `identities` statement was the one at risk, and it is exactly the batch that
# holds a first run's remainder. Flushed member-first, it inserted links to
# identities that did not exist yet: "insert or update on table IdentityMembers
# violates foreign key constraint IdentityMembers_identityId_fkey".
#
# It stayed hidden because a hashtable's enumeration order is arbitrary but
# STABLE, and because every scenario that hit the bad order happened to be
# re-running over identities a previous run had already created — an UPDATE has
# nothing to violate. A brand-new person in a batch that never fills is what
# makes it fire. (The shipped presets use the `principals` target, which emits a
# member only for a row carrying an identityId, which is why no field run hit it.)
#
# Nothing else here has a foreign key — ResourceAssignments and
# ResourceRelationships deliberately have none, and their cross-references are
# derived from external ids rather than looked up, so their content is right
# whatever the order. They are ordered anyway: an order that is correct only
# because the database does not check it is a trap for the next person.
$script:SqlStreamFlushOrder = @(
    'identity', 'principal', 'member',
    'resource', 'ownershipResource', 'ownershipRelationship', 'ownershipAssignment',
    'relationship', 'assignment'
)

# Flush every stream a slot opened — one per (role, system) — and return the
# total records sent.
function Complete-SqlSlotStreams {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$Ctx)
    $sent = 0
    foreach ($role in (Get-SqlFlushOrder -Roles @($Ctx.Streams.Keys))) {
        foreach ($s in $Ctx.Streams[$role].Streams.Values) { $sent += (Complete-CrawlerIngestStream -Stream $s).sent }
    }
    return $sent
}

# A slot's roles in dependency order. A role the order does not name keeps its
# place at the end rather than being dropped — a new role must never stop being
# flushed just because nobody added it to the list.
function Get-SqlFlushOrder {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string[]]$Roles = @())
    $known = @($script:SqlStreamFlushOrder | Where-Object { $_ -in $Roles })
    return @($known) + @($Roles | Where-Object { $_ -notin $script:SqlStreamFlushOrder })
}

# How many systems a slot's rows were spread over.
function Get-SqlSlotSystemCount {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$Ctx)
    return @($Ctx.Streams.Values | ForEach-Object { $_.Streams.Keys } | Sort-Object -Unique).Count
}

# The one line a finished statement writes, and the warning that follows when it
# produced nothing usable at all.
function Write-SqlSlotSummary {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [long]$Rows = 0, [double]$Seconds = 0, [int]$Systems = 1)
    $note = @()
    if ($Ctx.Skipped)    { $note += "$($Ctx.Skipped.ToString('N0')) skipped (no id / required columns)" }
    # Deliberately not worded as a problem, and deliberately not part of the
    # colour below: most entitlements belonging to no logical application is
    # what a healthy source looks like. Reading as an error is what kept this
    # hidden inside the "skipped (no id / required columns)" count.
    if ($Ctx.Unreferenced) { $note += "$($Ctx.Unreferenced.ToString('N0')) naming no context" }
    if ($Ctx.Dangling)   { $note += "$($Ctx.Dangling.ToString('N0')) dangling (unknown resource or principal id)" }
    if ($Ctx.Unresolved) { $note += "$($Ctx.Unresolved.ToString('N0')) without a known context" }
    if ($Ctx.Misrouted)  { $note += "$($Ctx.Misrouted.ToString('N0')) naming an unknown system" }
    $colour = if ($Ctx.Dangling -or $Ctx.Skipped -or $Ctx.Misrouted) { 'Yellow' } else { 'Gray' }
    Write-Host "  $($Rows.ToString('N0')) rows read in $([Math]::Round($Seconds))s$(if ($Systems -gt 1) { " across $Systems systems" })$(if ($note) { ' — ' + ($note -join ', ') })" -ForegroundColor $colour
    if ($Rows -gt 0 -and $Ctx.Skipped -eq $Rows) {
        Write-Host "  WARNING: every row was skipped — check that the statement returns the required columns for '$($Ctx.Slot.target)'" -ForegroundColor Red
    }
}

function Invoke-SqlSlot {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [AllowNull()] $Connection, [Parameter(Mandatory)] [hashtable]$State, [int]$Pct = 10)
    # The watermark is read BEFORE the statement runs, so @Since is the mark the
    # last verified run left — not one this run is still moving.
    $delta = New-SqlDeltaState -Slot $Slot -State $State
    if ($delta) { $State.Deltas.Add($delta) }
    $window = if ($delta -and $delta.Windowed) { " (since $($delta.Since))" } else { '' }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] $($Slot.name) → $($Slot.target)$(if ($Slot.paged) { ' (paged)' })$window" -ForegroundColor Cyan
    Update-CrawlerProgress -Step "Query: $($Slot.name)" -Pct $Pct
    $complete = -not ($delta -and $delta.Windowed)
    if ($Slot.target -eq 'resources' -and -not $complete) { $State.ResourcesComplete = $false }
    $ctx = @{ Slot = $Slot; Map = $null; Streams = (New-SqlSlotStreams -Slot $Slot -State $State -Complete $complete); State = $State
              # Rows that arrived intact but carried no value in an OPTIONAL
              # reference column, so there was nothing to place them against.
              # Deliberately NOT one of the tallies on the next line: those are
              # what Add-SqlReadCheck folds into the unplaced bound, and an
              # absent optional reference is a fact about the source rather than
              # a row this statement failed to place. Skipped is for a REQUIRED
              # column being absent. See Add-SqlContextMemberRow, the only
              # handler with an optional reference today.
              Unreferenced = 0
              Delta = $delta; Complete = $complete
              Route = 'fixed'; Rows = 0; Skipped = 0; Dangling = 0; Unresolved = 0; Misrouted = 0
              # What the source held when the read started — the other end of the
              # band Add-SqlReadCheck judges the read against. A live source is
              # aggregated while it is read, so one count taken afterwards is a
              # different question from the one the read answered.
              SourceBefore = $null
              # This statement's own owner tally, folded into the run's at the end.
              Ownership = (New-SqlOwnershipTally) }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # Inside the stopwatch: the counts are part of what this statement costs.
    $ctx.SourceBefore = Get-SqlSourceRowsBefore -Ctx $ctx -Connection $Connection
    $rows = Invoke-SqlQueryStream -Connection $Connection -Sql $Slot.sql -OnRow (New-SqlRowCallback -Ctx $ctx -Handler (Get-SqlRowHandler -Target $Slot.target)) `
        -CommandTimeout $State.CommandTimeout -Paged $Slot.paged -PageSize $State.PageSize -Since $(if ($delta) { $delta.Since } else { $null })
    $sent = Complete-SqlSlotStreams -Ctx $ctx
    if ($Slot.target -in $script:SqlBufferedTargets) { $sent += Send-SqlSlotBuffer -Slot $Slot -State $State }
    Add-SqlReadCheck -Ctx $ctx -Connection $Connection -Rows $rows
    $sw.Stop()
    $systems = Get-SqlSlotSystemCount -Ctx $ctx
    Write-SqlSlotSummary -Ctx $ctx -Rows $rows -Seconds $sw.Elapsed.TotalSeconds -Systems $systems
    $ownership = $null
    if ($Slot.ownership) {
        $ownership = Get-SqlOwnershipReport -Tally $ctx.Ownership
        Write-SqlOwnershipReport -Report $ownership
        Join-SqlOwnershipTally -Into $State.Ownership -From $ctx.Ownership
    }
    $State.Totals[$Slot.name] = @{ target = $Slot.target; rows = $rows; sent = $sent; skipped = $ctx.Skipped
                                   unreferenced = $ctx.Unreferenced
                                   dangling = $ctx.Dangling; unresolved = $ctx.Unresolved; misrouted = $ctx.Misrouted
                                   systems = $systems; complete = $complete; ownership = $ownership }
    return $State.Totals[$Slot.name]
}

# What a buffered target sends when its statement ends: a systems catalogue is
# registered, a context catalogue or its memberships are sent as one full sync.
function Send-SqlSlotBuffer {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$State)
    if ($Slot.target -ne 'systems') { return Send-SqlContextBuffer -Slot $Slot -State $State }
    $sent = Register-SqlSystemCatalog -State $State
    $State.SystemReport = Get-SqlSystemReport -Catalog $State.Systems
    Write-SqlSystemReport -Report $State.SystemReport
    return $sent
}

# Remove every row of each fed (system, scope) that this run did not touch. One
# call per system a scope was written to — a scope reconciled against the
# crawler's own system alone would leave every routed system's stale rows in
# place, and reconciling a system this run never wrote to would empty it.
#
# COMPLETENESS, not run mode, decides. The reconcile deletes what a run did not
# touch, which is only a removal when everything still in the source WAS
# touched. That is true of a statement that read its complete set — whether the
# run called itself full or delta. So a delta run keeps its small tables (the
# catalogue, the roles, the role assignments: read in full in seconds) exact
# without a key sweep, while a windowed statement's scope is left alone, because
# there every untouched row is simply one that did not change.
function Invoke-SqlReconcile {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State)
    $complete = @($State.Scopes | Where-Object { $_.Complete })
    $windowed = @($State.Scopes).Count - $complete.Count
    if ($complete.Count -eq 0) {
        Write-Host "`nNo scope read its complete set — stale rows are kept (a key sweep is what removes them)" -ForegroundColor Gray
        return 0
    }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Reconciling rows not seen since $($State.ServerTime)$(if ($windowed) { " ($windowed windowed scope(s) skipped)" })..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Reconciling stale rows' -Pct 90
    $deleted = 0
    foreach ($s in $complete) {
        $sid = if ($s.SystemId -gt 0) { $s.SystemId } else { $State.SystemId }
        $deleted += Invoke-CrawlerReconcile -Endpoint $s.Endpoint -SystemId $sid -Scope $s.Scope -Before $State.ServerTime
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
