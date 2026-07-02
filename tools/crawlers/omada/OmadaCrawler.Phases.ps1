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

# ─── Phase: IdentityMembers ───────────────────────────────────────
# Links User accounts to their Identity (Identity.UId ← User.IDENTITYREF.IDENTITYID).
# Per-account link shaping (and the person-type FK guard) lives in
# ConvertTo-OmadaIdentityMemberRecord, which returns $null for accounts to skip.
function Sync-OmadaIdentityMembers {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        $AllAccounts,
        [hashtable]$IdentityLookup = @{},
        $IdentityTypesForIdentityTable
    )
    $T = [datetime]::UtcNow
    Write-Host "`nIdentity Members:" -ForegroundColor Cyan
    try {
        $MemberRecords = [System.Collections.Generic.List[object]]::new()
        foreach ($Acc in $AllAccounts) {
            $Member = ConvertTo-OmadaIdentityMemberRecord -Account $Acc -IdentityLookup $IdentityLookup -IdentityTypesForIdentityTable $IdentityTypesForIdentityTable
            if ($Member) { $MemberRecords.Add($Member) }
        }

        Write-Step "Ingesting $($MemberRecords.Count) identity-member links..."
        $R = Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $SystemId -SyncMode 'full' -Records @($MemberRecords)
        Write-Host "  IdentityMembers: +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        Write-Phase -Name 'IdentityMembers' -Duration ([datetime]::UtcNow - $T) -Records @{ members = $MemberRecords.Count }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  IdentityMembers phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("IdentityMembers: $Msg")
        Write-Phase -Name 'IdentityMembers' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
}

# ContextMembers source 1: Omada's explicit Contextassignment entity
# (CA_IDENTITY → CA_CONTEXT). Only emits for synced contexts + in-table identities.
function Get-OmadaContextMembersFromAssignments {
    [CmdletBinding()]
    param($Items, $SyncedContextIds, $IdentityUidInIdentitiesTable)
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($Item in $Items) {
        $IdentUid   = if ($Item.CA_IDENTITY) { [string]$Item.CA_IDENTITY.UId } else { $Null }
        $ContextUid = if ($Item.CA_CONTEXT)  { [string]$Item.CA_CONTEXT.UId  } else { $Null }
        if (-not $IdentUid -or -not $ContextUid) { continue }
        # Skip when no contexts were synced (empty set) OR this id wasn't synced —
        # otherwise an empty Contexts table would cause FK violations.
        if ($SyncedContextIds.Count -eq 0 -or -not $SyncedContextIds.Contains($ContextUid)) { continue }
        if (-not $IdentityUidInIdentitiesTable.Contains($IdentUid)) { continue }
        $out.Add((New-OmadaContextMemberRecord -ContextId $ContextUid -MemberId $IdentUid))
    }
    return @($out)
}

# ContextMembers source 2: direct context reference fields on Identity
# (OUREF, COUNTRY, etc. — configured identityFields + well-known fallbacks).
function Get-OmadaContextMembersFromIdentityFields {
    [CmdletBinding()]
    param($AllIdentities, $ContextObjectTypes, [hashtable]$WellKnownIdentityContextFields = @{}, $SyncedContextIds, $IdentityUidInIdentitiesTable)
    $out = [System.Collections.Generic.List[object]]::new()
    $FieldsToCheck = @{}
    foreach ($Cot in $ContextObjectTypes) {
        if ($Cot.identityField) { $FieldsToCheck[$Cot.identityField] = $True }
    }
    foreach ($Field in $WellKnownIdentityContextFields.Keys) { $FieldsToCheck[$Field] = $True }

    foreach ($Ident in $AllIdentities) {
        $IdentUid = [string]$Ident.UId
        if (-not $IdentityUidInIdentitiesTable.Contains($IdentUid)) { continue }
        foreach ($Field in $FieldsToCheck.Keys) {
            $ContextUid = Get-OmadaRefUid -Ref $Ident.$Field
            if (-not $ContextUid -or -not $SyncedContextIds.Contains($ContextUid)) { continue }
            $out.Add((New-OmadaContextMemberRecord -ContextId $ContextUid -MemberId $IdentUid))
        }
    }
    return @($out)
}

