<#
.SYNOPSIS
    Orchestrates a full Entra ID sync via the FortigiGraph Ingest API.

.DESCRIPTION
    Standalone crawler that fetches data from Microsoft Graph and POSTs it to the Ingest API.
    Replaces the old Start-FGSync direct-SQL approach with an API-driven architecture.

    Requires:
    - FortigiGraph module (for Graph API functions: Get-FGAccessToken, Invoke-FGGetRequest)
    - Ingest API running and accessible
    - Crawler API key (fgc_...)

.PARAMETER ApiBaseUrl
    Base URL of the Ingest API (e.g., https://myapp.azurewebsites.net/api)

.PARAMETER ApiKey
    Crawler API key (fgc_...)

.PARAMETER ConfigFile
    Path to FortigiGraph config file (for Graph API credentials)

.PARAMETER SyncPrincipals
    Sync user principals (default: true)

.PARAMETER SyncServicePrincipals
    Sync service principals (default: false)

.PARAMETER SyncResources
    Sync groups, directory roles, app roles (default: true)

.PARAMETER SyncAssignments
    Sync group memberships, owners, eligible members (default: true)

.PARAMETER SyncGovernance
    Sync catalogs, access packages, policies, reviews (default: true)

.PARAMETER SyncOAuth2Grants
    Sync OAuth2 delegated permission grants — per-user consents (a user
    authorized app X to call API Y with scope Z on their behalf). Tenant-wide
    (AllPrincipals) grants are skipped because they don't represent a
    user-specific authorization decision. Default: false.

.PARAMETER SyncAppRoles
    Sync application role assignments — for each enterprise application,
    fetch the catalog of appRoles[] and the assignments to users/groups.
    Direct user assignments become 'Direct' rows; group-typed assignments
    are expanded to per-user 'Indirect' rows so the matrix surfaces indirect
    access. Both carry resourceType='AppRole'. ServicePrincipal-typed
    assignments are skipped (those would need SP-as-principal which the
    data model doesn't yet support). Default: false.

.PARAMETER SyncAppOwners
    Sync application + service-principal owners — modelled as ownership
    resources (ApplicationOwnership for app-registration owners, who can add a
    credential and authenticate as the app; ServicePrincipalOwnership for
    enterprise-app owners) hanging off the app's Application resource via a
    distinct 'HasAppOwnership' relationship, with a Direct assignment per owner.
    Ensures the parent Application resource exists for owned apps that have no
    roles/grants. Owners are fetched per app/SP (no bulk Graph endpoint), so this
    can be slow on large tenants. Default: false.

.PARAMETER SyncAppPermissions
    Sync application permissions — the app-only (admin-consented) permissions each
    service principal, managed identity, or AI agent holds on other APIs (e.g. an SP
    with Mail.Read on Microsoft Graph), the sibling of the delegated OAuth2 grants.
    Modelled as ApplicationPermission resources (one per clientSP, target API, appRole)
    linked to the client Application via 'HasApplicationPermission', with a Direct
    assignment whose principal is the holding SP. Fetched per-SP (no bulk endpoint),
    so slow on large tenants. Default: false.

.PARAMETER SyncPrincipalRelationships
    Sync principal→principal relationships — the owners of AI agents and the
    sponsors of guest accounts, stored in PrincipalRelationships. Owners are read
    from /servicePrincipals/{agent}/owners (for SPs classified principalType=
    'AIAgent'); sponsors from /users/{guest}/sponsors. Modelled as an Owner /
    Sponsor link between two Principals (the agent/guest is the subject, the
    owner/sponsor the related principal), surfaced on the entity's relations tab.
    Fetched per-agent / per-guest (no bulk Graph endpoint) but only over agents +
    guests, so much cheaper than SyncAppOwners. Default: false.

.PARAMETER SyncDirectoryRoles
    Sync Entra ID directory roles — the role catalog (roleDefinitions,
    including each role's granular allowedResourceActions), active role
    assignments, and PIM-eligible role assignments. Roles are stored as
    Resources(resourceType='EntraDirectoryRole'); assignments use 'Direct'
    (active) and 'Eligible' (eligible), both with resourceType='EntraDirectoryRole'.
    Group-typed assignments are recorded against the group principal but not
    yet expanded to members. Default: false.

.PARAMETER RefreshViews
    Refresh materialized SQL views after sync (default: true)

.EXAMPLE
    .\Start-EntraIDCrawler.ps1 -ApiBaseUrl "https://myapp.azurewebsites.net/api" -ApiKey "fgc_abc123..." -ConfigFile ".\Config\mycompany.json"
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)

# Read full job config and derive all crawler variables from it.
# This replaces the many named parameters previously splatted by the dispatcher.
$RawConfig = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable

# Build a synthetic ConfigFile so Get-FGAccessToken can be called with -ConfigFile.
# The Graph SDK expects { Graph: { TenantId, ClientId, ClientSecret } }.
$_graphConfigFile = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.json'
try {
    @{ Graph = @{
        TenantId     = $RawConfig['tenantId']
        ClientId     = $RawConfig['clientId']
        ClientSecret = $RawConfig['clientSecret']
    }} | ConvertTo-Json -Depth 5 | Set-Content $_graphConfigFile -Encoding UTF8
} catch {
    Remove-Item $_graphConfigFile -Force -ErrorAction SilentlyContinue
    throw
}
$ConfigFile = $_graphConfigFile  # used by Get-FGAccessToken and Graph SDK helpers

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.AppRoles.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.Phases.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.AppOwners.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.AppPermissions.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.PrincipalRelationships.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.Orchestration.ps1')
. (Join-Path $PSScriptRoot 'EntraIDCrawler.AttributeLabels.ps1')

# Resolve all sync toggles + attribute lists from the job config.
$cfg = Resolve-EntraSyncConfig -RawConfig $RawConfig
$SyncMode              = $cfg.SyncMode
$SyncPrincipals        = $cfg.SyncPrincipals
$SyncServicePrincipals = $cfg.SyncServicePrincipals
$SyncResources         = $cfg.SyncResources
$SyncAssignments       = $cfg.SyncAssignments
$SyncGovernance        = $cfg.SyncGovernance
$SyncPim               = $cfg.SyncPim
$SyncSignInLogs        = $cfg.SyncSignInLogs
$SyncOAuth2Grants      = $cfg.SyncOAuth2Grants
$SyncAppRoles          = $cfg.SyncAppRoles
$SyncAppOwners         = $cfg.SyncAppOwners
$SyncAppPermissions    = $cfg.SyncAppPermissions
$SyncPrincipalRelationships = $cfg.SyncPrincipalRelationships
$SyncDirectoryRoles    = $cfg.SyncDirectoryRoles
$RefreshViews          = $cfg.RefreshViews
$SignInLogsDays        = $cfg.SignInLogsDays
$CustomUserAttributes  = $cfg.CustomUserAttributes
$CustomGroupAttributes = $cfg.CustomGroupAttributes
$AINamePatterns        = $cfg.AINamePatterns
$IdentityFilter        = $cfg.IdentityFilter

# ─── Main ─────────────────────────────────────────────────────────

# Collected phase failures. Each main sync phase catches its own exceptions and
# appends a short summary here so the crawl can continue. At end-of-run, if the
# list is non-empty, we throw — the worker scheduler then marks the job
# `failed` with a message listing all phase failures. This prevents the
# April 2026 class of bug where silent phase 400s left the job marked
# "completed successfully" even though users/reviews/policies were missing.
$script:phaseErrors = [System.Collections.Generic.List[string]]::new()

# Structured per-phase outcomes: one entry per phase (and per sub-phase in
# governance). Posted as `phases` on the final sync-log write so the UI can
# render a proper per-phase breakdown instead of parsing the single-line
# errorMessage text. Shape is one hashtable per phase with:
#   name, status ('ok' | 'failed'), durationMs, error?, records?
$script:phases = [System.Collections.Generic.List[object]]::new()

$systemId = Initialize-EntraCrawlerRun -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey -ConfigFile $ConfigFile

$syncStart = Get-Date

# ─── Attribute display names ─────────────────────────────────────
# Stamp the friendly name for every configured directory-extension attribute onto
# the System, so a name like `extension_<appId>_sfTeamID` reads `sfTeamID` in the
# UI and the Excel export while the stored key stays exactly what Entra calls it.
# Runs before the data phases (it depends only on config) and no-ops when no
# configured attribute is extension-shaped.
Sync-EntraAttributeDisplayNames -TenantId $Global:TenantId `
    -CustomUserAttributes $CustomUserAttributes -CustomGroupAttributes $CustomGroupAttributes | Out-Null

# Sentinel resourceId for aggregate per-principal activity rows (the DEFAULT on
# the PrincipalActivity.resourceId column). Shared by the Principals and Service
# Principals phases — defined here, not inside a phase, so neither phase depends
# on the other having run first.
$aggResourceId = '00000000-0000-0000-0000-000000000000'

# Per-phase timings. Each major `if ($Sync...)` block stops a Stopwatch at
# its end and records the elapsed time here. Printed as a table at the end
# so operators can see where the crawl actually spent its time without
# needing to instrument downstream logs. Ordered so the Summary prints in
# execution order.
$phaseTimings = [ordered]@{}

# ─── Sync Principals ─────────────────────────────────────────────
if ($SyncPrincipals) {
    Sync-EntraPrincipals -SystemId $systemId -SyncMode $SyncMode `
        -CustomUserAttributes $CustomUserAttributes -IdentityFilter $IdentityFilter -Timings $phaseTimings
}

# ─── Sync Service Principals ─────────────────────────────────────
# $sps is fetched here and reused by the Sign-in Logs phase below, so it's
# initialized up front and only (re)assigned when this phase runs.
$sps = @()
if ($SyncServicePrincipals) {
    $sps = Sync-EntraServicePrincipals -SystemId $systemId -SyncMode $SyncMode `
        -AINamePatterns $AINamePatterns -AggregateResourceId $aggResourceId -Timings $phaseTimings
}

# ─── Sync Sign-in Logs (per-(user, app) activity) ────────────────
# Aggregates /auditLogs/signIns events from the last $SignInLogsDays days
# into per-(user, app) last-activity rows (granularity B). Each event is
# O(1) work; the sum is kept in a hashtable keyed by "$userId|$appSpId"
# so the peak memory is bounded by the number of DISTINCT pairs, not
# event count. Tenants with millions of events/week still aggregate to
# ~O(users × apps) entries — well within PowerShell's reach.
#
# Requires AuditLog.Read.All (already in the base permission set). The
# block also resolves app appId → SP principalId on the fly via
# /servicePrincipals so it works whether or not the SP sync ran this run.
if ($SyncSignInLogs) {
    Sync-EntraSignInLogs -SystemId $systemId -Sps $sps -SignInLogsDays $SignInLogsDays -Timings $phaseTimings
}

# ─── Sync Resources (Groups) ─────────────────────────────────────
# $groups is fetched here and reused by the Assignments and PIM phases below, so
# it's initialized up front and only (re)assigned when the Resources phase runs.
$groups = @()
if ($SyncResources) {
    $groups = Sync-EntraResources -SystemId $systemId -CustomGroupAttributes $CustomGroupAttributes -Timings $phaseTimings
}

# ─── Sync Assignments (Group Members + Owners) ───────────────────
if ($SyncAssignments) {
    Sync-EntraAssignments -SystemId $systemId -Groups $groups -Timings $phaseTimings
}

# ─── Sync PIM (Eligible group memberships) ───────────────────────
# Privileged Identity Management gives users "Eligible" (not active) membership
# in groups. The Graph endpoint requires a `$filter=groupId eq '<id>'` — there
# is no supported "list all" variant (an earlier attempt to drop the filter
# returned 400). On a 9k-group tenant this phase is ~25 min; optimisation is
# a separate problem (Graph $batch or a different endpoint). For now we
# accept the duration in exchange for correctness.
if ($SyncPim) {
    Sync-EntraPim -SystemId $systemId -Groups $groups -Timings $phaseTimings
}

# ─── Sync Governance ─────────────────────────────────────────────
if ($SyncGovernance) {
    Sync-EntraGovernance -SystemId $systemId -Timings $phaseTimings
}

# ─── Sync OAuth2 Delegated Grants ────────────────────────────────
# Per-user consent grants: user authorized client-app X to call target-API Y on
# their behalf with scope Z. Modelled as a child-resource tree:
#
#     Resources(Application)           <-- client SP (the app that got delegated-to)
#       └─ ResourceRelationships(DelegatesScope)
#            └─ Resources(DelegatedPermission)   <-- synthetic per (client, api, scope)
#                 └─ ResourceAssignments(Direct, resourceType=DelegatedPermission)  <-- one row per consenting user
#
# The scope resource ID is deterministic over (clientSpId, targetApiSpId, scope)
# so re-runs idempotently overwrite the same rows. Tenant-wide consents
# (consentType='AllPrincipals', principalId=null) are skipped — they don't
# represent a user-specific decision. A distinct relationshipType (
# 'DelegatesScope' not 'Contains') keeps the scoped full-sync delete from
# wiping out the Access Package 'Contains' relationships produced by the
# governance sync above.
# (dispatched together with the other application phases below, via
# Invoke-EntraApplicationPhases — grouped to keep this entry-point body thin)

# ─── Sync App Role Assignments ───────────────────────────────────
# For each enterprise application (servicePrincipal), pull the appRoles[]
# catalog and the assignments to users/groups. Modelled as:
#
#     Resources(Application)          <-- the enterprise app (SP)
#       └─ ResourceRelationships(HasAppRole)
#            └─ Resources(AppRole)    <-- synthetic per (SP, appRoleId)
#                 └─ ResourceAssignments(Direct | Indirect, resourceType=AppRole)
#
# Group-typed assignments are expanded server-side from /transitiveMembers,
# emitted as `Indirect` rows per member (resourceType=AppRole) so the matrix
# can show indirect access without a recursive matview. ServicePrincipal-typed
# assignments are skipped — the data model doesn't support SP-as-principal
# yet, and they're rare.
#
# Resource IDs are deterministic over (spId, appRoleId) so re-runs
# idempotently overwrite the same rows. A distinct relationshipType
# ('HasAppRole' not 'Contains') prevents the scoped full-sync delete
# from wiping out Access Package 'Contains' relationships.
# (dispatched below via Invoke-EntraApplicationPhases)

# ─── Sync App Owners ─────────────────────────────────────────────
# Owners of Entra apps + service principals, modelled as ownership resources
# (ApplicationOwnership / ServicePrincipalOwnership) hanging off the Application
# resource via a distinct 'HasAppOwnership' relationship. Runs after AppRoles /
# OAuth2 so its ensure-exists Application upsert (SyncMode 'delta') is the final
# word rather than clobbering their full-sync. Opt-in — owners are fetched
# per-SP / per-app (no bulk Graph endpoint), so this can be slow on large tenants.
# (dispatched below via Invoke-EntraApplicationPhases)

# ─── Sync Application Permissions ────────────────────────────────
# The app-only (admin-consented) permissions each service principal — including
# managed identities and AI agents — holds on other APIs (e.g. an SP with Mail.Read
# on Microsoft Graph). The sibling of the delegated OAuth2 grants. Modelled as
# ApplicationPermission resources hung off the client Application via
# 'HasApplicationPermission', with a Direct assignment whose principal is the SP
# itself. Runs after AppRoles/OAuth2 so its ensure-exists Application upsert (delta)
# is the final word. Opt-in — fetched per-SP (no bulk endpoint).
# The four application / service-principal permission phases above run here, in order,
# each gated by its own toggle. Grouped into one dispatcher so this body stays under the
# per-unit complexity ratchet (every inline `if ($SyncX)` guard is a decision point).
Invoke-EntraApplicationPhases -SystemId $systemId -AINamePatterns $AINamePatterns -Timings $phaseTimings `
    -SyncOAuth2Grants $SyncOAuth2Grants -SyncAppRoles $SyncAppRoles `
    -SyncAppOwners $SyncAppOwners -SyncAppPermissions $SyncAppPermissions `
    -SyncPrincipalRelationships $SyncPrincipalRelationships

# ─── Sync Directory Roles ────────────────────────────────────────
# Entra ID directory roles (Global Administrator, Privileged Role
# Administrator, etc.). Three Graph reads, modelled as:
#
#     Resources(EntraDirectoryRole)   <-- one per roleDefinition (id = roleDefinitionId)
#       └─ ResourceAssignments(Direct, resourceType=EntraDirectoryRole)     <-- active (permanent or PIM-activated)
#       └─ ResourceAssignments(Eligible, resourceType=EntraDirectoryRole)   <-- PIM eligible (not yet active)
#
# Each role Resource stores its granular permission actions
# (rolePermissions[].allowedResourceActions, flattened + de-duped) in
# extendedAttributes so a later risk-scoring pass can tier a role by what
# it can actually do (EAM Control/Management plane), not just its name.
#
# Assignments use the universal 'Direct' / 'Eligible' types, with the source
# detail carried by resourceType='EntraDirectoryRole'. The scoped full-sync delete keys
# on (assignmentType, resourceType) together, so it targets only these role
# rows without wiping group memberships or PIM-group eligibilities — the same
# way AppRole scopes on resourceType='AppRole'.
#
# Group-typed assignments (a role-assignable group granted a role) are
# recorded against the group principal but NOT yet expanded to per-member
# rows — that's a follow-up, mirroring how the matrix shows group-typed
# AppRole rows only in the nested-group expand.
if ($SyncDirectoryRoles) {
    Sync-EntraDirectoryRoles -SystemId $systemId -Timings $phaseTimings
}

# ─── Refresh Views ───────────────────────────────────────────────
if ($RefreshViews) {
    Sync-EntraRefreshViews -Timings $phaseTimings
}

# ─── Summary ─────────────────────────────────────────────────────
Write-EntraPhaseSummary -PhaseTimings $phaseTimings -SyncStart $syncStart
Write-EntraSyncLog -SyncStart $syncStart -JobId $JobId -ApiKey $ApiKey -ApiBaseUrl $ApiBaseUrl

# If any main-phase failures occurred, throw so the worker scheduler marks the
# job `failed` with a summary. Successful phases already ingested — this just
# makes the silent-failure case loud (see the $script:phaseErrors comment above).
if ($script:phaseErrors.Count -gt 0) {
    $summary = "Crawl completed with $($script:phaseErrors.Count) phase failure(s):`n  - " + ($script:phaseErrors -join "`n  - ")
    Write-Host "`n$summary" -ForegroundColor Red
    throw $summary
}

Complete-EntraDeltaModeFlip -SyncMode $SyncMode -RawConfig $RawConfig -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey

# Clean up the temporary Graph credentials file (contains client secret)
Remove-Item $_graphConfigFile -Force -ErrorAction SilentlyContinue
