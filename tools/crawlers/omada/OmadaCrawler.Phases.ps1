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
# Send one system's resource records to the ingest API (full scoped sync) and echo the
# counts. Resolves the target system id + display label from the accumulator key.
# Extracted from Sync-OmadaResources's per-system loop.
function Send-OmadaResourceBatch {
    [CmdletBinding()]
    param($Key, $Records, [int]$SystemId, [hashtable]$OmadaSystemMap = @{}, $AllOmadaSystems)
    $SysId    = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
    $SysLabel = if ($Key -eq '__main__') { 'Omada' } else {
        ($AllOmadaSystems | Where-Object { $_.UId -eq $Key } | Select-Object -First 1).DisplayName
    }
    $R = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SysId -SyncMode 'full' -Scope @{} -Records $Records
    Write-Host "  Resources ($SysLabel, $($Records.Count) records): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
    return $R
}

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
            $Key = Resolve-OmadaSysKey -SysUId (Get-OmadaRefUid -Ref $Item.SYSTEMREF) -OmadaSystemMap $OmadaSystemMap
            if (-not $BySysUId.ContainsKey($Key)) { $BySysUId[$Key] = [System.Collections.Generic.List[object]]::new() }
            $BySysUId[$Key].Add($Rec)
        }

        Write-Step "Ingesting resources across $($BySysUId.Keys.Count) system(s)..."
        $TotalInserted = 0; $TotalUpdated = 0; $TotalDeleted = 0
        foreach ($Key in $BySysUId.Keys) {
            $R = Send-OmadaResourceBatch -Key $Key -Records @($BySysUId[$Key]) `
                -SystemId $SystemId -OmadaSystemMap $OmadaSystemMap -AllOmadaSystems $AllOmadaSystems
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

            $Records = @(Build-OmadaContextRecords -Items $Items -EntitySet $EntitySet -ContextType $ContextType)

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
# Resolve the per-system accumulator key: the system UId when it maps to a known
# connected system, else the '__main__' catch-all. Shared by the role-assignment and
# CRA folds.
function Resolve-OmadaSysKey {
    [CmdletBinding()]
    param($SysUId, [hashtable]$OmadaSystemMap = @{})
    if ($SysUId -and $OmadaSystemMap.ContainsKey($SysUId)) { $SysUId } else { '__main__' }
}

# Classify one role-assignment row into the records it contributes and its system key,
# or $null to skip. Extracted from Get-OmadaRoleAssignmentsBySystem to keep both flat.
function ConvertFrom-OmadaRoleAssignmentItem {
    [CmdletBinding()]
    param($Item, [hashtable]$IdentityUidToUserUids = @{}, [hashtable]$OmadaSystemMap = @{})
    $Status = Get-OmadaEnumStr $Item.ROLEASSNSTATUS -Fallback 'Active'
    if ($Status -notin @('Active', 'Pending')) { return $null }
    $IdentUid    = if ($Item.IDENTITYREF) { [string]$Item.IDENTITYREF.UId } else { $Null }
    $ResourceUid = Get-OmadaRefUid -Ref $Item.ROLEREF
    if (-not $IdentUid -or -not $ResourceUid) { return $null }
    $UserUids = if ($IdentityUidToUserUids.ContainsKey($IdentUid)) { $IdentityUidToUserUids[$IdentUid] } else { $Null }
    if (-not $UserUids -or $UserUids.Count -eq 0) { return $null }
    $SysKey  = Resolve-OmadaSysKey -SysUId (Get-OmadaRefUid -Ref $Item.SYSTEMREF) -OmadaSystemMap $OmadaSystemMap
    $Records = foreach ($UserUid in $UserUids) {
        New-OmadaRoleAssignmentRecord -ResourceUid $ResourceUid -PrincipalId $UserUid -RoleAssignment $Item
    }
    return @{ SysKey = $SysKey; Records = @($Records) }
}

function Get-OmadaRoleAssignmentsBySystem {
    [CmdletBinding()]
    param($RaItems, [hashtable]$IdentityUidToUserUids = @{}, [hashtable]$OmadaSystemMap = @{})
    $RaBySys = @{}
    foreach ($Item in $RaItems) {
        $Ra = ConvertFrom-OmadaRoleAssignmentItem -Item $Item -IdentityUidToUserUids $IdentityUidToUserUids -OmadaSystemMap $OmadaSystemMap
        if (-not $Ra) { continue }
        if (-not $RaBySys.ContainsKey($Ra.SysKey)) { $RaBySys[$Ra.SysKey] = [System.Collections.Generic.List[object]]::new() }
        foreach ($Rec in $Ra.Records) { $RaBySys[$Ra.SysKey].Add($Rec) }
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

    $SysKey = Resolve-OmadaSysKey -SysUId $F.sysUId -OmadaSystemMap $OmadaSystemMap
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

# Fold one classified CRA result into the per-system principal / identity-member /
# assignment accumulators (all reference types, mutated in place). Extracted from
# Get-OmadaCraData's page loop to keep it flat.
function Add-OmadaCraResultToAccumulators {
    [CmdletBinding()]
    param($Result, [hashtable]$PrincipalsBySys, $IdentityMembers, [hashtable]$AssignmentsBySys)
    if ($Result.principal) {
        if (-not $PrincipalsBySys.ContainsKey($Result.sysKey)) { $PrincipalsBySys[$Result.sysKey] = [System.Collections.Generic.List[object]]::new() }
        $PrincipalsBySys[$Result.sysKey].Add($Result.principal)
    }
    if ($Result.identityMember) { $IdentityMembers.Add($Result.identityMember) }
    if ($Result.assignment) {
        if (-not $AssignmentsBySys.ContainsKey($Result.sysKey)) { $AssignmentsBySys[$Result.sysKey] = [System.Collections.Generic.List[object]]::new() }
        $AssignmentsBySys[$Result.sysKey].Add($Result.assignment)
    }
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
            Add-OmadaCraResultToAccumulators -Result $Res -PrincipalsBySys $PrincipalsBySys `
                -IdentityMembers $IdentityMembers -AssignmentsBySys $AssignmentsBySys
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
    $AllSysKeys = [System.Collections.Generic.HashSet[string]]::new([string[]](@($RaBySys.Keys) + @($AssignmentsBySys.Keys)))
    foreach ($Key in $AllSysKeys) {
        $TotalGovIns += Send-OmadaGovernanceAssignmentForSystem -Key $Key -RaBySys $RaBySys `
            -AssignmentsBySys $AssignmentsBySys -OmadaSystemMap $OmadaSystemMap -SystemId $SystemId
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

# ─── Config: sync toggles ────────────────────────────────────────
# Defaults, then selectedObjects overrides (data-driven over the old
# if-ContainsKey chain — each key maps to a distinct toggle). Returns a hashtable.
function Resolve-OmadaSyncToggles {
    [CmdletBinding()]
    param([hashtable]$RawConfig = @{})
    $cfg = @{
        SyncContexts = $true; SyncIdentities = $true; SyncAccounts = $true; SyncContextMembers = $true
        SyncResources = $true; SyncEntitlements = $true; SyncAssignments = $true; SyncCRAs = $true; RefreshViews = $true
    }
    $cfg.SyncMode = if ($RawConfig['_syncMode'] -in @('full','delta')) { $RawConfig['_syncMode'] } else { 'full' }
    $objects = $RawConfig['selectedObjects']
    if ($objects) {
        $map = [ordered]@{
            contexts       = 'SyncContexts';       identities   = 'SyncIdentities';   accounts     = 'SyncAccounts'
            contextMembers = 'SyncContextMembers'; resources    = 'SyncResources';     entitlements = 'SyncEntitlements'
            assignments    = 'SyncAssignments';    cras         = 'SyncCRAs'
        }
        foreach ($k in $map.Keys) {
            if ($objects.ContainsKey($k)) { $cfg[$map[$k]] = [bool]$objects[$k] }
        }
    }
    return $cfg
}

# ─── Config: context object types ────────────────────────────────
# Resolve the configured contextObjectTypes (default: Orgunit) and the
# entitySet -> identityField map. Returns @{ contextObjectTypes;
# contextEntitySetToIdentityField }.
function Resolve-OmadaContextObjectTypes {
    [CmdletBinding()]
    param($Cfg)
    $types = if ($Cfg.contextObjectTypes) {
        @($Cfg.contextObjectTypes | ForEach-Object {
            @{ entitySet     = [string]$_.entitySet
               contextType   = if ($_.contextType)   { [string]$_.contextType }   else { [string]$_.entitySet }
               identityField = if ($_.identityField) { [string]$_.identityField } else { $Null } }
        })
    } else {
        @(@{ entitySet = 'Orgunit'; contextType = 'OrgUnit'; identityField = 'OUREF' })
    }
    $map = @{}
    foreach ($Cot in $types) {
        if ($Cot.identityField) { $map[$Cot.entitySet] = $Cot.identityField }
    }
    return @{ contextObjectTypes = $types; contextEntitySetToIdentityField = $map }
}

# ─── Config: resource-category mapping ───────────────────────────
# Maps Omada ROLECATEGORY -> Identity Atlas resourceType (config-overridable).
function Resolve-OmadaResourceCategoryMapping {
    [CmdletBinding()]
    param($Cfg)
    if ($Cfg.resourceCategoryMapping) {
        return @($Cfg.resourceCategoryMapping | ForEach-Object {
            @{ category     = if ($_.category)     { [string]$_.category }     else { '' }
               resourceType = if ($_.resourceType) { [string]$_.resourceType } else { 'Resource' } }
        })
    }
    return @(
        @{ category = 'Role';       resourceType = 'BusinessRole' }
        @{ category = 'Permission'; resourceType = 'Resource' }
        @{ category = '';           resourceType = 'Resource' }   # default/catch-all
    )
}

# ─── Config: resolve the whole job config ────────────────────────
# Normalises the base URL, resolves toggles + context types + category mapping +
# type mappings, and returns one settings hashtable the entry point unpacks.
function Resolve-OmadaConfig {
    [CmdletBinding()]
    param([hashtable]$RawConfig = @{}, $Cfg, [hashtable]$DefaultTypeMappings = @{})
    $toggles = Resolve-OmadaSyncToggles -RawConfig $RawConfig

    # Normalise base URL via System.Uri. Accepts root or explicit /odata/dataobjects.
    $rawUri  = [System.Uri]::new(($Cfg.baseUrl.Trim().TrimEnd('/')))
    $hostUri = $rawUri.Scheme + '://' + $rawUri.Authority
    $path    = $rawUri.AbsolutePath.TrimEnd('/')
    if ($path -notmatch '(?i)/odata/dataobjects$') { $path = '/odata/dataobjects' }

    $ctx          = Resolve-OmadaContextObjectTypes -Cfg $Cfg
    $typeMappings = Merge-TypeMappings -Defaults $DefaultTypeMappings -Overrides $Cfg.typeMappings

    return $toggles + @{
        baseUrl               = $hostUri + $path
        builtinBaseUrl        = $hostUri + ($path -replace '(?i)/dataobjects$', '/builtin')
        apiVersion            = if ($Cfg.apiVersion) { $Cfg.apiVersion } else { 'v14' }
        pageSize              = if ($Cfg.pageSize)   { [int]$Cfg.pageSize } else { 100 }
        maxRetries            = if ($null -ne $Cfg.maxRetries) { [int]$Cfg.maxRetries } else { 5 }
        sessionTimeoutMinutes = if ($Cfg.sessionTimeoutMinutes) { [int]$Cfg.sessionTimeoutMinutes } else { 30 }
        contextObjectTypes             = $ctx.contextObjectTypes
        contextEntitySetToIdentityField = $ctx.contextEntitySetToIdentityField
        resourceCategoryMapping        = Resolve-OmadaResourceCategoryMapping -Cfg $Cfg
        typeMappings                   = $typeMappings
        identityTypesForIdentityTable  = @($typeMappings['identityTypesForIdentityTable'])
        wellKnownIdentityContextFields = @{
            OUREF = 'Orgunit'; COUNTRY = 'Country'; BUILDING = 'Building'; BUSINESSUNIT = 'Businessunit'
            COSTCENTER = 'Costcenter'; DIVISION = 'Division'; JOBTITLE_REF = 'Jobtitle'; LOCATION = 'Location'; SUBAREA = 'Subarea'
        }
    }
}

# ─── Setup: authenticate ─────────────────────────────────────────
function Connect-OmadaSession {
    [CmdletBinding()]
    param($Cfg, [string]$BaseUrl, [string]$ApiVersion, [int]$SessionTimeoutMinutes)
    $AuthParams = @{
        BaseUrl               = $BaseUrl
        AuthMethod            = $Cfg.authMethod
        ApiVersion            = $ApiVersion
        SessionTimeoutMinutes = $SessionTimeoutMinutes
    }
    if ($Cfg.username)      { $AuthParams['Username']      = $Cfg.username }
    if ($Cfg.password)      { $AuthParams['Password']      = $Cfg.password }
    if ($Cfg.clientId)      { $AuthParams['ClientId']      = $Cfg.clientId }
    if ($Cfg.clientSecret)  { $AuthParams['ClientSecret']  = $Cfg.clientSecret }
    if ($Cfg.tokenEndpoint) { $AuthParams['TokenEndpoint'] = $Cfg.tokenEndpoint }
    if ($Cfg.apiToken)      { $AuthParams['ApiToken']      = $Cfg.apiToken }
    if ($Cfg.cookieString)  { $AuthParams['CookieString']  = $Cfg.cookieString }
    Connect-ODataAPI @AuthParams
}

# ─── Setup: discover available entity sets ───────────────────────
# Diagnostic + non-blocking — an empty result means "metadata unavailable, let
# every phase attempt to run" (Test-EntitySetAvailable treats empty as all-available).
function Get-OmadaAvailableEntitySets {
    [CmdletBinding()]
    param()
    $sets = @(Get-ODataEntitySets)
    if ($sets.Count -gt 0) {
        Write-Host "  Entity sets: $($sets -join ', ')" -ForegroundColor Gray
    } else {
        Write-Host "  Entity set check skipped (metadata unavailable — all phases will attempt to run)" -ForegroundColor Yellow
    }
    return $sets
}

# ─── Setup: register Omada connected systems ─────────────────────
# Registers every Omada connected system as its own Identity Atlas System and
# resolves the main IGA system id. Falls back to a single-system registration on
# failure. Returns @{ systemId; omadaSystemMap; allOmadaSystems; omadaIdentitySystemUId }.
function Register-OmadaSystems {
    [CmdletBinding()]
    param([string]$ApiBaseUrl, [string]$ApiKey, [string]$BaseUrl, [int]$MaxRetries = 5)
    $AllOmadaSystems = $Null
    $OmadaSystemMap  = @{}
    $SystemId        = 0
    $OmadaIdentitySystemUId = $Null
    try {
        Write-Step 'Fetching connected systems from Omada...'
        $AllOmadaSystems = Invoke-ODataPagedRequest -Path '/System' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize 100 -MaxRetries $MaxRetries
        Write-Host "  $($AllOmadaSystems.Count) connected systems in Omada" -ForegroundColor Gray

        $SysRecords = @($AllOmadaSystems | ForEach-Object {
            [PSCustomObject]@{ systemType = 'Omada'; displayName = $_.DisplayName; tenantId = [string]$_.UId; enabled = $True; syncEnabled = $True }
        })

        Write-Step "Registering $($SysRecords.Count) systems in Identity Atlas..."
        Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{ syncMode = 'full'; records = ConvertTo-JsonArray $SysRecords } | Out-Null

        $AtlasSystems = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
        foreach ($S in $AtlasSystems) {
            if ($S.systemType -eq 'Omada' -and $S.tenantId) { $OmadaSystemMap[$S.tenantId] = [int]$S.id }
        }
        Write-Host "  System map: $($OmadaSystemMap.Count) entries" -ForegroundColor Gray

        # Omada Identity is the main IGA system — used for Contexts/Identities and to
        # distinguish Omada-internal accounts from connected-system accounts (Assignments).
        $MainSysEntry = $AllOmadaSystems | Where-Object { $_.DisplayName -eq 'Omada Identity' } | Select-Object -First 1
        $MainSysUId   = if ($MainSysEntry) { [string]$MainSysEntry.UId } else { $Null }
        $OmadaIdentitySystemUId = $MainSysUId
        if ($MainSysUId -and $OmadaSystemMap.ContainsKey($MainSysUId)) {
            $SystemId = $OmadaSystemMap[$MainSysUId]
        } elseif ($OmadaSystemMap.Count -gt 0) {
            $SystemId = ($OmadaSystemMap.Values | Select-Object -First 1)
        }
        Write-Host "  Main Omada IGA system ID: $SystemId (UId: $MainSysUId)" -ForegroundColor Gray
    } catch {
        Write-Host "  Warning: could not register Omada systems — $($_.Exception.Message)" -ForegroundColor Yellow
        $FbResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
            syncMode = 'full'
            records  = @(@{ systemType = 'Omada'; displayName = "Omada ($BaseUrl)"; tenantId = $BaseUrl; enabled = $True; syncEnabled = $True })
        }
        $SystemId = [int]($FbResult.systemIds[0])
        Write-Host "  Fallback system ID: $SystemId" -ForegroundColor Gray
    }
    return @{ systemId = $SystemId; omadaSystemMap = $OmadaSystemMap; allOmadaSystems = $AllOmadaSystems; omadaIdentitySystemUId = $OmadaIdentitySystemUId }
}

# ─── Summary ─────────────────────────────────────────────────────
# Prints the per-phase table, posts phase results to the jobs API, and throws if
# any phase failed (so the worker marks the job failed). Reads $Script:phases /
# $Script:phaseErrors from the caller's scope.
# Print one phase's summary line (green ok / red FAILED).
function Write-OmadaPhaseLine {
    [CmdletBinding()]
    param($Phase)
    $Status = if ($Phase.status -eq 'ok') { 'ok' } else { 'FAILED' }
    $Color  = if ($Phase.status -eq 'ok') { 'Green' } else { 'Red' }
    Write-Host ("{0,-20} {1,-10} {2}ms" -f $Phase.name, $Status, $Phase.durationMs) -ForegroundColor $Color
}

# Post per-phase results to the jobs API for the UI phase breakout (best-effort;
# a no-op when there is no job id). Extracted from Write-OmadaSummary.
function Send-OmadaPhaseResults {
    [CmdletBinding()]
    param($Phases, [int]$JobId, [string]$ApiKey, [string]$ApiBaseUrl)
    if ($JobId -le 0) { return }
    try {
        $PhasePayload = @{
            phases = @($Phases | ForEach-Object {
                    $P = @{ name = $_.name; status = $_.status; durationMs = $_.durationMs }
                    if ($_.error)   { $P.error   = $_.error }
                    if ($_.records) { $P.records = $_.records }
                    $P
                })
        }
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/jobs/$JobId/phases" -Method Post -TimeoutSec 15 `
            -Headers @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } `
            -Body ($PhasePayload | ConvertTo-Json -Depth 5 -Compress) | Out-Null
    }
    catch {
        Write-Host "  Warning: could not post phase results — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Write-OmadaSummary {
    [CmdletBinding()]
    param([datetime]$StartTime, [int]$JobId, [string]$ApiKey, [string]$ApiBaseUrl)
    $Elapsed = [datetime]::UtcNow - $StartTime
    Write-Host "`n=== Omada Crawler Summary ===" -ForegroundColor Cyan
    Write-Host ("Total time: {0:mm}m {0:ss}s" -f $Elapsed) -ForegroundColor Gray
    Write-Host ""
    Write-Host ("{0,-20} {1,-10} {2}" -f 'Phase', 'Status', 'Duration') -ForegroundColor Gray
    Write-Host ("{0,-20} {1,-10} {2}" -f ('─'*20), ('─'*10), ('─'*10)) -ForegroundColor Gray
    foreach ($P in $Script:phases) { Write-OmadaPhaseLine -Phase $P }

    Send-OmadaPhaseResults -Phases $Script:phases -JobId $JobId -ApiKey $ApiKey -ApiBaseUrl $ApiBaseUrl

    if ($Script:phaseErrors.Count -gt 0) {
        Write-Host "`nPhase errors:" -ForegroundColor Red
        foreach ($E in $Script:phaseErrors) { Write-Host "  $E" -ForegroundColor Red }
        throw "Omada sync completed with $($Script:phaseErrors.Count) phase error(s). See above for details."
    }

    Write-Host "`nOmada sync completed successfully." -ForegroundColor Green
}
