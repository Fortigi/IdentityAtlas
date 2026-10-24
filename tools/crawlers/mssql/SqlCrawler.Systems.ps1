<#
.SYNOPSIS
    The `systems` target and per-row routing for the SQL Database crawler: one
    Identity Atlas system per technical connector in the source, and every
    resource, principal, assignment and relationship addressed to the right one.

.DESCRIPTION
    Dot-sourced after SqlCrawler.Transform.ps1. A source that is itself an
    aggregator — IdentityIQ, with one `spt_application` row per connected system —
    should not arrive as one flat Identity Atlas system. A `systems` statement
    creates one system per source connector; the other statements name the system
    each row belongs to, exactly as the CSV crawler's Systems.csv plus the
    SystemName column do.

    ONE NAMESPACE PER RUN
    ---------------------
    Deterministic ids are MD5("<namespace>:<externalId>"), and a cross-entity
    reference (principalExternalId, resourceExternalId, memberExternalId …) is
    resolved by the API in the namespace of the BATCH THAT CARRIES IT. So the
    namespace cannot be per system: the customer's people live in the directory
    system, their entitlements in the connector systems, and every grant spans
    the two. Hashed in different namespaces the two halves of that grant match
    nothing — and nothing complains, because ResourceAssignments has no foreign
    key on either column. The row lands pointing at ids no row holds and the
    matrix simply never shows it.

    The namespace is therefore the RUN's: "sql-<the crawler's own system id>",
    used for every batch whatever system that batch is addressed to. That value
    is byte-for-byte what a single-system run has always used, so an existing
    installation re-crawled after this change writes the same ids to the same
    rows — no churn, no migration, nothing reconciled away. See the paired tests
    in app/api/src/ingest/normalization.test.js ("cross-system references") and
    test/unit/SqlCrawlerSystems.Tests.ps1.

    THE PRICE OF ONE NAMESPACE
    --------------------------
    External ids must be unique across every system of the run: two connectors
    using the same entitlement id would hash to one Atlas row and overwrite each
    other. IdentityIQ ids are globally unique, so this is safe there. It is not
    assumed: Add-SqlKnownKey records every id that two systems claim and
    Test-SqlRunCounts fails the run naming them.
#>

#region Catalogue

$script:SqlSystemSampleSize = 10

function New-SqlSystemCatalog {
    [CmdletBinding()]
    param()
    $ord = [System.StringComparer]::Ordinal
    return @{
        # The registration records that have no Atlas id yet, and their keys, in order.
        Pending    = [System.Collections.Generic.List[object]]::new()
        PendingKeys = [System.Collections.Generic.List[string]]::new()
        # catalogue key -> Atlas system id
        ByKey      = [System.Collections.Generic.Dictionary[string, int]]::new($ord)
        # normalised display name -> catalogue key
        ByName     = [System.Collections.Generic.Dictionary[string, string]]::new($ord)
        Ambiguous  = [System.Collections.Generic.HashSet[string]]::new($ord)
        Duplicates = [System.Collections.Generic.List[string]]::new()
        Names      = [System.Collections.Generic.Dictionary[string, string]]::new($ord)  # key -> display name
        # a system reference no statement created -> how many rows named it
        Unknown    = [System.Collections.Generic.Dictionary[string, int]]::new($ord)
        # external id -> the systems that claimed it, when more than one did
        Collisions = [System.Collections.Generic.Dictionary[string, object]]::new($ord)
        CollisionRows = [long]0
    }
}

# Whether this run routes at all. Everything downstream is a no-op until a
# `systems` statement has created something to route to, which is what keeps a
# single-system configuration on exactly the path it was on before.
function Test-SqlSystemRouting {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] [hashtable]$Catalog)
    return $Catalog.ByKey.Count -gt 0 -or $Catalog.Pending.Count -gt 0
}

#endregion Catalogue

#region The systems target

# One systems-target row -> the registration record, or $null when the row has
# no usable name. The catalogue key is the row's `id` when it has one (a stable
# reference survives a rename) and otherwise its normalised name — the same rule
# the context catalogue uses.
#
# tenantId is what the ingest upserts a system ON, together with systemType. It
# is derived from the crawler's own tenant plus the source key, so: re-running
# finds the same row rather than adding a copy; a renamed connector keeps its
# system; and two SQL crawlers reading two databases can both have an "HR" and
# not collide. A statement that returns its own tenantId column wins — an
# operator who knows the connector's real tenant should be able to say so.
function ConvertTo-SqlSystemRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Row,
        [Parameter(Mandatory)] [hashtable]$Map,
        [Parameter(Mandatory)] [hashtable]$Slot,
        [Parameter(Mandatory)] [hashtable]$State
    )
    $display = Get-SqlDisplayName -Row $Row -Map $Map -Fallbacks @('name')
    if (-not $display) { return $null }
    $id  = ([string](Get-SqlMapped -Row $Row -Map $Map -Name 'id')).Trim()
    $key = if ($id) { $id } else { ConvertTo-SqlNameKey $display }
    $type = ([string](Get-SqlMapped -Row $Row -Map $Map -Name 'systemType')).Trim()
    if (-not $type) { $type = $Slot.systemType }
    if (-not $type) { $type = $State.SystemType }
    $tenant = ([string](Get-SqlMapped -Row $Row -Map $Map -Name 'tenantId')).Trim()
    if (-not $tenant) { $tenant = "$($State.Tenant)/$key".ToLowerInvariant() }
    $rec = [ordered]@{
        systemType  = $type
        displayName = $display
        tenantId    = $tenant
        enabled     = Get-SqlEnabledFlag -Row $Row -Map $Map
        syncEnabled = $true
    }
    $desc = Get-SqlMapped -Row $Row -Map $Map -Name 'description'
    if ($null -ne $desc -and [string]$desc -ne '') { $rec['description'] = [string]$desc }
    $ext = Get-SqlExtendedAttributes -Row $Row -Map $Map
    if ($ext) { $rec['extendedAttributes'] = $ext }
    return @{ key = $key; record = $rec; displayName = $display }
}