# ContextMembers source 3: the Employment entity (IDENTITYREF → OUREF). Optional;
# best-effort (soft-fails if the entity set is unavailable or the fetch errors).
function Get-OmadaContextMembersFromEmployment {
    [CmdletBinding()]
    param($SyncedContextIds, $IdentityUidInIdentitiesTable, [int]$PageSize = 100, [int]$MaxRetries = 5)
    $out = [System.Collections.Generic.List[object]]::new()
    if (-not (Test-EntitySetAvailable 'Employment')) { return @($out) }
    try {
        Write-Step 'Fetching employment records from Omada...'
        $EmpItems = Invoke-ODataPagedRequest -Path '/Employment' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
        foreach ($Emp in $EmpItems) {
            $IdentUid   = Get-OmadaRefUid -Ref $Emp.IDENTITYREF
            $ContextUid = Get-OmadaRefUid -Ref $Emp.OUREF
            if (-not $IdentUid -or -not $ContextUid) { continue }
            if (-not $SyncedContextIds.Contains($ContextUid)) { continue }
            if (-not $IdentityUidInIdentitiesTable.Contains($IdentUid)) { continue }
            $out.Add((New-OmadaContextMemberRecord -ContextId $ContextUid -MemberId $IdentUid))
        }
        Write-Host "  Employment-based context links added from $($EmpItems.Count) employment records" -ForegroundColor Gray
    } catch {
        Write-Host "  Warning: Employment-based context members skipped — $($_.Exception.Message)" -ForegroundColor Yellow
    }
    return @($out)
}

