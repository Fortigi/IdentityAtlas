<#
.SYNOPSIS
    Omada crawler sync-phase orchestrators, extracted from Start-OmadaCrawler.ps1.

.DESCRIPTION
    Each Sync-Omada* function owns one top-level sync phase: it runs the phase's
    OData reads (via the mockable Invoke-OData* helpers), shapes records through
    the pure ConvertTo-*/New-* functions in OmadaCrawler.Transform.ps1, POSTs them
    through Send-IngestBatch, and records timing/outcome via Write-Phase.

    Dot-sourced into Start-OmadaCrawler.ps1's own scope, so they read/write the
    same $Script:phases / $Script:phaseErrors state the inline blocks used to, and
    call the script-scope Test-EntitySetAvailable helper. Phase bodies are moved
    verbatim from the entry point; only the `if ($Sync...)` toggle stays there.

    Extracted so the phases can be unit-tested with Pester by mocking their
    command boundary (Invoke-ODataPagedRequest / Invoke-ODataGetRequest /
    Send-IngestBatch / Test-EntitySetAvailable) — see
    test/unit/OmadaCrawlerPhases.Tests.ps1 — and to pull cyclomatic complexity out
    of the entry point's untestable I/O-on-load script body.

    Cross-phase state (the $All* collections and lookup maps) is threaded through
    explicit params/return values instead of the entry point's shared script vars.
#>

