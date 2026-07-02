<#
.SYNOPSIS
    midPoint crawler sync-phase orchestrators, extracted from Start-MidpointCrawler.ps1.

.DESCRIPTION
    Each Sync-Midpoint* function owns one top-level sync phase: it runs the phase's
    midPoint reads (via the mockable Invoke-Midpoint* helpers), shapes records
    through the pure ConvertTo-*/New-* functions in MidpointCrawler.Transform.ps1,
    POSTs them through Send-IngestBatch, and records failures via Add-PhaseError.

    Dot-sourced into Start-MidpointCrawler.ps1's own scope, so they read/write the
    same $Script:phaseErrors / $Script:fetchStats state the inline blocks used to.
    Phase bodies are moved verbatim from the entry point; only the `if ($Sync...)`
    toggle stays there.

    Extracted so the phases can be unit-tested with Pester by mocking their command
    boundary (Invoke-MidpointSearch / Invoke-MidpointSearchStream / Send-IngestBatch
    / Invoke-IngestAPI) — see test/unit/MidpointCrawlerPhases.Tests.ps1 — and to
    pull cyclomatic complexity out of the entry point's untestable I/O-on-load body.

    Cross-phase state (system-id maps, synced-id sets, the $All* collections) is
    threaded through explicit params/return values instead of shared script vars.
#>

# ─── Phase: Systems ──────────────────────────────────────────────
# midPoint itself + each ResourceType that actually holds account/entitlement
# shadows become Identity Atlas Systems. RETURNS @{ midpointSystemId;
# resourceSystemId (OID -> system.id); resourceOidToName }. Critical phase —
# re-throws on failure (nothing downstream works without the system id).
function Sync-MidpointSystems {
    [CmdletBinding()]
    param(
        [string]$RestRoot,
        [string]$ApiBaseUrl,
        [string]$ApiKey,
        [int]$PageSize = 100
    )
    Write-Host "`nSystems:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Registering systems' -Pct 5
    $MidpointSystemId  = 0
    $ResourceSystemId  = @{}
    $ResourceOidToName = @{}
    try {
        $hostLabel = ([System.Uri]$RestRoot).Authority
        $sysRecords = [System.Collections.Generic.List[object]]::new()
        $sysRecords.Add([PSCustomObject]@{ systemType = 'Midpoint'; displayName = "midPoint ($hostLabel)"; tenantId = $RestRoot; enabled = $true; syncEnabled = $true })

        $resources = @(Invoke-MidpointSearch -Type 'resources' -PageSize $PageSize)
        Write-Host "  $($resources.Count) connected resources in midPoint" -ForegroundColor Gray

        # STREAM shadows (do NOT retain) to learn which resources actually hold
        # account/entitlement shadows — resources whose shadows are all generic
        # aren't registered as systems (avoids empty, confusing systems in the UI).
        $resWithData = [System.Collections.Generic.HashSet[string]]::new()
        $swShRead = [System.Diagnostics.Stopwatch]::StartNew()
        $nShadowsScan = Invoke-MidpointSearchStream -Type 'shadows' -PageSize $PageSize -Options 'raw' -Include 'association' -OnPage {
            param($page)
            foreach ($s in $page) {
                if (($s.kind -eq 'account') -or ($s.kind -eq 'entitlement')) {
                    $ro = Get-MidpointRefOid $s.resourceRef $null
                    if ($ro) { [void]$resWithData.Add($ro) }
                }
            }
        }
        $swShRead.Stop()
        $Script:fetchStats['shadows (system scan)'] = @{ seconds = $swShRead.Elapsed.TotalSeconds; count = $nShadowsScan }
        Write-Host "  scanned $nShadowsScan shadows ($($resWithData.Count) resources hold accounts/entitlements)" -ForegroundColor Gray

        foreach ($r in $resources) {
            $roid  = [string]$r.oid
            $rName = (Get-MidpointString $r.name "Resource $roid")
            $ResourceOidToName[$roid] = $rName
            if (-not $resWithData.Contains($roid)) {
                Write-Host "  Skipping system registration for '$rName' (no account/entitlement shadows)" -ForegroundColor DarkGray
                continue
            }
            $sysRecords.Add([PSCustomObject]@{ systemType = 'Midpoint'; displayName = $rName; tenantId = $roid; enabled = $true; syncEnabled = $false })
        }

        Write-Step "Registering $($sysRecords.Count) systems..."
        # Systems is cross-system (no per-system scope) → delta, never deletes other sources.
        Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{ syncMode = 'delta'; records = ConvertTo-JsonArray $sysRecords } | Out-Null

        # Build tenantId(OID) → system.id map.
        $atlasSystems = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
        foreach ($s in $atlasSystems) {
            if ($s.systemType -ne 'Midpoint' -or -not $s.tenantId) { continue }
            if ($s.tenantId -eq $RestRoot) { $MidpointSystemId = [int]$s.id }
            else { $ResourceSystemId[[string]$s.tenantId] = [int]$s.id }
        }
        if ($MidpointSystemId -eq 0) { throw "Could not resolve midPoint system id after registration" }
        Write-Host "  midPoint system id: $MidpointSystemId; resource systems: $($ResourceSystemId.Count)" -ForegroundColor Green
    } catch { Add-PhaseError 'Systems' $_.Exception.Message; throw }

    return @{ midpointSystemId = $MidpointSystemId; resourceSystemId = $ResourceSystemId; resourceOidToName = $ResourceOidToName }
}

