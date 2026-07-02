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

# Read full job config and derive crawler variables
$RawConfig = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
$ConfigFile = $ConfigPath  # OData functions read auth from the config file directly

# Sync toggles — defaults then apply selectedObjects overrides
$SyncContexts       = $true
$SyncIdentities     = $true
$SyncAccounts       = $true
$SyncContextMembers = $true
$SyncResources      = $true
$SyncEntitlements   = $true
$SyncAssignments    = $true
$SyncCRAs           = $true
$RefreshViews       = $true
$SyncMode = if ($RawConfig['_syncMode'] -in @('full','delta')) { $RawConfig['_syncMode'] } else { 'full' }

$objects = $RawConfig['selectedObjects']
if ($objects) {
    if ($objects.ContainsKey('contexts'))       { $SyncContexts       = [bool]$objects['contexts'] }
    if ($objects.ContainsKey('identities'))     { $SyncIdentities     = [bool]$objects['identities'] }
    if ($objects.ContainsKey('accounts'))       { $SyncAccounts       = [bool]$objects['accounts'] }
    if ($objects.ContainsKey('contextMembers')) { $SyncContextMembers = [bool]$objects['contextMembers'] }
    if ($objects.ContainsKey('resources'))      { $SyncResources      = [bool]$objects['resources'] }
    if ($objects.ContainsKey('entitlements'))   { $SyncEntitlements   = [bool]$objects['entitlements'] }
    if ($objects.ContainsKey('assignments'))    { $SyncAssignments    = [bool]$objects['assignments'] }
    if ($objects.ContainsKey('cras'))           { $SyncCRAs           = [bool]$objects['cras'] }
}

# ─── Load config ─────────────────────────────────────────────────
if (-not (Test-Path $ConfigFile)) { throw "Config file not found: $ConfigFile" }
$Cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json

# ── Normalise base URL via System.Uri ─────────────────────────────
# Accepts both:
#   https://tenant.omada.cloud/               (root — auto-appends /odata/dataobjects)
#   https://tenant.omada.cloud/odata/dataobjects   (explicit — used as-is)
#   http://server/odata/dataobjects               (on-prem)
$_rawUri  = [System.Uri]::new(($Cfg.baseUrl.Trim().TrimEnd('/')))
$_host    = $_rawUri.Scheme + '://' + $_rawUri.Authority   # scheme + host + non-default port
$_path    = $_rawUri.AbsolutePath.TrimEnd('/')
if ($_path -notmatch '(?i)/odata/dataobjects$') { $_path = '/odata/dataobjects' }
$BaseUrl        = $_host + $_path
$BuiltinBaseUrl = $_host + ($_path -replace '(?i)/dataobjects$', '/builtin')
# ──────────────────────────────────────────────────────────────────

$ApiVersion            = if ($Cfg.apiVersion) { $Cfg.apiVersion } else { 'v14' }
$PageSize              = if ($Cfg.pageSize)   { [int]$Cfg.pageSize } else { 100 }
$MaxODataRetries       = if ($null -ne $Cfg.maxRetries) { [int]$Cfg.maxRetries } else { 5 }
$SessionTimeoutMinutes = if ($Cfg.sessionTimeoutMinutes) { [int]$Cfg.sessionTimeoutMinutes } else { 30 }

# contextObjectTypes: list of Omada entity sets to sync as Identity Atlas Contexts.
# Each entry: { entitySet: "Orgunit", contextType: "OrgUnit", identityField: "OUREF" }
# identityField: the field on the Identity entity that references this context type (for direct ContextMember creation).
# Default: Orgunit only (backward-compatible). Operators add Country, Building, etc. as needed.
$DefaultContextObjectTypes = @(
    @{ entitySet = 'Orgunit'; contextType = 'OrgUnit'; identityField = 'OUREF' }
)
$ContextObjectTypes = if ($Cfg.contextObjectTypes) {
    @($Cfg.contextObjectTypes | ForEach-Object {
        @{ entitySet    = [string]$_.entitySet
           contextType  = if ($_.contextType)  { [string]$_.contextType  } else { [string]$_.entitySet }
           identityField = if ($_.identityField) { [string]$_.identityField } else { $Null } }
    })
} else {
    $DefaultContextObjectTypes
}
# Map: entitySet → identityField (for ContextMember creation from Identity references)
$ContextEntitySetToIdentityField = @{}
foreach ($Cot in $ContextObjectTypes) {
    if ($Cot.identityField) { $ContextEntitySetToIdentityField[$Cot.entitySet] = $Cot.identityField }
}