# Prefetch Usergroup UId -> DisplayName for USERGROUPREF name lookup on Resources.
# Returns an empty map when the Usergroup entity set is unavailable or the fetch
# fails (names are a nice-to-have, not required).
function Get-OmadaUserGroupMap {
    [CmdletBinding()]
    param(
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $map = @{}
    if (Test-EntitySetAvailable 'Usergroup') {
        try {
            $Ugs = Invoke-ODataPagedRequest -Path '/Usergroup' `
                -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
            foreach ($Ug in $Ugs) { $map[[string]$Ug.UId] = $Ug.DisplayName }
            Write-Host "  Loaded $($map.Count) usergroups for USERGROUPREF lookup" -ForegroundColor Gray
        } catch {
            Write-Host "  Warning: Usergroup fetch failed — USERGROUPREF names unavailable" -ForegroundColor Yellow
        }
    }
    return $map
}

# ─── Phase: Resources ────────────────────────────────────────────
# OData entity: Resource. Groups records by connected system (SYSTEMREF) for
# correct per-system scoped-delete. RETURNS the raw Resource objects so the
# Entitlements phase can extract CHILDROLES relationships without a second fetch.
function Sync-OmadaResources {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        [hashtable]$OmadaSystemMap = @{},
        $AllOmadaSystems,
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $T = [datetime]::UtcNow
    Write-Host "`nResources:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing resources' -Pct 50
    $AllResources = $Null
    try {
        if (-not (Test-EntitySetAvailable 'Resource')) {
            throw "Resource entity set not found in OData metadata"
        }

        # Pre-fetch Usergroups for USERGROUPREF name lookup
        $UserGroupMap = Get-OmadaUserGroupMap -PageSize $PageSize -MaxRetries $MaxRetries

        Write-Step 'Fetching resources from Omada (this may take a few minutes)...'
        $AllResources = Invoke-ODataPagedRequest -Path '/Resource' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
        Write-Host "  $($AllResources.Count) resource records from Omada" -ForegroundColor Gray

        Write-Step "Building resource records from $($AllResources.Count) Omada resources..."
        # Group resources by connected system (SYSTEMREF) for correct scoped-delete.
        # Per-resource record shaping lives in ConvertTo-OmadaResourceRecord.
        $BySysUId = @{}
        foreach ($Item in $AllResources) {
            $Rec = ConvertTo-OmadaResourceRecord -Resource $Item -UserGroupMap $UserGroupMap
            if (-not $Rec) { continue }
            $SysUId = Get-OmadaRefUid -Ref $Item.SYSTEMREF
            $Key = if ($SysUId -and $OmadaSystemMap.ContainsKey($SysUId)) { $SysUId } else { '__main__' }
            if (-not $BySysUId.ContainsKey($Key)) { $BySysUId[$Key] = [System.Collections.Generic.List[object]]::new() }
            $BySysUId[$Key].Add($Rec)
        }

        Write-Step "Ingesting resources across $($BySysUId.Keys.Count) system(s)..."
        $TotalInserted = 0; $TotalUpdated = 0; $TotalDeleted = 0
        foreach ($Key in $BySysUId.Keys) {
            $SysId    = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
            $SysLabel = if ($Key -eq '__main__') { 'Omada' } else {
                ($AllOmadaSystems | Where-Object { $_.UId -eq $Key } | Select-Object -First 1).DisplayName
            }
            $Recs = @($BySysUId[$Key])
            $R = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SysId -SyncMode 'full' `
                -Scope @{} -Records $Recs
            Write-Host "  Resources ($SysLabel, $($Recs.Count) records): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
            $TotalInserted += ($R.inserted ?? 0); $TotalUpdated += ($R.updated ?? 0); $TotalDeleted += ($R.deleted ?? 0)
        }
        Write-Host "  Resources total: +$TotalInserted ~$TotalUpdated -$TotalDeleted" -ForegroundColor Green
        Write-Phase -Name 'Resources' -Duration ([datetime]::UtcNow - $T) -Records @{ resources = $AllResources.Count }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Resources phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Resources: $Msg")
        Write-Phase -Name 'Resources' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
    return $AllResources
}

# ─── Phase: Entitlements (Resource Relationships) ─────────────────
# Omada stores child-role nesting in Resource.CHILDROLES; there's no separate
# endpoint, so Contains relationships are extracted from the $AllResources the
# Resources phase already fetched.
function Sync-OmadaEntitlements {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        $AllResources
    )
    $T = [datetime]::UtcNow
    Write-Host "`nEntitlements (Resource Relationships):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing entitlements' -Pct 65
    try {
        if (-not $AllResources) {
            Write-Host "  Skipping entitlements — resources were not synced" -ForegroundColor Yellow
            Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $T) -Records @{ relationships = 0 }
        } else {
            Write-Step "Extracting entitlements (CHILDROLES) from $($AllResources.Count) resources..."
            # CHILDROLES → Contains relationship extraction lives in
            # ConvertTo-OmadaEntitlementRelationships (OmadaCrawler.Transform.ps1).
            $RelRecords = [System.Collections.Generic.List[object]]::new()
            foreach ($Item in $AllResources) {
                foreach ($Rel in (ConvertTo-OmadaEntitlementRelationships -Resource $Item)) {
                    $RelRecords.Add($Rel)
                }
            }

            Write-Step "Ingesting $($RelRecords.Count) resource relationships (Contains)..."
            $R = Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ relationshipType = 'Contains' } -Records @($RelRecords)
            Write-Host "  Entitlements: +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
            Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $T) -Records @{ relationships = $RelRecords.Count }
        }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Entitlements phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Entitlements: $Msg")
        Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
}

# ─── Phase: Refresh views ────────────────────────────────────────
function Sync-OmadaRefreshViews {
    [CmdletBinding()]
    param()
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
    try {
        Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null
        Write-Host "`nViews refreshed." -ForegroundColor Gray
    } catch {
        Write-Host "  Warning: view refresh failed — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ─── Phase: Contexts ─────────────────────────────────────────────
# Syncs all configured context object types (default: Orgunit). Orgunit uses a
# topological sort (PARENTOU hierarchy); other types are flat. RETURNS the set of
# synced context UIds so ContextMembers can filter CA_CONTEXT refs.
function Sync-OmadaContexts {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        $ContextObjectTypes,
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $T = [datetime]::UtcNow
    Write-Host "`nContexts:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing contexts' -Pct 10
    $SyncedContextIds = [System.Collections.Generic.HashSet[string]]::new()
    $ContextPhaseErrors = [System.Collections.Generic.List[string]]::new()

    foreach ($Cot in $ContextObjectTypes) {
        $EntitySet   = $Cot.entitySet
        $ContextType = $Cot.contextType
        try {
            if (-not (Test-EntitySetAvailable $EntitySet)) {
                Write-Host "  Skipping $EntitySet — entity set not in OData metadata" -ForegroundColor Yellow
                continue
            }
            Write-Step "Fetching $EntitySet entities from Omada..."
            $Items = Invoke-ODataPagedRequest -Path "/$EntitySet" `
                -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
            Write-Host "  $($Items.Count) $EntitySet records from Omada" -ForegroundColor Gray

            if ($EntitySet -eq 'Orgunit') {
                # Orgunit has a parent hierarchy — topological sort required.
                $RawRecords = @($Items | ForEach-Object {
                    ConvertTo-OmadaOrgUnitContextRecord -OrgUnit $_ -DefaultContextType $ContextType
                } | Where-Object { $_.externalId -and $_.displayName })
                $Records = Sort-OmadaContextsTopologically -Records $RawRecords
            } else {
                $Records = @($Items | ForEach-Object {
                    ConvertTo-OmadaFlatContextRecord -Item $_ -ContextType $ContextType
                } | Where-Object { $_.externalId -and $_.displayName })
            }

            Write-Step "Ingesting $($Records.Count) $ContextType contexts..."
            $R = Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ variant = 'synced'; contextType = $ContextType } -Records @($Records)
            Write-Host "  Contexts ($EntitySet): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
            foreach ($Rec in $Records) { $SyncedContextIds.Add($Rec.id) | Out-Null }
        } catch {
            $EMsg = $_.Exception.Message
            Write-Host "  Contexts ($EntitySet) failed: $EMsg" -ForegroundColor Yellow
            $ContextPhaseErrors.Add($EntitySet + ': ' + $EMsg)
        }
    }

    if ($ContextPhaseErrors.Count -eq @($ContextObjectTypes).Count) {
        $Script:phaseErrors.Add("Contexts: all context types failed")
        Write-Phase -Name 'Contexts' -Duration ([datetime]::UtcNow - $T) -ErrorMsg "All context types failed"
    } else {
        Write-Phase -Name 'Contexts' -Duration ([datetime]::UtcNow - $T) -Records @{ contexts = $SyncedContextIds.Count }
    }
    return $SyncedContextIds
}

# ─── Phase: Identities ───────────────────────────────────────────
# OData entity: Identity. Builds $IdentityLookup (IDENTITYID → uid+identityType)
# and the set of Identity UIds stored in the Identities table (person-type),
# both consumed by later phases. RETURNS @{ allIdentities; identityLookup;
# identityUidInIdentitiesTable }.
function Sync-OmadaIdentities {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        $IdentityTypesForIdentityTable,
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $T = [datetime]::UtcNow
    Write-Host "`nIdentities:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing identities' -Pct 20
    $AllIdentities = $Null
    $IdentityLookup = @{}
    $IdentityUidInIdentitiesTable = [System.Collections.Generic.HashSet[string]]::new()
    try {
        if (-not (Test-EntitySetAvailable 'Identity')) {
            throw "Identity entity set not found in OData metadata"
        }
        Write-Step 'Fetching identities from Omada...'
        $AllIdentities = Invoke-ODataPagedRequest -Path '/Identity' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
        Write-Host "  $($AllIdentities.Count) identity records from Omada" -ForegroundColor Gray

        # Lookup: Identity.IDENTITYID (string) → { uid, identityType }
        foreach ($Id in $AllIdentities) {
            $Key = [string]$Id.IDENTITYID
            if ($Key) {
                $IdType = Get-OmadaIdentityType -Identity $Id
                $IdentityLookup[$Key] = @{ uid = [string]$Id.UId; identityType = $IdType }
            }
        }

        # Person-type identities go to the Identities table
        $PersonIdentities = @($AllIdentities | Where-Object {
            $IdentityTypesForIdentityTable -contains (Get-OmadaIdentityType -Identity $_)
        })
        $IdentRecords = @($PersonIdentities | ForEach-Object {
            ConvertTo-OmadaIdentityRecord -Identity $_
        } | Where-Object { $_.externalId -and $_.displayName })

        Write-Step "Ingesting $($IdentRecords.Count) identity records..."
        $R = Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $SystemId -SyncMode 'full' -Records $IdentRecords
        Write-Host "  Identities: +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green

        foreach ($Rec in $IdentRecords) { $IdentityUidInIdentitiesTable.Add($Rec.id) | Out-Null }
        Write-Phase -Name 'Identities' -Duration ([datetime]::UtcNow - $T) -Records @{ identities = $IdentRecords.Count }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Identities phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Identities: $Msg")
        Write-Phase -Name 'Identities' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
    return @{
        allIdentities                = $AllIdentities
        identityLookup               = $IdentityLookup
        identityUidInIdentitiesTable = $IdentityUidInIdentitiesTable
    }
}

# Build the account-derived lookups the ContextMembers/Assignments phases need:
#   userNameToUid:         UserName → User.UId (CRA AccountName resolution)
#   identityUidToUserUids: Identity.UId → [User.UIds] (assignment fan-out)
# Pure over the fetched accounts + the identity lookup.
function Get-OmadaAccountLookups {
    [CmdletBinding()]
    param(
        $AllAccounts,
        [hashtable]$IdentityLookup = @{}
    )
    $UserNameToUid = @{}
    $IdentityUidToUserUids = @{}
    foreach ($Acc in $AllAccounts) {
        if ($Acc.Inactive) { continue }
        if ($Acc.UserName) { $UserNameToUid[[string]$Acc.UserName] = [string]$Acc.UId }
        $IdentIdStr = if ($Acc.IDENTITYREF) { [string]$Acc.IDENTITYREF.IDENTITYID } else { $Null }
        if ($IdentIdStr -and $IdentityLookup.ContainsKey($IdentIdStr)) {
            $IdentUid = $IdentityLookup[$IdentIdStr].uid
            if (-not $IdentityUidToUserUids.ContainsKey($IdentUid)) {
                $IdentityUidToUserUids[$IdentUid] = [System.Collections.Generic.List[string]]::new()
            }
            $IdentityUidToUserUids[$IdentUid].Add([string]$Acc.UId)
        }
    }
    return @{ userNameToUid = $UserNameToUid; identityUidToUserUids = $IdentityUidToUserUids }
}

# ─── Phase: Accounts / Principals ────────────────────────────────
# OData entity: User. principalType resolved from the linked Identity via
# $IdentityLookup. RETURNS @{ allAccounts; userNameToUid; identityUidToUserUids }.
function Sync-OmadaAccounts {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        [hashtable]$IdentityLookup = @{},
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $T = [datetime]::UtcNow
    Write-Host "`nAccounts (Principals):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing accounts' -Pct 30
    $AllAccounts = $Null
    $Lookups = @{ userNameToUid = @{}; identityUidToUserUids = @{} }
    try {
        if (-not (Test-EntitySetAvailable 'User')) {
            throw "User entity set not found in OData metadata"
        }
        Write-Step 'Fetching user accounts from Omada...'
        $AllAccounts = Invoke-ODataPagedRequest -Path '/User' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
        Write-Host "  $($AllAccounts.Count) account records from Omada" -ForegroundColor Gray

        Write-Step "Building $($AllAccounts.Count) account records..."
        $AccountRecords = @($AllAccounts | Where-Object { -not $_.Inactive } | ForEach-Object {
            ConvertTo-OmadaAccountRecord -Account $_ -IdentityLookup $IdentityLookup
        } | Where-Object { $_.externalId -and $_.displayName })

        foreach ($PType in @('User', 'ExternalUser', 'ServicePrincipal')) {
            $Subset = @($AccountRecords | Where-Object { $_.principalType -eq $PType })
            if ($Subset.Count -eq 0) { continue }
            $R = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ principalType = $PType } -Records $Subset
            Write-Host "  Principals ($PType): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        }
        $OtherTypes = @($AccountRecords | Where-Object { $_.principalType -notin @('User','ExternalUser','ServicePrincipal') })
        if ($OtherTypes.Count -gt 0) {
            $Grouped = $OtherTypes | Group-Object principalType
            foreach ($G in $Grouped) {
                $R = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode 'full' `
                    -Scope @{ principalType = $G.Name } -Records @($G.Group)
                Write-Host "  Principals ($($G.Name)): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
            }
        }

        # Shared lookups for the ContextMembers + Assignments phases.
        $Lookups = Get-OmadaAccountLookups -AllAccounts $AllAccounts -IdentityLookup $IdentityLookup

        Write-Phase -Name 'Accounts' -Duration ([datetime]::UtcNow - $T) -Records @{ accounts = $AccountRecords.Count }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Accounts phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Accounts: $Msg")
        Write-Phase -Name 'Accounts' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
    return @{
        allAccounts           = $AllAccounts
        userNameToUid         = $Lookups.userNameToUid
        identityUidToUserUids = $Lookups.identityUidToUserUids
    }
}
