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

# Dot-source shared ingest helpers + the crawler's own extracted functions/phases
# (dot-sourcing here is equivalent to defining them inline below).
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot 'MidpointCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'MidpointCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'MidpointCrawler.Phases.ps1')

# The dispatcher dot-sources Invoke-MidpointApi.ps1 (sibling library) before this
# entry point runs. For standalone invocation, load it here if absent.
if (-not (Get-Command Connect-MidpointAPI -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Invoke-MidpointApi.ps1')
}

# Resolve the job config into phase toggles + type mappings.
$MpCfg = Resolve-MidpointConfig -ConfigPath $ConfigPath
$Cfg                  = $MpCfg.cfg
$Sync                 = $MpCfg.sync
$SyncMode             = $MpCfg.syncMode
$PageSize             = $MpCfg.pageSize
$CrossSystemEntities  = $MpCfg.crossSystemEntities   # read by Get-EntitySyncMode (script scope)
$ArchetypeMapping     = $MpCfg.archetypeMapping
$OrgContextMapping    = $MpCfg.orgContextMapping
$IdentityTypeMapping  = $MpCfg.identityTypeMapping
$ArchetypeLabelsByOid = @{}
#endregion Configuration

#region Main
# Phase-error tracking + lightweight performance instrumentation (behaviour-neutral).
$Script:phaseErrors = [System.Collections.Generic.List[string]]::new()
$Script:swMaster    = [System.Diagnostics.Stopwatch]::StartNew()
$Script:ingestStats = [ordered]@{}
$Script:fetchStats  = [ordered]@{}

Write-Host "`n=== midPoint Crawler ===" -ForegroundColor Cyan
Write-Host "Base URL:    $($Cfg.baseUrl)" -ForegroundColor Gray
Write-Host "Auth method: $($Cfg.authMethod)" -ForegroundColor Gray
Write-Host "Sync mode:   $SyncMode (cross-system tables forced to delta for safety)" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Authenticating to midPoint' -Pct 2
Connect-MidpointSession -Cfg $Cfg

# Shared cross-phase state
$RestRoot           = (Get-MidpointRestRoot -BaseUrl $Cfg.baseUrl)
$MidpointSystemId   = 0
$ResourceSystemId   = @{}
$ResourceOidToName  = @{}
$UserOidToName      = @{}
$SyncedOrgIds       = [System.Collections.Generic.HashSet[string]]::new()
$OrgOidToName       = @{}
$SyncedResourceIds  = [System.Collections.Generic.HashSet[string]]::new()
$ResourceOidToType  = @{}
$AllUsers           = $null
$AllRoles           = $null
$ShadowOidToUserOid = @{}
$EntitlementByDn    = @{}

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
# $AllUsers is $null unless the Users phase ran, so it already implies $Sync.users.
if ($Sync.orgMembership -and $AllUsers) {
    Sync-MidpointOrgMembership -MidpointSystemId $MidpointSystemId -AllUsers $AllUsers -SyncedOrgIds $SyncedOrgIds
}

# ─── Phase: Assignments → ResourceAssignments (Direct memberships) ───────────
if ($Sync.assignments -and $AllUsers) {
    Sync-MidpointAssignments -MidpointSystemId $MidpointSystemId -AllUsers $AllUsers `
        -SyncedResourceIds $SyncedResourceIds -ResourceOidToType $ResourceOidToType
}

# ─── Phase: Role nesting → ResourceRelationships (Contains) ───────────────────
# The $AllRoles guard lives inside the function (it early-returns without sending
# when there are no roles, so a full-sync reconcile can't wipe the Contains edges).
if ($Sync.roleNesting) {
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

# ─── Performance summary + completion ────────────────────────────────────────
# Emit the load-test instrumentation summary, then finalise: mark progress 100%,
# and throw if any phase recorded a non-fatal error.
Write-MidpointPerfSummary
Complete-MidpointRun
#endregion Main