# Built-in field→entitySet map for well-known Omada context reference fields on Identity.
# Used as a fallback when identityField is not explicitly configured.
$WellKnownIdentityContextFields = @{
    OUREF        = 'Orgunit'
    COUNTRY      = 'Country'
    BUILDING     = 'Building'
    BUSINESSUNIT = 'Businessunit'
    COSTCENTER   = 'Costcenter'
    DIVISION     = 'Division'
    JOBTITLE_REF = 'Jobtitle'
    LOCATION     = 'Location'
    SUBAREA      = 'Subarea'
}

# resourceCategoryMapping — maps Omada ROLECATEGORY to Identity Atlas resourceType + optional tags.
# Entry with empty category = default/catch-all (must be last).
# Tags land in extendedAttributes.tags and can be used for filtering in the UI.
$DefaultResourceCategoryMapping = @(
    @{ category = 'Role';       resourceType = 'BusinessRole' }
    @{ category = 'Permission'; resourceType = 'Resource' }
    @{ category = '';           resourceType = 'Resource' }  # default/catch-all
)
$ResourceCategoryMapping = if ($Cfg.resourceCategoryMapping) {
    @($Cfg.resourceCategoryMapping | ForEach-Object {
        @{ category    = if ($_.category)    { [string]$_.category    } else { '' }
           resourceType = if ($_.resourceType){ [string]$_.resourceType } else { 'Resource' } }
    })
} else {
    $DefaultResourceCategoryMapping
}

#endregion Configuration

#region Functions

# Default type mappings (operator can override in config)
$DefaultTypeMappings = @{
    identityTypeToIdentityAtlas    = @{ Employee = 'User'; Primary = 'User'; Person = 'User'; Contractor = 'ExternalUser'; 'External Worker' = 'ExternalUser'; 'Service Account' = 'ServicePrincipal'; 'Non-Person' = 'ServicePrincipal'; Machine = 'ServicePrincipal' }
    resourceTypeToIdentityAtlas    = @{ 'Business Role' = 'BusinessRole' }
    contextTypeToIdentityAtlas     = @{ 'OrgUnit' = 'OrgUnit'; 'Organisational Unit' = 'OrgUnit'; Department = 'Department'; Location = 'Location'; 'Cost Center' = 'CostCenter'; CostCenter = 'CostCenter' }
    identityTypesForIdentityTable  = @('Employee', 'Primary', 'Person')
    resourceTypesAsBusinessRoles   = @('Business Role')
}

# ─── Load extracted helper functions ──────────────────────────────
# Dot-sourced into this script's own scope so they read script-scope vars
# (e.g. $TypeMappings, $ResourceCategoryMapping, $Script:phases) at call time.
. (Join-Path $PSScriptRoot 'OmadaCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'OmadaCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'OmadaCrawler.Phases.ps1')

$TypeMappings = Merge-TypeMappings -Defaults $DefaultTypeMappings -Overrides $Cfg.typeMappings
$IdentityTypesForIdentityTable = @($TypeMappings['identityTypesForIdentityTable'])

# ─── Phase tracking ───────────────────────────────────────────────
$Script:phases      = [System.Collections.Generic.List[object]]::new()
$Script:phaseErrors = [System.Collections.Generic.List[string]]::new()
$Script:startTime   = [datetime]::UtcNow

