<#
.SYNOPSIS
    Synchronise Omada IGA data to Identity Atlas via the Ingest API.

.DESCRIPTION
    Pulls data directly from the Omada REST API (no manual CSV export required)
    and pushes it to the Identity Atlas Ingest API in structured batches.

    Omada uses a generic data model: a single endpoint returns all variants of
    an entity, differentiated by reference-typed fields (IdentityType,
    ResourceType, ContextType, etc.). The typeMappings config section controls
    how these Omada-specific values map to Identity Atlas schema values.

    Omada exposes an OData 4.0 REST API at /odata/dataobjects (on-premise) or the
    equivalent Cloud endpoint. Configure baseUrl as the OData service root; entity
    sets (Identities, OrgUnits, etc.) are addressed directly under it.
    Check /odata/dataobjects/$metadata on your server to confirm entity set names.

    Supported auth methods: FormCookie, BasicAuth, OAuth2CC, OAuth2ROPC, ApiToken, CookieString.
    WindowsAuth is not supported — use FormCookie, BasicAuth, or OAuth2ROPC for on-premise.

    NOTE: Omada has no native delta/change-feed API. SyncMode is accepted for
    dispatcher compatibility but the crawler always performs a full sync.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL (e.g. http://localhost:3001/api)

.PARAMETER ApiKey
    Identity Atlas crawler API key (fgc_...)

.PARAMETER ConfigFile
    Path to JSON config file written by Invoke-CrawlerJob.ps1.

.PARAMETER SyncContexts
    Sync Omada contexts (OrgUnits, Departments, etc.) → Contexts table.

.PARAMETER SyncIdentities
    Sync Omada identities → Identities + IdentityMembers tables.

.PARAMETER SyncAccounts
    Sync Omada user accounts → Principals table.

.PARAMETER SyncResources
    Sync Omada resources/permissions → Resources table.

.PARAMETER SyncEntitlements
    Sync Omada permission nesting → ResourceRelationships (Contains).

.PARAMETER SyncAssignments
    Sync Omada role + calculated assignments → ResourceAssignments (Direct, governed=true).

.PARAMETER SyncContextMembers
    Sync Omada context assignments (Contextassignment) → ContextMembers table.
    Requires SyncContexts and SyncAccounts to have run in the same job.

.PARAMETER RefreshViews
    Refresh SQL views after sync (default: true).

.PARAMETER SyncMode
    'full' or 'delta' — accepted for dispatcher compatibility.
    Omada has no native delta API; this parameter is ignored and a full sync
    is always performed.

.PARAMETER JobId
    Job ID for live progress reporting to the UI. 0 = standalone (no reporting).

.EXAMPLE
    .\Start-OmadaCrawler.ps1 -ApiBaseUrl http://localhost:3001/api -ApiKey fgc_... -ConfigFile .\omada.json
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

# Read full job config and the OData auth config file.
$RawConfig  = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
$ConfigFile = $ConfigPath  # OData functions read auth from the config file directly
if (-not (Test-Path $ConfigFile)) { throw "Config file not found: $ConfigFile" }
$Cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json

# Default type mappings (operator overrides via the config typeMappings section).
$DefaultTypeMappings = @{
    identityTypeToIdentityAtlas    = @{ Employee = 'User'; Primary = 'User'; Person = 'User'; Contractor = 'ExternalUser'; 'External Worker' = 'ExternalUser'; 'Service Account' = 'ServicePrincipal'; 'Non-Person' = 'ServicePrincipal'; Machine = 'ServicePrincipal' }
    resourceTypeToIdentityAtlas    = @{ 'Business Role' = 'BusinessRole' }
    contextTypeToIdentityAtlas     = @{ 'OrgUnit' = 'OrgUnit'; 'Organisational Unit' = 'OrgUnit'; Department = 'Department'; Location = 'Location'; 'Cost Center' = 'CostCenter'; CostCenter = 'CostCenter' }
    identityTypesForIdentityTable  = @('Employee', 'Primary', 'Person')
    resourceTypesAsBusinessRoles   = @('Business Role')
}

#endregion Configuration

#region Functions

# ─── Load extracted helper functions ──────────────────────────────
# Dot-sourced into this script's own scope so they read script-scope vars
# (e.g. $TypeMappings, $ResourceCategoryMapping, $Script:phases) at call time.
. (Join-Path $PSScriptRoot 'OmadaCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'OmadaCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'OmadaCrawler.Phases.ps1')
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')

# Resolve all config (toggles, URLs, context types, mappings) into script vars.
$Resolved = Resolve-OmadaConfig -RawConfig $RawConfig -Cfg $Cfg -DefaultTypeMappings $DefaultTypeMappings
$SyncMode              = $Resolved.SyncMode
$SyncContexts          = $Resolved.SyncContexts
$SyncIdentities        = $Resolved.SyncIdentities
$SyncAccounts          = $Resolved.SyncAccounts
$SyncContextMembers    = $Resolved.SyncContextMembers
$SyncResources         = $Resolved.SyncResources
$SyncEntitlements      = $Resolved.SyncEntitlements
$SyncAssignments       = $Resolved.SyncAssignments
$RefreshViews          = $Resolved.RefreshViews
$BaseUrl               = $Resolved.baseUrl
$BuiltinBaseUrl        = $Resolved.builtinBaseUrl
$ApiVersion            = $Resolved.apiVersion
$PageSize              = $Resolved.pageSize
$MaxODataRetries       = $Resolved.maxRetries
$SessionTimeoutMinutes = $Resolved.sessionTimeoutMinutes
$ContextObjectTypes    = $Resolved.contextObjectTypes
$WellKnownIdentityContextFields = $Resolved.wellKnownIdentityContextFields
$ResourceCategoryMapping        = $Resolved.resourceCategoryMapping
$TypeMappings                   = $Resolved.typeMappings
$IdentityTypesForIdentityTable  = $Resolved.identityTypesForIdentityTable

# ─── Phase tracking ───────────────────────────────────────────────
$Script:phases      = [System.Collections.Generic.List[object]]::new()
$Script:phaseErrors = [System.Collections.Generic.List[string]]::new()
$Script:startTime   = [datetime]::UtcNow

#endregion Functions

#region Main

Write-Host "`n=== Omada Crawler ===" -ForegroundColor Cyan
Write-Host "Base URL:    $BaseUrl" -ForegroundColor Gray
Write-Host "API version: $ApiVersion" -ForegroundColor Gray
Write-Host "Auth method: $($Cfg.authMethod)" -ForegroundColor Gray
Write-Host "Sync mode:   full (Omada has no delta API)" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Authenticating to Omada' -Pct 2
Connect-OmadaSession -Cfg $Cfg -BaseUrl $BaseUrl -ApiVersion $ApiVersion -SessionTimeoutMinutes $SessionTimeoutMinutes
Write-Host "Builtin URL: $BuiltinBaseUrl" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Checking Omada API' -Pct 3
$AvailableEntitySets = Get-OmadaAvailableEntitySets

function Test-EntitySetAvailable {
    param([string]$Name)
    if ($AvailableEntitySets.Count -eq 0) { return $True }
    return $AvailableEntitySets -contains $Name
}

Update-CrawlerProgress -Step 'Registering Omada connected systems' -Pct 5
$Reg = Register-OmadaSystems -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey -BaseUrl $BaseUrl -MaxRetries $MaxODataRetries
$SystemId               = $Reg.systemId
$OmadaSystemMap         = $Reg.omadaSystemMap
$AllOmadaSystems        = $Reg.allOmadaSystems
$OmadaIdentitySystemUId = $Reg.omadaIdentitySystemUId

# Shared state across phases (defaults for when a producing phase is toggled off).
$AllIdentities                = $Null
$AllAccounts                  = $Null
$IdentityLookup               = @{}
$UserNameToUid                = @{}
$IdentityUidToUserUids        = @{}
$IdentityUidInIdentitiesTable = [System.Collections.Generic.HashSet[string]]::new()
$SyncedContextIds             = [System.Collections.Generic.HashSet[string]]::new()
$AllResources                 = $Null

# ─── Phase: Contexts ─────────────────────────────────────────────
# Syncs all context object types configured in contextObjectTypes (default: Orgunit only).
# Each type is fetched from its own entity set and registered as Identity Atlas Contexts.
# Orgunit uses topological sort (PARENTOU hierarchy); other types are flat.
if ($SyncContexts) {
    $SyncedContextIds = Sync-OmadaContexts -SystemId $SystemId -ContextObjectTypes $ContextObjectTypes `
        -PageSize $PageSize -MaxRetries $MaxODataRetries
}

# ─── Phase: Identities ───────────────────────────────────────────
# OData entity: Identity
# Type discriminator: IDENTITYTYPE (OIS.SetValue) — .Value gives the type label
# Builds $IdentityLookup (IDENTITYID→uid+identityType) used by Accounts and IdentityMembers phases
if ($SyncIdentities) {
    $IdResult = Sync-OmadaIdentities -SystemId $SystemId -IdentityTypesForIdentityTable $IdentityTypesForIdentityTable `
        -PageSize $PageSize -MaxRetries $MaxODataRetries
    $AllIdentities                = $IdResult.allIdentities
    $IdentityLookup               = $IdResult.identityLookup
    $IdentityUidInIdentitiesTable = $IdResult.identityUidInIdentitiesTable
}

# ─── Phase: Accounts / Principals ────────────────────────────────
# OData entity: User
# principalType resolved from linked Identity's IDENTITYTYPE via $IdentityLookup
# Join key: User.IDENTITYREF.IDENTITYID (string) = Identity.IDENTITYID (string)
if ($SyncAccounts) {
    $AccResult = Sync-OmadaAccounts -SystemId $SystemId -IdentityLookup $IdentityLookup `
        -PageSize $PageSize -MaxRetries $MaxODataRetries
    $AllAccounts           = $AccResult.allAccounts
    $UserNameToUid         = $AccResult.userNameToUid
    $IdentityUidToUserUids = $AccResult.identityUidToUserUids
}

# ─── Phase: IdentityMembers ───────────────────────────────────────
# Join: User.IDENTITYREF.IDENTITYID (string) = Identity.IDENTITYID (string)
# identityExternalId = Identity.UId, principalExternalId = User.UId
if ($SyncIdentities -and $AllIdentities -and $SyncAccounts -and $AllAccounts) {
    Sync-OmadaIdentityMembers -SystemId $SystemId -AllAccounts $AllAccounts `
        -IdentityLookup $IdentityLookup -IdentityTypesForIdentityTable $IdentityTypesForIdentityTable
}

# ─── Phase: Context Members ──────────────────────────────────────
# OData entity: Contextassignment
# Maps Identity → OrgUnit/Context. Stored as ContextMembers (memberType='Principal')
# so the UI query (IdentityMembers → ContextMembers via principalId) resolves correctly.
# Each identity assignment is fanned out to all the identity's active User accounts.
if ($SyncContextMembers) {
    Sync-OmadaContextMembers -SystemId $SystemId -SyncedContextIds $SyncedContextIds `
        -IdentityUidInIdentitiesTable $IdentityUidInIdentitiesTable -AllIdentities $AllIdentities `
        -ContextObjectTypes $ContextObjectTypes -WellKnownIdentityContextFields $WellKnownIdentityContextFields `
        -PageSize $PageSize -MaxRetries $MaxODataRetries
}

# ─── Phase: Resources ────────────────────────────────────────────
# OData entity: Resource
# Primary type discriminator: ROLECATEGORY → resourceCategoryMapping (configurable)
# Additional properties: ROLEFOLDER, EXPLICITOWNER, MANUALOWNER, SKIPPROVISIONING,
#   ROLETYPEREF, USERGROUPREF (looked up from Usergroup entity set)
# $AllResources retained for Entitlements phase (CHILDROLES extraction)
if ($SyncResources) {
    $AllResources = Sync-OmadaResources -SystemId $SystemId -OmadaSystemMap $OmadaSystemMap `
        -AllOmadaSystems $AllOmadaSystems -PageSize $PageSize -MaxRetries $MaxODataRetries
}

# ─── Phase: Entitlements (Resource Relationships) ─────────────────
# Omada stores child role nesting in Resource.CHILDROLES (Collection(OIS.ReferenceValue)).
# No separate PermissionNesting endpoint — relationships are extracted from $AllResources.
if ($SyncEntitlements) {
    Sync-OmadaEntitlements -SystemId $SystemId -AllResources $AllResources
}

# ─── Phase: Assignments ───────────────────────────────────────────
# Uses /OData/Builtin/CalculatedAssignments — authoritative source for all effective access.
# Two sources of assignments are combined into one reconcile per system — both
# are real Direct memberships flagged governed=true (IGA-driven):
#   1. Resourceassignment (DataObjects) — role assignments (Identity → Role/Resource).
#   2. CalculatedAssignments (Builtin) — effective account provisioning (Identity → Resource);
#      configured in Omada's governance structure, so governed=true regardless of IsManaged
#      (IsManaged kept in extendedAttributes).
if ($SyncAssignments) {
    Sync-OmadaAssignments -SystemId $SystemId -OmadaSystemMap $OmadaSystemMap `
        -OmadaIdentitySystemUId $OmadaIdentitySystemUId -UserNameToUid $UserNameToUid `
        -IdentityUidToUserUids $IdentityUidToUserUids -IdentityUidInIdentitiesTable $IdentityUidInIdentitiesTable `
        -BuiltinBaseUrl $BuiltinBaseUrl -PageSize $PageSize -MaxRetries $MaxODataRetries
}

# NOTE: CertificationReviews (governance cert-review activity) is not imported —
# that endpoint is not currently provided via OData on this Omada version.
# "CRA" in this crawler refers to Calculated Resource Assignments (above).

# ─── Refresh views ────────────────────────────────────────────────
if ($RefreshViews) {
    Sync-OmadaRefreshViews
}

Update-CrawlerProgress -Step 'Complete' -Pct 100

# ─── Summary ─────────────────────────────────────────────────────
Write-OmadaSummary -StartTime $Script:startTime -JobId $JobId -ApiKey $ApiKey -ApiBaseUrl $ApiBaseUrl

#endregion Main