# Buffer one systems-target row. A repeated key is counted and the first one
# kept — choosing a different winner each run would move a connector's whole
# inventory from one system to another for no reason a reader could see.
function Add-SqlSystemRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $shaped = ConvertTo-SqlSystemRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot -State $Ctx.State
    if (-not $shaped) { $Ctx.Skipped++; return }
    $catalog = $Ctx.State.Systems
    if ($catalog.Names.ContainsKey($shaped.key)) { $catalog.Duplicates.Add($shaped.key); $Ctx.Skipped++; return }
    $catalog.Names[$shaped.key] = $shaped.displayName
    $catalog.Pending.Add($shaped.record)
    $catalog.PendingKeys.Add($shaped.key)
    # Two entries whose names fold together make that name ambiguous: a row
    # naming it cannot be placed, and says so, rather than landing in either.
    $name = ConvertTo-SqlNameKey $shaped.displayName
    if ($catalog.ByName.ContainsKey($name) -and $catalog.ByName[$name] -ne $shaped.key) { [void]$catalog.Ambiguous.Add($name) }
    else { $catalog.ByName[$name] = $shaped.key }
}

# Register every buffered system and learn its Atlas id. Returns the number sent.
#
# A delta upsert, never a full sync: ingest/systems coerces 'full' to 'delta'
# anyway (a full sync there would treat the batch as every system there is and
# cascade-delete the rest), so a connector that disappears from the source leaves
# its system behind, empty, rather than taking its history with it.
function Register-SqlSystemCatalog {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$State)
    $catalog = $State.Systems
    if ($catalog.Pending.Count -eq 0) { return 0 }
    $records = @($catalog.Pending)
    $r = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{ syncMode = 'delta'; records = $records }
    $ids = @($r.systemIds)
    # Positional, so a short answer must fail rather than mis-map: the ids come
    # back one per record IN ORDER, and a lookup that found nothing is simply
    # left out of the array (app/api/src/routes/ingest/helpers.js). Mapping the
    # remainder by position would then point each system at its neighbour's rows.
    if ($ids.Count -ne $records.Count) {
        throw "Registered $($records.Count) system(s) but the API returned $($ids.Count) id(s); refusing to guess which is which"
    }
    for ($i = 0; $i -lt $records.Count; $i++) { $catalog.ByKey[$catalog.PendingKeys[$i]] = [int]$ids[$i] }
    Write-Host "  $($records.Count) system(s) registered: $((@($catalog.PendingKeys) | Select-Object -First 5) -join ', ')$(if ($records.Count -gt 5) { ', …' })" -ForegroundColor Gray
    $catalog.Pending.Clear()
    $catalog.PendingKeys.Clear()
    return $records.Count
}

#endregion The systems target

#region Routing

# How a slot's rows find their system, decided ONCE per statement rather than
# per row — at tens of millions of rows a per-row decision is minutes of nothing.
#
#   fixed     the crawler's own system. No routing configured, or the target has
#             no system of its own (identities and identity-members are
#             cross-system tables with no systemId column at all).
#   column    the statement names it, in systemId (the source's own key for the
#             connector) or systemName.
#   resource  an assignment belongs to whatever grants it, so it inherits its
#             resource's system. This is the default for assignments precisely
#             so the largest statement in the source needs no extra join.
#   parent    the same, for a relationship, from its parent resource.
$script:SqlRoutedTargets = @('principals', 'resources', 'assignments', 'relationships')

function Get-SqlRouteMode {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [string]$Target, [bool]$Routing = $false)
    if (-not $Routing -or $Target -notin $script:SqlRoutedTargets) { return 'fixed' }
    if ($Map.ContainsKey('systemId') -or $Map.ContainsKey('systemName')) { return 'column' }
    if ($Target -eq 'assignments')   { return 'resource' }
    if ($Target -eq 'relationships') { return 'parent' }
    return 'fixed'
}