# ─── Ingest + progress helpers ───────────────────────────────────
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')

#endregion Functions

#region Main

Write-Host "`n=== Omada Crawler ===" -ForegroundColor Cyan
Write-Host "Base URL:    $BaseUrl" -ForegroundColor Gray
Write-Host "API version: $ApiVersion" -ForegroundColor Gray
Write-Host "Auth method: $($Cfg.authMethod)" -ForegroundColor Gray
Write-Host "Sync mode:   full (Omada has no delta API)" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Authenticating to Omada' -Pct 2

# Authenticate
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
Connect-ODataAPI @authParams

# Derive the Builtin OData service URL from the DataObjects base URL
Write-Host "Builtin URL: $BuiltinBaseUrl" -ForegroundColor Gray

# Discover available entity sets from OData $metadata (diagnostic — non-blocking)
Update-CrawlerProgress -Step 'Checking Omada API' -Pct 3
$AvailableEntitySets = @(Get-ODataEntitySets)
if ($AvailableEntitySets.Count -gt 0) {
    Write-Host "  Entity sets: $($AvailableEntitySets -join ', ')" -ForegroundColor Gray
} else {
    Write-Host "  Entity set check skipped (metadata unavailable — all phases will attempt to run)" -ForegroundColor Yellow
}

function Test-EntitySetAvailable {
    param([string]$Name)
    if ($AvailableEntitySets.Count -eq 0) { return $True }
    return $AvailableEntitySets -contains $Name
}

# Register all Omada connected systems as separate Identity Atlas Systems
Update-CrawlerProgress -Step 'Registering Omada connected systems' -Pct 5
$AllOmadaSystems = $Null
$OmadaSystemMap  = @{}  # Omada System.UId → Identity Atlas system.id
$SystemId        = 0    # ID for the main Omada IGA system (used for Contexts/Identities)
try {
    Write-Step 'Fetching connected systems from Omada...'
    $AllOmadaSystems = Invoke-ODataPagedRequest -Path '/System' `
        -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize 100 -MaxRetries $MaxODataRetries
    Write-Host "  $($AllOmadaSystems.Count) connected systems in Omada" -ForegroundColor Gray

    $SysRecords = @($AllOmadaSystems | ForEach-Object {
        [PSCustomObject]@{
            systemType  = 'Omada'
            displayName = $_.DisplayName
            tenantId    = [string]$_.UId
            enabled     = $True
            syncEnabled = $True
        }
    })

    Write-Step "Registering $($SysRecords.Count) systems in Identity Atlas..."
    Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'full'
        records  = ConvertTo-JsonArray $SysRecords
    } | Out-Null

    # Build UId → system.id map by querying Identity Atlas
    $AtlasSystems = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" `
        -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
    foreach ($S in $AtlasSystems) {
        if ($S.systemType -eq 'Omada' -and $S.tenantId) {
            $OmadaSystemMap[$S.tenantId] = [int]$S.id
        }
    }
    Write-Host "  System map: $($OmadaSystemMap.Count) entries" -ForegroundColor Gray

    # Omada Identity is the main IGA system — use it for Contexts/Identities
    $MainSysEntry = $AllOmadaSystems | Where-Object { $_.DisplayName -eq 'Omada Identity' } | Select-Object -First 1
    $MainSysUId   = if ($MainSysEntry) { [string]$MainSysEntry.UId } else { $null }
    # $OmadaIdentitySystemUId is used in the Assignments phase to distinguish Omada-internal
    # accounts (already synced via User entity) from connected-system accounts (derived from CA).
    $OmadaIdentitySystemUId = $MainSysUId
    if ($MainSysUId -and $OmadaSystemMap.ContainsKey($MainSysUId)) {
        $SystemId = $OmadaSystemMap[$MainSysUId]
    } elseif ($OmadaSystemMap.Count -gt 0) {
        $SystemId = ($OmadaSystemMap.Values | Select-Object -First 1)
    }
    Write-Host "  Main Omada IGA system ID: $SystemId (UId: $MainSysUId)" -ForegroundColor Gray
} catch {
    Write-Host "  Warning: could not register Omada systems — $($_.Exception.Message)" -ForegroundColor Yellow
    # Fall back to single system registration
    $FbResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'full'
        records  = @(@{ systemType = 'Omada'; displayName = "Omada ($BaseUrl)"; tenantId = $BaseUrl; enabled = $True; syncEnabled = $True })
    }
    $SystemId = [int]($FbResult.systemIds[0])
    Write-Host "  Fallback system ID: $SystemId" -ForegroundColor Gray
}