# ─── Phase: Orgs → Contexts ──────────────────────────────────────
# OrgType → Contexts (topo-sorted parent-before-child). RETURNS @{ syncedOrgIds;
# orgOidToName } for the ContextMembers + Users (department) phases.
function Sync-MidpointOrgs {
    [CmdletBinding()]
    param(
        [int]$MidpointSystemId,
        $OrgContextMapping,
        [int]$PageSize = 100
    )
    Write-Host "`nOrgs (Contexts):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing orgs' -Pct 15
    $SyncedOrgIds = [System.Collections.Generic.HashSet[string]]::new()
    $OrgOidToName = @{}
    try {
        $orgs = @(Invoke-MidpointSearch -Type 'orgs' -PageSize $PageSize)
        Write-Host "  $($orgs.Count) orgs from midPoint" -ForegroundColor Gray
        # Per-org record shaping + the parent-before-child topo-sort live in the Transform file.
        $raw = @($orgs | ForEach-Object {
            ConvertTo-MidpointOrgContextRecord -Org $_ -OrgContextMapping $OrgContextMapping -SystemId $MidpointSystemId
        } | Where-Object { $_.id -and $_.displayName })
        $records = Sort-MidpointContextsTopologically -Records $raw

        # Scope the reconcile by variant + scopeSystemId only (a single sync can emit
        # several context types under org->contextType remapping; the crawler owns
        # every synced context for its own scopeSystemId).
        $R = Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $MidpointSystemId `
            -Scope @{ variant = 'synced'; scopeSystemId = $MidpointSystemId } -Records @($records)
        $records | ForEach-Object { [void]$SyncedOrgIds.Add($_.id); $OrgOidToName[$_.id] = $_.displayName }
        Write-Host "  Contexts: +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
    } catch { Add-PhaseError 'Orgs' $_.Exception.Message }

    return @{ syncedOrgIds = $SyncedOrgIds; orgOidToName = $OrgOidToName }
}

# ─── Refresh matrix views ────────────────────────────────────────
# The matrix + several derived pages read materialized views that are stale until
# refreshed; non-critical (a failure is a warning, not a phase error).
function Sync-MidpointRefreshViews {
    [CmdletBinding()]
    param([string]$ApiBaseUrl, [string]$ApiKey)
    Write-Host "`nRefreshing matrix views:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
    try {
        Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post `
            -Headers @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } -TimeoutSec 180 | Out-Null
        Write-Host "  Views refreshed." -ForegroundColor Green
    } catch {
        Write-Host "  Warning: refresh-views failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# Load the archetype catalog (oid -> friendly labels) once, best-effort. Only
# called when a mapping row actually keys on an archetype.
function Get-MidpointArchetypeLabels {
    [CmdletBinding()]
    param([int]$PageSize = 100)
    $labels = @{}
    try {
        $archs = @(Invoke-MidpointSearch -Type 'archetypes' -PageSize $PageSize)
        foreach ($a in $archs) {
            $l = [System.Collections.Generic.List[string]]::new()
            foreach ($v in @((Get-MidpointString $a.name ''), (Get-MidpointString $a.displayName ''), (Get-MidpointString $a.identifier ''))) {
                if ($v -and -not $l.Contains($v)) { $l.Add($v) }
            }
            if ($a.oid) { $labels[[string]$a.oid] = @($l) }
        }
        Write-Host "  loaded $($archs.Count) archetypes for role classification" -ForegroundColor DarkGray
    } catch {
        Write-Host "  (archetype catalog unavailable — falling back to subtype/default: $($_.Exception.Message))" -ForegroundColor Yellow
    }
    return $labels
}

# Bucket a resource record by its mapped resourceType and remember the mapping
# (governance assignments reconcile-bucket by resourceType). Mutates the passed
# ordered map + oid->type hashtable.
function Add-MidpointResourceByType {
    [CmdletBinding()]
    param($ResByType, $ResourceOidToType, [string]$Type, $Rec)
    if (-not $ResByType.Contains($Type)) { $ResByType[$Type] = [System.Collections.Generic.List[object]]::new() }
    $ResByType[$Type].Add($Rec)
    $ResourceOidToType[[string]$Rec.id] = $Type
}

# Classify + shape each role into its resourceType bucket (archetype -> subtype ->
# catch-all -> BusinessRole). Mutates $ResByType/$ResourceOidToType/$SyncedResourceIds.
function Add-MidpointRoleResources {
    [CmdletBinding()]
    param($Roles, $ArchetypeMapping, [hashtable]$ArchetypeLabels = @{}, $ResByType, $ResourceOidToType, $SyncedResourceIds)
    Write-Host "  $(@($Roles).Count) roles from midPoint" -ForegroundColor Gray
    foreach ($r in $Roles) {
        $oid  = [string]$r.oid
        $disp = (Get-MidpointString $r.displayName (Get-MidpointString $r.name $oid))
        if (-not $oid -or -not $disp) { continue }
        $subs      = Get-MidpointStringList $r.subtype; if ($subs.Count -eq 0) { $subs = Get-MidpointStringList $r.roleType }
        $archNames = Get-MidpointArchetypeNames -Obj $r -LabelsByOid $ArchetypeLabels
        $rt        = Resolve-MappedResourceType -Rows $ArchetypeMapping -ArchetypeNames $archNames -Subtypes $subs -Default 'BusinessRole'
        Add-MidpointResourceByType -ResByType $ResByType -ResourceOidToType $ResourceOidToType -Type $rt `
            -Rec (ConvertTo-MidpointRoleResourceRecord -Role $r -ResourceType $rt -ArchetypeNames $archNames)
        [void]$SyncedResourceIds.Add($oid)
    }
}

# Services are always resourceType 'Service' (archetypeMapping is a role classifier
# and must not bleed into services). Mutates the same accumulators.
function Add-MidpointServiceResources {
    [CmdletBinding()]
    param($Services, $ResByType, $ResourceOidToType, $SyncedResourceIds)
    Write-Host "  $(@($Services).Count) services from midPoint" -ForegroundColor Gray
    foreach ($s in $Services) {
        $oid  = [string]$s.oid
        $disp = (Get-MidpointString $s.displayName (Get-MidpointString $s.name $oid))
        if (-not $oid -or -not $disp) { continue }
        Add-MidpointResourceByType -ResByType $ResByType -ResourceOidToType $ResourceOidToType -Type 'Service' `
            -Rec (ConvertTo-MidpointServiceResourceRecord -Service $s)
        [void]$SyncedResourceIds.Add($oid)
    }
}

# ─── Phase: Roles + Services → Resources ─────────────────────────
# Roles/Services classified into a resourceType via archetypeMapping and ingested
# per-type (each bucket its own reconcile scope). RETURNS @{ allRoles;
# syncedResourceIds; resourceOidToType; archetypeLabels }.
function Sync-MidpointResources {
    [CmdletBinding()]
    param(
        [int]$MidpointSystemId,
        $ArchetypeMapping,
        [bool]$SyncRoles = $true,
        [bool]$SyncServices = $true,
        [int]$PageSize = 100
    )
    Write-Host "`nResources (Roles + Services):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing roles and services' -Pct 30
    $AllRoles = $null
    $SyncedResourceIds = [System.Collections.Generic.HashSet[string]]::new()
    $ResourceOidToType = @{}
    $ArchetypeLabels   = @{}
    $resByType = [ordered]@{}

    # Load the archetype catalog once, only when a mapping row keys on an archetype.
    if (@($ArchetypeMapping | Where-Object { $_.archetype }).Count -gt 0) {
        $ArchetypeLabels = Get-MidpointArchetypeLabels -PageSize $PageSize
    }

    if ($SyncRoles) {
        try {
            $AllRoles = @(Invoke-MidpointSearch -Type 'roles' -PageSize $PageSize)
            Add-MidpointRoleResources -Roles $AllRoles -ArchetypeMapping $ArchetypeMapping -ArchetypeLabels $ArchetypeLabels `
                -ResByType $resByType -ResourceOidToType $ResourceOidToType -SyncedResourceIds $SyncedResourceIds
        } catch { Add-PhaseError 'Roles' $_.Exception.Message }
    }
    if ($SyncServices) {
        try {
            $services = @(Invoke-MidpointSearch -Type 'services' -PageSize $PageSize)
            Add-MidpointServiceResources -Services $services -ResByType $resByType `
                -ResourceOidToType $ResourceOidToType -SyncedResourceIds $SyncedResourceIds
        } catch { Add-PhaseError 'Services' $_.Exception.Message }
    }

    foreach ($t in @($resByType.Keys)) {
        try {
            $recs = @($resByType[$t])
            $R = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $MidpointSystemId -Scope @{ resourceType = $t } -Records $recs
            Write-Host "  Resources($t): +$($R.inserted) ~$($R.updated) -$($R.deleted) (from $($recs.Count))" -ForegroundColor Green
        } catch { Add-PhaseError "Resources($t)" $_.Exception.Message }
    }

    return @{ allRoles = $AllRoles; syncedResourceIds = $SyncedResourceIds; resourceOidToType = $ResourceOidToType; archetypeLabels = $ArchetypeLabels }
}

# ─── Phase: Users → Identities + Principals + IdentityMembers ────
# UserType → Identities + one focus Principal per user (bucketed by principalType)
# + IdentityMembers. Captures user.linkRef (shadow OIDs) for the Shadows phase.
# RETURNS @{ allUsers; userOidToName; shadowOidToUserOid }.
function Sync-MidpointUsers {
    [CmdletBinding()]
    param(
        [int]$MidpointSystemId,
        [hashtable]$OrgOidToName = @{},
        $IdentityTypeMapping,
        [int]$PageSize = 100
    )
    Write-Host "`nUsers (Identities + Principals):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing users' -Pct 45
    $AllUsers = $null
    $UserOidToName = @{}
    $ShadowOidToUserOid = @{}
    try {
        $AllUsers = @(Measure-MidpointFetch 'users (read)' { Invoke-MidpointSearch -Type 'users' -PageSize $PageSize })
        Write-Host "  $($AllUsers.Count) users from midPoint" -ForegroundColor Gray

        $identRecs   = [System.Collections.Generic.List[object]]::new()
        $princByType = [ordered]@{}
        $memberRecs  = [System.Collections.Generic.List[object]]::new()

        foreach ($u in $AllUsers) {
            $oid  = [string]$u.oid
            $name = (Get-MidpointString $u.fullName (Get-MidpointString $u.name $oid))
            $UserOidToName[$oid] = $name
            $department = (Resolve-MidpointDepartment -User $u -OrgMap $OrgOidToName)
            $uTypes = Get-MidpointStringList $u.subtype; if ($uTypes.Count -eq 0) { $uTypes = Get-MidpointStringList $u.employeeType }
            $pt = Resolve-MappedValue -Values $uTypes -Rows $IdentityTypeMapping -KeyName 'userType' -ValName 'principalType' -Default 'User'
            $identRecs.Add((ConvertTo-MidpointIdentityRecord -User $u -DisplayName $name -Department $department))
            if (-not $princByType.Contains($pt)) { $princByType[$pt] = [System.Collections.Generic.List[object]]::new() }
            $princByType[$pt].Add((ConvertTo-MidpointFocusPrincipalRecord -User $u -DisplayName $name -Department $department -PrincipalType $pt))
            $memberRecs.Add((New-MidpointIdentityMemberRecord -Oid $oid))

            # Capture linkRef (shadow OIDs) for the Shadows phase.
            $links = $u.linkRef
            if ($links) {
                foreach ($lr in @($links)) {
                    $shadowOid = Get-MidpointRefOid $lr $null
                    if ($shadowOid) { $ShadowOidToUserOid[$shadowOid] = $oid }
                }
            }
        }

        $R1 = Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $MidpointSystemId -Records @($identRecs)
        Write-Host "  Identities: +$($R1.inserted) ~$($R1.updated) -$($R1.deleted)" -ForegroundColor Green
        foreach ($pt in @($princByType.Keys)) {
            $precs = @($princByType[$pt])
            $R2 = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $MidpointSystemId -Scope @{ principalType = $pt } -Records $precs
            Write-Host "  Principals($pt): +$($R2.inserted) ~$($R2.updated) -$($R2.deleted) (from $($precs.Count))" -ForegroundColor Green
        }
        $R3 = Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $MidpointSystemId -Records @($memberRecs)
        Write-Host "  IdentityMembers: +$($R3.inserted) ~$($R3.updated) -$($R3.deleted)" -ForegroundColor Green
    } catch { Add-PhaseError 'Users' $_.Exception.Message }

    return @{ allUsers = $AllUsers; userOidToName = $UserOidToName; shadowOidToUserOid = $ShadowOidToUserOid }
}

# Shadows pass A: fold one page of shadows into the account/entitlement/member
# accumulators. Accounts -> per-system principal records (+ identity-member link
# when the owning user is known); entitlements -> per-system resource records
# (indexed by DN in $EntitlementByDn for the Role-nesting phase); generic/other
# skipped. Mutates the passed accumulators.
function Add-MidpointShadowPage {
    [CmdletBinding()]
    param(
        $Page, [hashtable]$ResourceSystemId, [hashtable]$ShadowOidToUserOid,
        [hashtable]$AcctBySystem, [hashtable]$EntBySystem, $ShadowMembers,
        [hashtable]$Skipped, $SyncedResourceIds, [hashtable]$EntitlementByDn
    )
    foreach ($s in $Page) {
        $resOid = Get-MidpointRefOid $s.resourceRef $null
        if (-not $resOid -or -not $ResourceSystemId.ContainsKey($resOid)) { continue }   # skip shadows on un-synced resources
        $sysId     = $ResourceSystemId[$resOid]
        $shadowOid = [string]$s.oid
        $kind      = if ($s.kind) { [string]$s.kind } else { '' }

        if ($kind -eq 'account') {
            if (-not $AcctBySystem.ContainsKey($sysId)) { $AcctBySystem[$sysId] = [System.Collections.Generic.List[object]]::new() }
            $AcctBySystem[$sysId].Add((ConvertTo-MidpointAccountShadowRecord -Shadow $s -ShadowOid $shadowOid -ResourceOid $resOid -Kind $kind))
            if ($ShadowOidToUserOid.ContainsKey($shadowOid)) {
                $ShadowMembers.Add([PSCustomObject]@{ identityId = $ShadowOidToUserOid[$shadowOid]; principalId = $shadowOid; accountType = 'Account'; isPrimary = $false })
            }
        }
        elseif ($kind -eq 'entitlement') {
            if (-not $EntBySystem.ContainsKey($sysId)) { $EntBySystem[$sysId] = [System.Collections.Generic.List[object]]::new() }
            $EntBySystem[$sysId].Add((ConvertTo-MidpointEntitlementResourceRecord -Shadow $s -ShadowOid $shadowOid -ResourceOid $resOid))
            [void]$SyncedResourceIds.Add($shadowOid)
            # Index by DN so construction/associationTargetSearch inducements resolve later.
            $dnNameKey = ConvertTo-MidpointDnKey (Get-MidpointString $s.name '')
            if ($dnNameKey) { $EntitlementByDn[$dnNameKey] = $shadowOid }
            $riDnKey = ConvertTo-MidpointDnKey ([string](Get-MidpointAttrValue -Shadow $s -Keys @('dn')))
            if ($riDnKey) { $EntitlementByDn[$riDnKey] = $shadowOid }
        }
        else { if ($kind -eq 'generic') { $Skipped.generic++ } else { $Skipped.other++ } }
    }
}

# Collect the entitlement shadow OIDs an account shadow points at — both the
# legacy `association[]` form (shadowRef / identifier) and the midPoint 4.9
# `referenceAttributes.<name>[]` form. Pure; returns a flat list of OIDs.
function Get-MidpointShadowEntitlementOids {
    [CmdletBinding()]
    param($Shadow)
    $out = [System.Collections.Generic.List[string]]::new()
    if ($Shadow.association) {
        foreach ($assoc in @($Shadow.association)) {
            $entOid = Get-MidpointRefOid $assoc.shadowRef $null
            if (-not $entOid) { $entOid = Get-MidpointRefOid $assoc.identifier $null }
            if ($entOid) { $out.Add($entOid) }
        }
    }
    if ($Shadow.referenceAttributes) {
        foreach ($refProp in $Shadow.referenceAttributes.PSObject.Properties) {
            if ($refProp.Name -eq '@ns' -or $null -eq $refProp.Value) { continue }
            foreach ($ref in @($refProp.Value)) {
                $o = Get-MidpointRefOid $ref $null
                if ($o) { $out.Add($o) }
            }
        }
    }
    return @($out)
}

# Shadows pass B: fold one page of account shadows into per-system entitlement-
# assignment streams. Each account -> entitlement ref becomes a Direct assignment
# on the owner focus principal, deduped on (entitlementOid|ownerOid). Mutates the
# passed stream map.
function Add-MidpointEntitlementAssignmentPage {
    [CmdletBinding()]
    param($Page, [hashtable]$ResourceSystemId, [hashtable]$ShadowOidToUserOid, [hashtable]$EntAssignStreams, $EntAssignSeen)
    foreach ($s in $Page) {
        if ($s.kind -ne 'account') { continue }
        $resOid = Get-MidpointRefOid $s.resourceRef $null
        if (-not $resOid -or -not $ResourceSystemId.ContainsKey($resOid)) { continue }
        $sysId     = $ResourceSystemId[$resOid]
        $shadowOid = [string]$s.oid
        $ownerOid  = if ($ShadowOidToUserOid.ContainsKey($shadowOid)) { $ShadowOidToUserOid[$shadowOid] } else { $shadowOid }
        foreach ($entOid in (Get-MidpointShadowEntitlementOids -Shadow $s)) {
            if (-not $EntAssignSeen.Add("$entOid|$ownerOid")) { continue }
            if (-not $EntAssignStreams.ContainsKey($sysId)) {
                $EntAssignStreams[$sysId] = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId $sysId -Scope @{ assignmentType = 'Direct'; resourceType = 'Entitlement' }
            }
            Add-IngestStreamRecord -Stream $EntAssignStreams[$sysId] -Record (New-MidpointEntitlementAssignmentRecord -EntitlementOid $entOid -OwnerOid $ownerOid -ViaAccount $shadowOid)
        }
    }
}

# ─── Phase: Shadows → Accounts / Entitlements ────────────────────
# Two streaming passes (memory bounded regardless of volume):
#   Pass A — accounts -> Principals, entitlements -> Resources, account links.
#            Entitlements MUST land before assignments (resource FK).
#   Pass B — account -> entitlement memberships -> Direct ResourceAssignments,
#            streamed per system. RETURNS @{ entitlementByDn } for Role nesting.
# Consumes (and augments) $SyncedResourceIds with the entitlement OIDs.
function Sync-MidpointShadows {
    [CmdletBinding()]
    param(
        [int]$MidpointSystemId,
        [hashtable]$ResourceSystemId = @{},
        [hashtable]$ShadowOidToUserOid = @{},
        $SyncedResourceIds,
        [int]$PageSize = 100
    )
    Write-Host "`nShadows (accounts + entitlements):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing shadows' -Pct 60
    $EntitlementByDn = @{}
    try {
        $acctBySystem  = @{}
        $entBySystem   = @{}
        $shadowMembers = [System.Collections.Generic.List[object]]::new()
        $skipped = @{ generic = 0; other = 0 }

        $swPassA = [System.Diagnostics.Stopwatch]::StartNew()
        $nPassA = Invoke-MidpointSearchStream -Type 'shadows' -PageSize $PageSize -Options 'raw' -Include 'association' -OnPage {
            param($page)
            Add-MidpointShadowPage -Page $page -ResourceSystemId $ResourceSystemId -ShadowOidToUserOid $ShadowOidToUserOid `
                -AcctBySystem $acctBySystem -EntBySystem $entBySystem -ShadowMembers $shadowMembers -Skipped $skipped `
                -SyncedResourceIds $SyncedResourceIds -EntitlementByDn $EntitlementByDn
        }
        $swPassA.Stop(); $Script:fetchStats['shadows (pass A)'] = @{ seconds = $swPassA.Elapsed.TotalSeconds; count = $nPassA }

        # Entitlements first (assignments in pass B satisfy the resource FK), then accounts, then members.
        $totalEnt = 0
        foreach ($sysId in $entBySystem.Keys) {
            $recs = @($entBySystem[$sysId]); $totalEnt += $recs.Count
            $R = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $sysId -Scope @{ resourceType = 'Entitlement' } -Records $recs
            Write-Host "  Entitlements (resources, system $sysId): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        }
        $totalAcct = 0
        foreach ($sysId in $acctBySystem.Keys) {
            $recs = @($acctBySystem[$sysId]); $totalAcct += $recs.Count
            $R = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $sysId -Scope @{ principalType = 'User' } -Records $recs
            Write-Host "  Accounts (principals, system $sysId): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        }
        if ($shadowMembers.Count -gt 0) {
            $R = Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $MidpointSystemId -Records @($shadowMembers)
            Write-Host "  IdentityMembers (account links): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
        }

        # PASS B — person -> entitlement assignments, streamed per system.
        $entAssignStreams = @{}
        $entAssignSeen    = [System.Collections.Generic.HashSet[string]]::new()
        $swPassB = [System.Diagnostics.Stopwatch]::StartNew()
        $nPassB = Invoke-MidpointSearchStream -Type 'shadows' -PageSize $PageSize -Options 'raw' -Include 'association' -OnPage {
            param($page)
            Add-MidpointEntitlementAssignmentPage -Page $page -ResourceSystemId $ResourceSystemId `
                -ShadowOidToUserOid $ShadowOidToUserOid -EntAssignStreams $entAssignStreams -EntAssignSeen $entAssignSeen
        }
        $swPassB.Stop(); $Script:fetchStats['shadows (pass B)'] = @{ seconds = $swPassB.Elapsed.TotalSeconds; count = $nPassB }

        $totalEntAssign = 0
        foreach ($sysId in $entAssignStreams.Keys) {
            $st = $entAssignStreams[$sysId]
            Complete-IngestStream -Stream $st
            $totalEntAssign += $st.Records
            Write-Host "  Entitlement assignments (system $sysId): +$($st.Inserted) ~$($st.Updated) -$($st.Deleted) (streamed $($st.Records))" -ForegroundColor Green
        }
        Write-Host "  Accounts: $totalAcct | Entitlements: $totalEnt | Entitlement-memberships: $totalEntAssign | skipped generic/other: $($skipped.generic)/$($skipped.other)" -ForegroundColor Gray
    } catch { Add-PhaseError 'Shadows' $_.Exception.Message }

    return @{ entitlementByDn = $EntitlementByDn }
}
