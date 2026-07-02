<#
.SYNOPSIS
    Synchronise midPoint (Evolveum) IGA data to Identity Atlas via the Ingest API.

.DESCRIPTION
    Reads midPoint's focus/projection model over the REST API and maps it onto the
    Identity Atlas universal data model:

      ResourceType (connected systems) → Systems
      OrgType                          → Contexts (OrgUnit) + ContextMembers
      RoleType                         → Resources (BusinessRole)   + ResourceRelationships (Contains, via inducement)
      ServiceType                      → Resources (Service)
      UserType (focus / person)        → Identities + a Principal (the midPoint account) + IdentityMembers
      ShadowType (accounts on systems) → Principals (per resource system) + IdentityMembers (via user.linkRef)
      user.assignment[] → Role/Service → ResourceAssignments (Direct, governed=false)
      user.parentOrgRef[]              → ContextMembers (org membership)

    midPoint object OIDs are UUIDs, so they are reused directly as Identity Atlas
    id / externalId, which makes every record traceable back to its source object.

    SAFE SYNC SCOPING — this instance may hold data from other sources (Entra, Omada,
    CSV). The Identity Atlas ingest engine reconciles (deletes stale rows) on a full
    sync. To never delete another source's data, full-sync reconcile is used ONLY for
    entities that carry a per-system scope column (Principals, Resources,
    ResourceAssignments, ResourceRelationships — scoped by systemId; Contexts — scoped
    by scopeSystemId). Cross-system tables without a system scope (Systems, Identities,
    IdentityMembers, ContextMembers) are always written in delta (upsert-only) mode.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL (e.g. http://web:3001/api).
.PARAMETER ApiKey
    Identity Atlas crawler API key (fgc_...).
.PARAMETER JobId
    Job ID for live progress reporting. 0 = standalone.
.PARAMETER ConfigPath
    Path to the JSON config file written by the dispatcher.
#>

#region Parameters
[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)
#endregion Parameters

#region Configuration
$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

if (-not (Test-Path $ConfigPath)) { throw "Config file not found: $ConfigPath" }
$Cfg       = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$RawConfig = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable

$SyncMode = if ($RawConfig['_syncMode'] -in @('full', 'delta')) { $RawConfig['_syncMode'] } else { 'full' }
$PageSize = if ($Cfg.pageSize) { [int]$Cfg.pageSize } else { 100 }

# Phase toggles — default on, overridden by selectedObjects
$Sync = @{ systems = $true; orgs = $true; roles = $true; services = $true
           users = $true; shadows = $true; orgMembership = $true
           assignments = $true; roleNesting = $true; reviews = $true }
if ($null -ne $Cfg.syncShadows) { $Sync.shadows = [bool]$Cfg.syncShadows }
$objects = $RawConfig['selectedObjects']
if ($objects) {
    foreach ($k in @($Sync.Keys)) {
        if ($objects.ContainsKey($k)) { $Sync[$k] = [bool]$objects[$k] }
    }
}

# Dot-source shared ingest helpers (Invoke-IngestAPI, Update-CrawlerProgress, ConvertTo-JsonArray)
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')

# Dot-source the crawler's own extracted functions (ingest batching/streaming, stats,
# phase-error tracking, shadow labelling). Moved out of this script verbatim so they can
# be unit-tested; dot-sourcing here is equivalent to defining them inline below.
. (Join-Path $PSScriptRoot 'MidpointCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'MidpointCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'MidpointCrawler.Phases.ps1')

# The dispatcher dot-sources Invoke-MidpointApi.ps1 (sibling library) before this
# entry point runs. For standalone invocation, load it here if absent.
if (-not (Get-Command Connect-MidpointAPI -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Invoke-MidpointApi.ps1')
}
#endregion Configuration

#region Helpers
# Cross-system tables have no per-system delete scope → never reconcile-delete them
# (would remove other sources' data). Always upsert-only (delta) for these.
$CrossSystemEntities = @('systems', 'identities', 'identity-members', 'context-members', 'governance/certifications')

$Script:phaseErrors = [System.Collections.Generic.List[string]]::new()

# ── Lightweight performance instrumentation (behaviour-neutral) ──────────────
# Master wall-clock, per-ingest-endpoint latency, and midPoint read timings, so a
# load test can attribute time to source reads vs ingest writes. Printed in the summary.
$Script:swMaster    = [System.Diagnostics.Stopwatch]::StartNew()
$Script:ingestStats = [ordered]@{}   # endpoint → @{ seconds; calls; records }
$Script:fetchStats  = [ordered]@{}   # read label → @{ seconds; count }

# ── Type-mapping configuration ───────────────────────────────────────────────
# Lets an operator override how midPoint objects are classified into Identity Atlas types:
#   archetypeMapping              role/service → resourceType  (archetype → subtype → catch-all)
#   typeMappings.orgContextType…  org          → contextType
#   typeMappings.identityType…    user         → principalType
# The helper functions (ConvertTo-MapRows, Resolve-MappedResourceType, Resolve-MappedValue,
# Get-MidpointArchetypeNames) live in Invoke-MidpointApi.ps1 so they are unit-testable. Each map
# is a list of rows; a row with a blank key is the catch-all. The shipped defaults are a single
# catch-all per map that reproduces the historical hardcoded behaviour (role→BusinessRole,
# service→Service, org→OrgUnit, user→User), so a config left at its defaults is byte-for-byte
# identical to the previous output.
$ArchetypeLabelsByOid = @{}   # archetype oid → friendly labels; populated once in the Resources phase
$ArchetypeMapping    = ConvertTo-MapRows $Cfg.archetypeMapping                  @('archetype', 'subtype', 'resourceType')
$OrgContextMapping   = ConvertTo-MapRows $Cfg.typeMappings.orgContextTypeMapping @('orgSubtype', 'contextType')
$IdentityTypeMapping = ConvertTo-MapRows $Cfg.typeMappings.identityTypeMapping   @('userType', 'principalType')
#endregion Helpers

#region Main
Write-Host "`n=== midPoint Crawler ===" -ForegroundColor Cyan
Write-Host "Base URL:    $($Cfg.baseUrl)" -ForegroundColor Gray
Write-Host "Auth method: $($Cfg.authMethod)" -ForegroundColor Gray
Write-Host "Sync mode:   $SyncMode (cross-system tables forced to delta for safety)" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Authenticating to midPoint' -Pct 2
$AuthParams = @{ BaseUrl = $Cfg.baseUrl; AuthMethod = $Cfg.authMethod }
if ($Cfg.username)      { $AuthParams['Username']      = $Cfg.username }
if ($Cfg.password)      { $AuthParams['Password']      = $Cfg.password }
if ($Cfg.apiToken)      { $AuthParams['ApiToken']      = $Cfg.apiToken }
if ($Cfg.clientId)      { $AuthParams['ClientId']      = $Cfg.clientId }
if ($Cfg.clientSecret)  { $AuthParams['ClientSecret']  = $Cfg.clientSecret }
if ($Cfg.tokenEndpoint) { $AuthParams['TokenEndpoint'] = $Cfg.tokenEndpoint }
Connect-MidpointAPI @AuthParams

# Shared cross-phase state
$RestRoot                = (Get-MidpointRestRoot -BaseUrl $Cfg.baseUrl)
$MidpointSystemId        = 0
$ResourceSystemId        = @{}                                                   # resource OID → Identity Atlas system.id
$ResourceOidToName       = @{}                                                   # resource OID → display name (for readable shadow labels)
$UserOidToName           = @{}                                                   # user OID → display name (for readable shadow labels)
$SyncedOrgIds            = [System.Collections.Generic.HashSet[string]]::new()  # OrgType OIDs synced as Contexts
$OrgOidToName            = @{}                                                   # OrgType OID → display name (for the user's department)
$SyncedResourceIds       = [System.Collections.Generic.HashSet[string]]::new()  # Role/Service + Entitlement OIDs synced as Resources
$ResourceOidToType       = @{}                                                   # OID → mapped resourceType, for governance-assignment reconcile bucketing
$AllUsers                = $null
$ShadowOidToUserOid      = @{}                                                   # shadow OID → owning user OID (from user.linkRef)
$EntitlementByDn         = @{}                                                   # normalised DN/name → entitlement shadow OID (for construction → Contains)

# ─── Phase: Systems ──────────────────────────────────────────────────────────
# midPoint itself + each ResourceType become Identity Atlas Systems.
if ($Sync.systems) {
    $sys = Sync-MidpointSystems -RestRoot $RestRoot -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey -PageSize $PageSize
    $MidpointSystemId  = $sys.midpointSystemId
    $ResourceSystemId  = $sys.resourceSystemId
    $ResourceOidToName = $sys.resourceOidToName
}

# ─── Phase: Orgs → Contexts ──────────────────────────────────────────────────
if ($Sync.orgs) {
    $orgResult = Sync-MidpointOrgs -MidpointSystemId $MidpointSystemId -OrgContextMapping $OrgContextMapping -PageSize $PageSize
    $SyncedOrgIds = $orgResult.syncedOrgIds
    $OrgOidToName = $orgResult.orgOidToName
}

# ─── Phase: Roles + Services → Resources ─────────────────────────────────────
# Roles and Services are classified to an Identity Atlas resourceType via archetypeMapping
# (archetype → subtype → catch-all → per-phase default). Records are bucketed by their mapped
# resourceType and each bucket is ingested with its own resourceType scope, so a full-sync
# reconcile never lets one type's batch delete another's. With the default mapping every
# role→BusinessRole and service→Service, i.e. one bucket each — identical to the prior behaviour.
$AllRoles = $null
if ($Sync.roles -or $Sync.services) {
    $resResult = Sync-MidpointResources -MidpointSystemId $MidpointSystemId -ArchetypeMapping $ArchetypeMapping `
        -SyncRoles $Sync.roles -SyncServices $Sync.services -PageSize $PageSize
    $AllRoles             = $resResult.allRoles
    $SyncedResourceIds    = $resResult.syncedResourceIds
    $ResourceOidToType    = $resResult.resourceOidToType
    $ArchetypeLabelsByOid = $resResult.archetypeLabels
}

# ─── Phase: Users → Identities + Principals + IdentityMembers ────────────────
if ($Sync.users) {
    $userResult = Sync-MidpointUsers -MidpointSystemId $MidpointSystemId -OrgOidToName $OrgOidToName `
        -IdentityTypeMapping $IdentityTypeMapping -PageSize $PageSize
    $AllUsers           = $userResult.allUsers
    $UserOidToName      = $userResult.userOidToName
    $ShadowOidToUserOid = $userResult.shadowOidToUserOid
}

# ─── Phase: Shadows → Accounts / Entitlements ────────────────────────────────
# A midPoint shadow is NOT always a user account. Map by `kind`:
#   account     → Principal (account) on its resource system, linked to the identity
#   entitlement → Resource (resourceType='Entitlement', e.g. an AD group); account→
#                 entitlement associations become ResourceAssignments (matrix membership)
#   generic / other → skipped (these are non-account objects such as OU/container/DB rows,
#                 and must NOT pollute the Users list)
if ($Sync.shadows -and $Sync.users) {
    $shResult = Sync-MidpointShadows -MidpointSystemId $MidpointSystemId -ResourceSystemId $ResourceSystemId `
        -ShadowOidToUserOid $ShadowOidToUserOid -SyncedResourceIds $SyncedResourceIds -PageSize $PageSize
    $EntitlementByDn = $shResult.entitlementByDn
}

# ─── Phase: Org membership → ContextMembers ──────────────────────────────────
if ($Sync.orgMembership -and $Sync.users -and $AllUsers) {
    Sync-MidpointOrgMembership -MidpointSystemId $MidpointSystemId -AllUsers $AllUsers -SyncedOrgIds $SyncedOrgIds
}

# ─── Phase: Assignments → ResourceAssignments (Direct memberships) ───────────
if ($Sync.assignments -and $Sync.users -and $AllUsers) {
    Sync-MidpointAssignments -MidpointSystemId $MidpointSystemId -AllUsers $AllUsers `
        -SyncedResourceIds $SyncedResourceIds -ResourceOidToType $ResourceOidToType
}

# ─── Phase: Role nesting → ResourceRelationships (Contains) ───────────────────
if ($Sync.roleNesting -and $AllRoles) {
    Sync-MidpointRoleNesting -MidpointSystemId $MidpointSystemId -AllRoles $AllRoles `
        -SyncedResourceIds $SyncedResourceIds -EntitlementByDn $EntitlementByDn
}

# ─── Phase: Reviews → CertificationDecisions ─────────────────────────────────
# midPoint access certification campaigns → review decisions. Each campaign case
# (objectRef=user, targetRef=role/service, outcome=accept/revoke) maps to one
# CertificationDecisions row. The case container is only returned with ?include=case.
if ($Sync.reviews) {
    Sync-MidpointReviews -MidpointSystemId $MidpointSystemId -SyncedResourceIds $SyncedResourceIds `
        -UserOidToName $UserOidToName -PageSize $PageSize
}

# ─── Refresh matrix views ────────────────────────────────────────────────────
# The matrix and several derived UI pages read from materialized views that are
# stale until refreshed; do it here so the new data is visible immediately.
Sync-MidpointRefreshViews -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey

# ─── Performance summary (load-test instrumentation) ─────────────────────────
$Script:swMaster.Stop()
Write-Host "`n── Performance ──" -ForegroundColor Cyan
Write-Host ("  Total wall-clock: {0:N1}s" -f $Script:swMaster.Elapsed.TotalSeconds) -ForegroundColor Gray
if ($Script:fetchStats.Count -gt 0) {
    Write-Host "  midPoint reads:" -ForegroundColor Gray
    foreach ($k in $Script:fetchStats.Keys) {
        $f = $Script:fetchStats[$k]
        Write-Host ("    {0,-18} {1,8:N1}s  ({2} objects)" -f $k, $f.seconds, $f.count) -ForegroundColor DarkGray
    }
}
if ($Script:ingestStats.Count -gt 0) {
    Write-Host "  Ingest API (endpoint: time / calls / records → rec/s):" -ForegroundColor Gray
    $ingTotal = 0.0
    foreach ($k in $Script:ingestStats.Keys) {
        $s = $Script:ingestStats[$k]; $ingTotal += $s.seconds
        $rps = if ($s.seconds -gt 0) { [math]::Round($s.records / $s.seconds) } else { 0 }
        Write-Host ("    {0,-26} {1,7:N1}s / {2,3} / {3,7} → {4} rec/s" -f $k, $s.seconds, $s.calls, $s.records, $rps) -ForegroundColor DarkGray
    }
    Write-Host ("    {0,-26} {1,7:N1}s total" -f 'ingest TOTAL', $ingTotal) -ForegroundColor DarkGray
}

# ─── Summary ─────────────────────────────────────────────────────────────────
Update-CrawlerProgress -Step 'Complete' -Pct 100
if ($Script:phaseErrors.Count -gt 0) {
    Write-Host "`nmidPoint crawler completed with $($Script:phaseErrors.Count) phase error(s):" -ForegroundColor Yellow
    $Script:phaseErrors | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    throw "midPoint crawler completed with errors: $($Script:phaseErrors -join '; ')"
}
Write-Host "`nmidPoint crawler completed successfully." -ForegroundColor Green
#endregion Main