# Shared state across phases
$AllIdentities                = $Null  # Identity records — retained for Accounts principalType lookup and IdentityMembers join
$AllAccounts                  = $Null  # User records — retained for IdentityMembers, ContextMembers, Assignments joins
$IdentityLookup               = @{}    # IDENTITYID (string) → @{ uid = UId; identityType = string }
$UserNameToUid                = @{}    # UserName (string) → User.UId — for resolving Assignments AccountName to Principal FK
$IdentityUidToUserUids        = @{}    # Identity.UId → List[User.UId] — for fanning out Contextassignment to all accounts
$IdentityUidInIdentitiesTable = [System.Collections.Generic.HashSet[string]]::new()  # set of Identity.UId values stored in Identities table
$SyncedContextIds             = [System.Collections.Generic.HashSet[string]]::new()  # UIds of synced Contexts (OrgUnits) — filters CA_CONTEXT refs
$AllResources                 = $Null  # Resource records — retained for Entitlements (CHILDROLES extraction)
$UserGroupMap                 = @{}    # Usergroup.UId → DisplayName — for USERGROUPREF lookups on Resources

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
$Elapsed = [datetime]::UtcNow - $Script:startTime
Write-Host "`n=== Omada Crawler Summary ===" -ForegroundColor Cyan
Write-Host ("Total time: {0:mm}m {0:ss}s" -f $Elapsed) -ForegroundColor Gray
Write-Host ""
Write-Host ("{0,-20} {1,-10} {2}" -f 'Phase', 'Status', 'Duration') -ForegroundColor Gray
Write-Host ("{0,-20} {1,-10} {2}" -f ('─'*20), ('─'*10), ('─'*10)) -ForegroundColor Gray
foreach ($P in $Script:phases) {
    $Status = if ($P.status -eq 'ok') { 'ok' } else { 'FAILED' }
    $Color  = if ($P.status -eq 'ok') { 'Green' } else { 'Red' }
    Write-Host ("{0,-20} {1,-10} {2}ms" -f $P.name, $Status, $P.durationMs) -ForegroundColor $Color
}

# Post per-phase results to the jobs API for the UI phase breakout.
# Done directly from the crawler (not via the dispatcher) because PowerShell
# child script scopes are isolated — the dispatcher cannot read our $Script: vars.
if ($JobId -gt 0) {
    try {
        $PhasePayload = @{
            phases = @($Script:phases | ForEach-Object {
                $P = @{ name = $_.name; status = $_.status; durationMs = $_.durationMs }
                if ($_.error)   { $P.error   = $_.error }
                if ($_.records) { $P.records = $_.records }
                $P
            })
        }
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/jobs/$JobId/phases" `
            -Method Post -TimeoutSec 15 `
            -Headers @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } `
            -Body ($PhasePayload | ConvertTo-Json -Depth 5 -Compress) | Out-Null
    } catch {
        Write-Host "  Warning: could not post phase results — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

if ($Script:phaseErrors.Count -gt 0) {
    Write-Host "`nPhase errors:" -ForegroundColor Red
    foreach ($E in $Script:phaseErrors) { Write-Host "  $E" -ForegroundColor Red }
    throw "Omada sync completed with $($Script:phaseErrors.Count) phase error(s). See above for details."
}

Write-Host "`nOmada sync completed successfully." -ForegroundColor Green

#endregion Main