# ─── Phase: Context Members ──────────────────────────────────────
# OData entity: Contextassignment (+ two supplementary sources). Maps Identity →
# OrgUnit/Context. Each identity assignment is emitted once per (contextId,
# memberId) after deduping across all three sources.
function Sync-OmadaContextMembers {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        $SyncedContextIds,
        $IdentityUidInIdentitiesTable,
        $AllIdentities,
        $ContextObjectTypes,
        [hashtable]$WellKnownIdentityContextFields = @{},
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $T = [datetime]::UtcNow
    Write-Host "`nContext Members:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing context members' -Pct 45
    try {
        if (-not (Test-EntitySetAvailable 'Contextassignment')) {
            throw "Contextassignment entity set not found in OData metadata"
        }
        Write-Step 'Fetching context assignments from Omada...'
        $Items = Invoke-ODataPagedRequest -Path '/Contextassignment' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
        Write-Host "  $($Items.Count) context assignment records from Omada" -ForegroundColor Gray

        $CtxMemberRecords = [System.Collections.Generic.List[object]]::new()
        foreach ($Rec in (Get-OmadaContextMembersFromAssignments -Items $Items `
                -SyncedContextIds $SyncedContextIds -IdentityUidInIdentitiesTable $IdentityUidInIdentitiesTable)) {
            $CtxMemberRecords.Add($Rec)
        }
        if ($AllIdentities) {
            foreach ($Rec in (Get-OmadaContextMembersFromIdentityFields -AllIdentities $AllIdentities `
                    -ContextObjectTypes $ContextObjectTypes -WellKnownIdentityContextFields $WellKnownIdentityContextFields `
                    -SyncedContextIds $SyncedContextIds -IdentityUidInIdentitiesTable $IdentityUidInIdentitiesTable)) {
                $CtxMemberRecords.Add($Rec)
            }
        }
        foreach ($Rec in (Get-OmadaContextMembersFromEmployment -SyncedContextIds $SyncedContextIds `
                -IdentityUidInIdentitiesTable $IdentityUidInIdentitiesTable -PageSize $PageSize -MaxRetries $MaxRetries)) {
            $CtxMemberRecords.Add($Rec)
        }

        # Deduplicate before ingest (multiple sources can produce the same pair).
        $Seen    = [System.Collections.Generic.HashSet[string]]::new()
        $Deduped = @($CtxMemberRecords | Where-Object { $Seen.Add("$($_.contextId)|$($_.memberId)") })

        Write-Step "Ingesting $($Deduped.Count) context-member links..."
        $R = Send-IngestBatch -Endpoint 'ingest/context-members' -SystemId $SystemId -SyncMode 'full' -Records $Deduped
        Write-Host "  ContextMembers: +$($R.inserted) ~$($R.updated) -$($R.deleted) (from $($Deduped.Count) deduped records)" -ForegroundColor Green
        Write-Phase -Name 'ContextMembers' -Duration ([datetime]::UtcNow - $T) -Records @{ members = $Deduped.Count }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  ContextMembers phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("ContextMembers: $Msg")
        Write-Phase -Name 'ContextMembers' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
}

# Assignments source 1: group Resourceassignment (role/permission) records by
# connected system, fanning each identity assignment out to all its User accounts.
# Only Active/Pending assignments count. Returns @{ sysKey -> List[record] }.
function Get-OmadaRoleAssignmentsBySystem {
    [CmdletBinding()]
    param($RaItems, [hashtable]$IdentityUidToUserUids = @{}, [hashtable]$OmadaSystemMap = @{})
    $RaBySys = @{}
    foreach ($Item in $RaItems) {
        $Status = if ($Item.ROLEASSNSTATUS) { [string]$Item.ROLEASSNSTATUS.Value } else { 'Active' }
        if ($Status -notin @('Active', 'Pending')) { continue }

        $IdentUid    = if ($Item.IDENTITYREF) { [string]$Item.IDENTITYREF.UId } else { $Null }
        $ResourceUid = Get-OmadaRefUid -Ref $Item.ROLEREF
        $SysUId      = Get-OmadaRefUid -Ref $Item.SYSTEMREF
        if (-not $IdentUid -or -not $ResourceUid) { continue }

        $UserUids = if ($IdentityUidToUserUids.ContainsKey($IdentUid)) { $IdentityUidToUserUids[$IdentUid] } else { $Null }
        if (-not $UserUids -or $UserUids.Count -eq 0) { continue }

        $SysKey = if ($SysUId -and $OmadaSystemMap.ContainsKey($SysUId)) { $SysUId } else { '__main__' }
        if (-not $RaBySys.ContainsKey($SysKey)) { $RaBySys[$SysKey] = [System.Collections.Generic.List[object]]::new() }
        foreach ($UserUid in $UserUids) {
            $RaBySys[$SysKey].Add((New-OmadaRoleAssignmentRecord -ResourceUid $ResourceUid -PrincipalId $UserUid -RoleAssignment $Item))
        }
    }
    return $RaBySys
}

# Extract the six fields a CalculatedAssignment (CRA) row is classified on.
function Get-OmadaCraFields {
    [CmdletBinding()]
    param($Item)
    return @{
        sysUId      = if ($Item.System)       { [string]$Item.System.UId }   else { $Null }
        resourceUid = if ($Item.Resource)     { [string]$Item.Resource.UId } else { $Null }
        identityUid = if ($Item.Identity)     { [string]$Item.Identity.UId } else { $Null }
        accountKey  = if ($Item.AccountKey)   { [string]$Item.AccountKey }   else { $Null }
        accountName = if ($Item.AccountName)  { [string]$Item.AccountName }  else { $Null }
        resType     = if ($Item.ResourceType) { $Item.ResourceType.DisplayName } else { '' }
    }
}

# Classify one CRA row into the records it contributes. For the Omada Identity
# system the account reuses the existing Omada User Principal; for connected
# systems the Principal (and an optional identity-member link) are derived from
# the CRA. Returns @{ sysKey; principal; identityMember; assignment } (any of the
# record fields may be $null), or $null to skip the row. Pure.
function ConvertFrom-OmadaCraItem {
    [CmdletBinding()]
    param(
        $Item,
        [hashtable]$OmadaSystemMap = @{},
        [int]$SystemId,
        [string]$OmadaIdentitySystemUId,
        [hashtable]$UserNameToUid = @{},
        $IdentityUidInIdentitiesTable
    )
    $F = Get-OmadaCraFields -Item $Item
    if (-not $F.resourceUid -or -not $F.identityUid) { return $null }

    $SysKey = if ($F.sysUId -and $OmadaSystemMap.ContainsKey($F.sysUId)) { $F.sysUId } else { '__main__' }
    $IsOmadaSys = ($F.sysUId -and $F.sysUId -eq $OmadaIdentitySystemUId)
    $PrincipalUid = $Null
    $Principal = $Null
    $IdentityMember = $Null

    if ($IsOmadaSys) {
        # Reuse the existing Omada User Principal (created by the Accounts phase).
        if ($F.accountName -and $UserNameToUid.ContainsKey($F.accountName)) {
            $PrincipalUid = $UserNameToUid[$F.accountName]
        }
    } else {
        # Connected-system account — derive the Principal from the CRA.
        if (-not $F.accountKey) { return $null }
        $PrincipalUid = $F.accountKey
        $Principal = ConvertTo-OmadaCraPrincipalRecord -CalculatedAssignment $Item -AccountKey $F.accountKey -AccountName $F.accountName -ResType $F.resType
        if ($IdentityUidInIdentitiesTable.Contains($F.identityUid)) {
            $IdentityMember = [PSCustomObject]@{
                identityId  = $F.identityUid   # Identity.UId == Identities.id
                principalId = $F.accountKey
                accountType = $F.resType
            }
        }
    }

    if (-not $PrincipalUid) { return $null }
    $Assignment = ConvertTo-OmadaCraAssignmentRecord -CalculatedAssignment $Item -ResourceUid $F.resourceUid -PrincipalId $PrincipalUid -ResType $F.resType -AccountName $F.accountName
    return @{ sysKey = $SysKey; principal = $Principal; identityMember = $IdentityMember; assignment = $Assignment }
}

# Assignments source 2: stream /Builtin/CalculatedAssignments page-by-page (cloud
# instances can have 10k+ rows; accumulating them all OOM-kills the worker) and
# fold each row into the per-system principal / identity-member / assignment
# accumulators. Returns @{ principalsBySys; identityMembers; assignmentsBySys;
# totalCount }.
function Get-OmadaCraData {
    [CmdletBinding()]
    param(
        [hashtable]$OmadaSystemMap = @{},
        [int]$SystemId,
        [string]$OmadaIdentitySystemUId,
        [hashtable]$UserNameToUid = @{},
        $IdentityUidInIdentitiesTable,
        [string]$BuiltinBaseUrl,
        [int]$MaxRetries = 5,
        [int]$CaPageSize = 1000
    )
    $PrincipalsBySys  = @{}
    $IdentityMembers  = [System.Collections.Generic.List[object]]::new()
    $AssignmentsBySys = @{}
    $TotalCount = 0
    $Skip = 0

    do {
        Write-Step "Fetching CRA page (skip=$Skip, total so far: $TotalCount)..."
        $Page = Invoke-ODataGetRequest -Path '/CalculatedAssignments' `
            -QueryParams @{ '$filter' = 'Status eq true'; '$expand' = 'Identity,Resource,System,ResourceType'
                            '$top' = $CaPageSize; '$skip' = $Skip } `
            -MaxRetries $MaxRetries -OverrideBaseUrl $BuiltinBaseUrl
        $TotalCount += $Page.Count
        $Skip += $Page.Count   # advance by actual received (variable page size)

        foreach ($Item in $Page) {
            $Res = ConvertFrom-OmadaCraItem -Item $Item -OmadaSystemMap $OmadaSystemMap -SystemId $SystemId `
                -OmadaIdentitySystemUId $OmadaIdentitySystemUId -UserNameToUid $UserNameToUid `
                -IdentityUidInIdentitiesTable $IdentityUidInIdentitiesTable
            if (-not $Res) { continue }
            if ($Res.principal) {
                if (-not $PrincipalsBySys.ContainsKey($Res.sysKey)) { $PrincipalsBySys[$Res.sysKey] = [System.Collections.Generic.List[object]]::new() }
                $PrincipalsBySys[$Res.sysKey].Add($Res.principal)
            }
            if ($Res.identityMember) { $IdentityMembers.Add($Res.identityMember) }
            if ($Res.assignment) {
                if (-not $AssignmentsBySys.ContainsKey($Res.sysKey)) { $AssignmentsBySys[$Res.sysKey] = [System.Collections.Generic.List[object]]::new() }
                $AssignmentsBySys[$Res.sysKey].Add($Res.assignment)
            }
        }
    } while ($Page.Count -gt 0)

    return @{
        principalsBySys  = $PrincipalsBySys
        identityMembers  = $IdentityMembers
        assignmentsBySys = $AssignmentsBySys
        totalCount       = $TotalCount
    }
}

# Ingest the CRA-derived connected-system Principals and their identity-member
# links (delta — the Accounts phase owns the full sync for Omada users).
function Send-OmadaCraDerived {
    [CmdletBinding()]
    param($CraData, [hashtable]$OmadaSystemMap = @{}, [int]$SystemId)
    $TotalPrincipals = 0
    foreach ($Key in $CraData.principalsBySys.Keys) {
        $SysId = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
        $Seen  = [System.Collections.Generic.HashSet[string]]::new()
        $Dedup = @($CraData.principalsBySys[$Key] | Where-Object { $Seen.Add($_.id) })
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SysId -SyncMode 'delta' -Records $Dedup | Out-Null
        $TotalPrincipals += $Dedup.Count
    }
    if ($CraData.identityMembers.Count -gt 0) {
        $Seen  = [System.Collections.Generic.HashSet[string]]::new()
        $Dedup = @($CraData.identityMembers | Where-Object { $Seen.Add("$($_.identityId)|$($_.principalId)") })
        Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $SystemId -SyncMode 'delta' -Records $Dedup | Out-Null
    }
    Write-Host "  CRA: $($CraData.totalCount) records → $TotalPrincipals connected-system accounts, $($CraData.identityMembers.Count) identity-member links" -ForegroundColor Green
}

# Combine role assignments (source 1) and CRA assignments (source 2) per system —
# both are governed=true Direct memberships sharing one reconcile partition, so
# they must be sent together or each full-sync delete wipes the other's rows.
function Send-OmadaGovernanceAssignments {
    [CmdletBinding()]
    param([hashtable]$RaBySys = @{}, [hashtable]$AssignmentsBySys = @{}, [hashtable]$OmadaSystemMap = @{}, [int]$SystemId)
    $TotalGovIns = 0
    $AllSysKeys = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($k in $RaBySys.Keys)           { [void]$AllSysKeys.Add($k) }
    foreach ($k in $AssignmentsBySys.Keys)  { [void]$AllSysKeys.Add($k) }
    foreach ($Key in $AllSysKeys) {
        $SysId = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
        $Combined = [System.Collections.Generic.List[object]]::new()
        if ($RaBySys.ContainsKey($Key))          { $Combined.AddRange($RaBySys[$Key]) }
        if ($AssignmentsBySys.ContainsKey($Key)) { $Combined.AddRange($AssignmentsBySys[$Key]) }
        $Seen  = [System.Collections.Generic.HashSet[string]]::new()
        $Dedup = @($Combined | Where-Object { $Seen.Add("$($_.principalId)|$($_.resourceId)") })
        if ($Dedup.Count -eq 0) { continue }
        $R = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SysId `
            -SyncMode 'full' -Scope @{ assignmentType = 'Direct'; governed = $true } -Records $Dedup
        $TotalGovIns += ($R.inserted ?? 0)
    }
    Write-Host "  Governance assignments (Direct, governed): +$TotalGovIns" -ForegroundColor Green
}

# ─── Phase: Assignments ───────────────────────────────────────────
# Combines role assignments (Resourceassignment) and effective account
# provisioning (CalculatedAssignments) into one governed=true reconcile per
# system. Uses the account/identity lookups produced by earlier phases.
function Sync-OmadaAssignments {
    [CmdletBinding()]
    param(
        [int]$SystemId,
        [hashtable]$OmadaSystemMap = @{},
        [string]$OmadaIdentitySystemUId,
        [hashtable]$UserNameToUid = @{},
        [hashtable]$IdentityUidToUserUids = @{},
        $IdentityUidInIdentitiesTable,
        [string]$BuiltinBaseUrl,
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )
    $T = [datetime]::UtcNow
    Write-Host "`nAssignments:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing assignments' -Pct 75
    try {
        # ── Source 1: Resourceassignment (role/permission assignments) ──
        Write-Step 'Fetching role assignments from Omada...'
        $RaItems = Invoke-ODataPagedRequest -Path '/Resourceassignment' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxRetries
        Write-Host "  $($RaItems.Count) Resourceassignment records from Omada" -ForegroundColor Gray
        $RaBySys = Get-OmadaRoleAssignmentsBySystem -RaItems $RaItems -IdentityUidToUserUids $IdentityUidToUserUids -OmadaSystemMap $OmadaSystemMap
        Write-Host "  Role assignments collected across $($RaBySys.Keys.Count) system(s)" -ForegroundColor Gray

        # ── Source 2: Calculated Resource Assignments (streamed) ──
        $CraData = Get-OmadaCraData -OmadaSystemMap $OmadaSystemMap -SystemId $SystemId `
            -OmadaIdentitySystemUId $OmadaIdentitySystemUId -UserNameToUid $UserNameToUid `
            -IdentityUidInIdentitiesTable $IdentityUidInIdentitiesTable -BuiltinBaseUrl $BuiltinBaseUrl -MaxRetries $MaxRetries
        Write-Host "  $($CraData.totalCount) CRA records from Omada" -ForegroundColor Gray

        Write-Step "Ingesting CRA-derived principals and identity-member links..."
        Send-OmadaCraDerived -CraData $CraData -OmadaSystemMap $OmadaSystemMap -SystemId $SystemId

        Write-Step "Ingesting governance assignments (role + CRA) per system..."
        Send-OmadaGovernanceAssignments -RaBySys $RaBySys -AssignmentsBySys $CraData.assignmentsBySys `
            -OmadaSystemMap $OmadaSystemMap -SystemId $SystemId

        $RoleCount = ($RaBySys.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
        $CraCount  = ($CraData.assignmentsBySys.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
        Write-Phase -Name 'Assignments' -Duration ([datetime]::UtcNow - $T) `
            -Records @{ roleAssignments = $RoleCount; craAssignments = $CraCount }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Assignments phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Assignments: $Msg")
        Write-Phase -Name 'Assignments' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
}