# A row's system from the statement's own columns: the key first, then the name,
# folded the one way names are folded. 0 means the row named a system no
# statement created — never silently absorbed, always counted.
function Resolve-SqlRowSystem {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [hashtable]$Catalog, [int]$Default = 0)
    $key = ([string](Get-SqlMapped -Row $Row -Map $Map -Name 'systemId')).Trim()
    if ($key) {
        $sid = 0
        if ($Catalog.ByKey.TryGetValue($key, [ref]$sid)) { return $sid }
        $Catalog.Unknown[$key] = 1 + ($Catalog.Unknown[$key] ?? 0)
        return 0
    }
    $raw  = [string](Get-SqlMapped -Row $Row -Map $Map -Name 'systemName')
    $name = ConvertTo-SqlNameKey $raw
    # Neither column carries anything: the documented single-system case, which
    # is how a directory statement keeps its accounts in the crawler's own system.
    if (-not $name) { return $Default }
    if ($Catalog.Ambiguous.Contains($name) -or -not $Catalog.ByName.ContainsKey($name)) {
        $Catalog.Unknown[$raw] = 1 + ($Catalog.Unknown[$raw] ?? 0)
        return 0
    }
    return $Catalog.ByKey[$Catalog.ByName[$name]]
}

# The system one row is addressed to, by the slot's route mode. A row that names
# a system nothing created falls back to the crawler's own — the data is kept —
# and is counted as misrouted, which Get-SqlReadVerdict turns into a failure once
# it is more than a rounding error.
function Get-SqlRowSystemId {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [Parameter(Mandatory)] $Row, [string]$Ref = '')
    $st = $Ctx.State
    if ($Ctx.Route -eq 'column') {
        $sid = Resolve-SqlRowSystem -Row $Row -Map $Ctx.Map -Catalog $st.Systems -Default $st.SystemId
        if ($sid -gt 0) { return $sid }
        $Ctx.Misrouted++
        return $st.SystemId
    }
    if ($Ctx.Route -eq 'resource' -or $Ctx.Route -eq 'parent') {
        $sid = 0
        if ($Ref -and $st.KnownResources.TryGetValue($Ref, [ref]$sid)) { return $sid }
        return $st.SystemId
    }
    return $st.SystemId
}

# Remember the system an emitted id belongs to, and notice when a second system
# claims the same one. Both rows would hash to a single Atlas row in the run's
# namespace, so one silently replaces the other — the same defect the
# "rows > distinct ids" check already fails a run for, one level up.
function Add-SqlKnownKey {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [System.Collections.Generic.Dictionary[string, int]]$Known,
        [Parameter(Mandatory)] [string]$Key,
        [int]$SystemId = 0,
        [hashtable]$Catalog
    )
    $owner = 0
    if (-not $Known.TryGetValue($Key, [ref]$owner)) { $Known[$Key] = $SystemId; return }
    if ($owner -eq $SystemId -or -not $Catalog) { return }
    $Catalog.CollisionRows++
    if ($Catalog.Collisions.Count -lt $script:SqlSystemSampleSize) { $Catalog.Collisions[$Key] = "$owner and $SystemId" }
}

#endregion Routing

#region Report

# The routing facts, as plain numbers and samples. Pure given the catalogue.
function Get-SqlSystemReport {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Catalog)
    $n = $script:SqlSystemSampleSize
    $unknown = $Catalog.Unknown.GetEnumerator() | Sort-Object -Property @{ Expression = 'Value'; Descending = $true }, Key |
        Select-Object -First $n | ForEach-Object { "'$($_.Key)' ($($_.Value))" }
    return [ordered]@{
        systems           = $Catalog.ByKey.Count
        unknownSystems    = $Catalog.Unknown.Count
        unknownRows       = [long](($Catalog.Unknown.Values | Measure-Object -Sum).Sum)
        unknownSample     = @($unknown)
        ambiguousNames    = @($Catalog.Ambiguous | Select-Object -First $n)
        duplicateKeys     = @($Catalog.Duplicates | Select-Object -First $n)
        duplicateKeyCount = $Catalog.Duplicates.Count
        collisionRows     = $Catalog.CollisionRows
        collisionSample   = @($Catalog.Collisions.GetEnumerator() | ForEach-Object { "'$($_.Key)' in systems $($_.Value)" })
    }
}

function Write-SqlSystemReport {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Report)
    Write-Host "  Systems in the catalogue: $($Report.systems.ToString('N0'))" -ForegroundColor Gray
    if ($Report.duplicateKeyCount) { Write-Host "  $($Report.duplicateKeyCount) row(s) repeat a system key and were skipped: $($Report.duplicateKeys -join ', ')" -ForegroundColor Yellow }
    if ($Report.ambiguousNames.Count) { Write-Host "  Ambiguous system names (several entries fold to one): $($Report.ambiguousNames -join ', ')" -ForegroundColor Yellow }
    if ($Report.unknownSystems) {
        Write-Host "  $($Report.unknownRows.ToString('N0')) row(s) name $($Report.unknownSystems) system(s) no statement created, and were loaded into the crawler's own system instead:" -ForegroundColor Yellow
        foreach ($s in $Report.unknownSample) { Write-Host "    $s" -ForegroundColor Yellow }
    }
}

#endregion Report
