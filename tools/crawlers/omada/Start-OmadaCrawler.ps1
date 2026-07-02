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
    $T = [datetime]::UtcNow
    Write-Host "`nIdentity Members:" -ForegroundColor Cyan
    try {
        # Per-account link shaping lives in ConvertTo-OmadaIdentityMemberRecord
        # (OmadaCrawler.Transform.ps1); it returns $null for accounts to skip.
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

# ─── Phase: Context Members ──────────────────────────────────────
# OData entity: Contextassignment
# Maps Identity → OrgUnit/Context. Stored as ContextMembers (memberType='Principal')
# so the UI query (IdentityMembers → ContextMembers via principalId) resolves correctly.
# Each identity assignment is fanned out to all the identity's active User accounts.
if ($SyncContextMembers) {
    $T = [datetime]::UtcNow
    Write-Host "`nContext Members:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing context members' -Pct 45
    try {
        if (-not (Test-EntitySetAvailable 'Contextassignment')) {
            throw "Contextassignment entity set not found in OData metadata"
        }
        Write-Step 'Fetching context assignments from Omada...'
        $Items = Invoke-ODataPagedRequest -Path '/Contextassignment' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxODataRetries
        Write-Host "  $($Items.Count) context assignment records from Omada" -ForegroundColor Gray

        # ContextMembers use memberType='Identity' and memberId=Identity.UId so the
        # context detail page (which queries WHERE memberType = context.targetType
        # and joins to the Identities table) can find members correctly.
        # One record per (contextId, identityId) pair — no per-account fanout needed.
        $CtxMemberRecords = [System.Collections.Generic.List[object]]::new()

        # ── Source 1: Contextassignment (Omada's explicit context assignment entity) ──
        foreach ($Item in $Items) {
            $IdentUid   = if ($Item.CA_IDENTITY) { [string]$Item.CA_IDENTITY.UId } else { $Null }
            $ContextUid = if ($Item.CA_CONTEXT)  { [string]$Item.CA_CONTEXT.UId  } else { $Null }
            if (-not $IdentUid -or -not $ContextUid) { continue }
            # Skip when no contexts were synced (empty set = all IDs unknown) OR this specific ID wasn't synced.
            # The previous check ($Count -gt 0 -and -not Contains) allowed ALL IDs through when the set was
            # empty, causing FK violations if the Contexts table is empty (e.g. cloud with no Orgunit entity set).
            if ($SyncedContextIds.Count -eq 0 -or -not $SyncedContextIds.Contains($ContextUid)) { continue }
            if (-not $IdentityUidInIdentitiesTable.Contains($IdentUid)) { continue }
            $CtxMemberRecords.Add((New-OmadaContextMemberRecord -ContextId $ContextUid -MemberId $IdentUid))
        }

        # ── Source 2: Direct context reference fields on Identity (OUREF, COUNTRY, etc.) ──
        if ($AllIdentities) {
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
                    $CtxMemberRecords.Add((New-OmadaContextMemberRecord -ContextId $ContextUid -MemberId $IdentUid))
                }
            }
        }

        # ── Source 3: Employment entity (IDENTITYREF → OUREF) ──
        if (Test-EntitySetAvailable 'Employment') {
            try {
                Write-Step 'Fetching employment records from Omada...'
                $EmpItems = Invoke-ODataPagedRequest -Path '/Employment' `
                    -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxODataRetries
                foreach ($Emp in $EmpItems) {
                    $IdentUid   = Get-OmadaRefUid -Ref $Emp.IDENTITYREF
                    $ContextUid = Get-OmadaRefUid -Ref $Emp.OUREF
                    if (-not $IdentUid -or -not $ContextUid) { continue }
                    if (-not $SyncedContextIds.Contains($ContextUid)) { continue }
                    if (-not $IdentityUidInIdentitiesTable.Contains($IdentUid)) { continue }
                    $CtxMemberRecords.Add((New-OmadaContextMemberRecord -ContextId $ContextUid -MemberId $IdentUid))
                }
                Write-Host "  Employment-based context links added from $($EmpItems.Count) employment records" -ForegroundColor Gray
            } catch {
                Write-Host "  Warning: Employment-based context members skipped — $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }

        # Deduplicate before ingest (multiple sources can produce the same contextId+memberId pair)
        $Seen     = [System.Collections.Generic.HashSet[string]]::new()
        $Deduped  = @($CtxMemberRecords | Where-Object { $Seen.Add("$($_.contextId)|$($_.memberId)") })

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
    $T = [datetime]::UtcNow
    Write-Host "`nAssignments:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing assignments' -Pct 75
    try {
        # ── Source 1: Resourceassignment (role/permission assignments) ─────────
        Write-Step 'Fetching role assignments from Omada...'
        $RaItems = Invoke-ODataPagedRequest -Path '/Resourceassignment' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize -MaxRetries $MaxODataRetries
        Write-Host "  $($RaItems.Count) Resourceassignment records from Omada" -ForegroundColor Gray

        # Group by system for per-system full-sync batches
        $RaBySys = @{}
        foreach ($Item in $RaItems) {
            $Status = if ($Item.ROLEASSNSTATUS) { [string]$Item.ROLEASSNSTATUS.Value } else { 'Active' }
            if ($Status -notin @('Active', 'Pending')) { continue }

            $IdentUid    = if ($Item.IDENTITYREF) { [string]$Item.IDENTITYREF.UId } else { $Null }
            $ResourceUid = Get-OmadaRefUid -Ref $Item.ROLEREF
            $SysUId      = Get-OmadaRefUid -Ref $Item.SYSTEMREF
            if (-not $IdentUid -or -not $ResourceUid) { continue }

            # Fan out to all User accounts for this identity
            $UserUids = if ($IdentityUidToUserUids.ContainsKey($IdentUid)) { $IdentityUidToUserUids[$IdentUid] } else { $Null }
            if (-not $UserUids -or $UserUids.Count -eq 0) { continue }

            $SysKey = if ($SysUId -and $OmadaSystemMap.ContainsKey($SysUId)) { $SysUId } else { '__main__' }
            if (-not $RaBySys.ContainsKey($SysKey)) { $RaBySys[$SysKey] = [System.Collections.Generic.List[object]]::new() }

            foreach ($UserUid in $UserUids) {
                $RaBySys[$SysKey].Add((New-OmadaRoleAssignmentRecord -ResourceUid $ResourceUid -PrincipalId $UserUid -RoleAssignment $Item))
            }
        }

        # Role assignments are combined with the CRA assignments below into one
        # reconcile per system — both are governed=true Direct memberships and
        # share a delete partition, so sending them separately would make each
        # phase's full-sync delete wipe the other's rows.
        Write-Host "  Role assignments collected across $($RaBySys.Keys.Count) system(s)" -ForegroundColor Gray

        # ── Source 2: Calculated Resource Assignments (CRA — account provisioning per connected system) ──
        # Streamed page-by-page to avoid loading the entire dataset into memory at once.
        # Cloud instances can have 10 000+ CRA records; accumulating them all with full expand
        # consumes several GB of RAM and OOM-kills the worker process.
        # Each page is processed and released before fetching the next.
        $CaPrincipalsBySys  = @{}   # connected-system Principals derived from CRA (keyed by OmadaSystemUId)
        $CaIdentityMembers  = [System.Collections.Generic.List[object]]::new()
        $CaAssignmentsBySys = @{}   # all CRA → governed=true Direct memberships
        $CaTotalCount = 0
        $CaSkip = 0
        $CaPageSize = 1000

        do {
            Write-Step "Fetching CRA page (skip=$CaSkip, total so far: $CaTotalCount)..."
            $CaPage = Invoke-ODataGetRequest -Path '/CalculatedAssignments' `
                -QueryParams @{ '$filter' = 'Status eq true'; '$expand' = 'Identity,Resource,System,ResourceType'
                                '$top' = $CaPageSize; '$skip' = $CaSkip } `
                -MaxRetries $MaxODataRetries -OverrideBaseUrl $BuiltinBaseUrl
            $CaTotalCount += $CaPage.Count
            $CaSkip += $CaPage.Count  # advance by actual received (variable page size)

            foreach ($Item in $CaPage) {
            $SysUId      = if ($Item.System)   { [string]$Item.System.UId   } else { $Null }
            $ResourceUid = if ($Item.Resource)  { [string]$Item.Resource.UId } else { $Null }
            $IdentityUid = if ($Item.Identity)  { [string]$Item.Identity.UId } else { $Null }
            $AccountKey  = if ($Item.AccountKey)   { [string]$Item.AccountKey      } else { $Null }
            $AccountName = if ($Item.AccountName)  { [string]$Item.AccountName     } else { $Null }
            $ResType     = if ($Item.ResourceType) { $Item.ResourceType.DisplayName } else { '' }
            if (-not $ResourceUid -or -not $IdentityUid) { continue }

            $SysKey = if ($SysUId -and $OmadaSystemMap.ContainsKey($SysUId)) { $SysUId } else { '__main__' }
            $SysId  = if ($SysKey -eq '__main__') { $SystemId } else { $OmadaSystemMap[$SysKey] }

            # Resolve principalId: reuse existing Omada User for Omada Identity system;
            # for connected systems, derive Principal from CRA using AccountKey as id.
            $IsOmadaSys   = ($SysUId -and $SysUId -eq $OmadaIdentitySystemUId)
            $PrincipalUid = $Null

            if ($IsOmadaSys) {
                # Reuse existing Omada User Principal (created by SyncAccounts phase)
                if ($AccountName -and $UserNameToUid.ContainsKey($AccountName)) {
                    $PrincipalUid = $UserNameToUid[$AccountName]
                }
            } else {
                # Connected-system account — derive Principal from CRA Attributes
                if (-not $AccountKey) { continue }
                $PrincipalUid = $AccountKey

                if (-not $CaPrincipalsBySys.ContainsKey($SysKey)) {
                    $CaPrincipalsBySys[$SysKey] = [System.Collections.Generic.List[object]]::new()
                }
                $CaPrincipalsBySys[$SysKey].Add((ConvertTo-OmadaCraPrincipalRecord -CalculatedAssignment $Item -AccountKey $AccountKey -AccountName $AccountName -ResType $ResType))

                # IdentityMember: link this account to its Identity (person-type only — FK guard)
                if ($IdentityUidInIdentitiesTable.Contains($IdentityUid)) {
                    $CaIdentityMembers.Add([PSCustomObject]@{
                        identityId  = $IdentityUid   # Identity.UId == Identities.id (set in SyncIdentities)
                        principalId = $AccountKey
                        accountType = $ResType
                    })
                }
            }

            if (-not $PrincipalUid) { continue }

            # CRA rows are effective provisioning configured in Omada's governance
            # structure → real Direct memberships, flagged governed=true. Record
            # shaping lives in ConvertTo-OmadaCraAssignmentRecord.
            $Rec = ConvertTo-OmadaCraAssignmentRecord -CalculatedAssignment $Item -ResourceUid $ResourceUid -PrincipalId $PrincipalUid -ResType $ResType -AccountName $AccountName
            if (-not $CaAssignmentsBySys.ContainsKey($SysKey)) { $CaAssignmentsBySys[$SysKey] = [System.Collections.Generic.List[object]]::new() }
            $CaAssignmentsBySys[$SysKey].Add($Rec)
        }  # end foreach $Item in $CaPage
        } while ($CaPage.Count -gt 0)  # fetch next page until empty
        Write-Host "  $CaTotalCount CRA records from Omada" -ForegroundColor Gray

        Write-Step "Ingesting CRA-derived principals and identity-member links..."
        # Ingest connected-system Principals derived from CRA (delta — SyncAccounts owns full sync for Omada users)
        $TotalCaPrincipals = 0
        foreach ($Key in $CaPrincipalsBySys.Keys) {
            $SysId = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
            $Seen  = [System.Collections.Generic.HashSet[string]]::new()
            $Dedup = @($CaPrincipalsBySys[$Key] | Where-Object { $Seen.Add($_.id) })
            Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SysId `
                -SyncMode 'delta' -Records $Dedup | Out-Null
            $TotalCaPrincipals += $Dedup.Count
        }
        # Ingest IdentityMembers for connected-system accounts (delta)
        if ($CaIdentityMembers.Count -gt 0) {
            $Seen  = [System.Collections.Generic.HashSet[string]]::new()
            $Dedup = @($CaIdentityMembers | Where-Object { $Seen.Add("$($_.identityId)|$($_.principalId)") })
            Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $SystemId `
                -SyncMode 'delta' -Records $Dedup | Out-Null
        }
        Write-Host "  CRA: $CaTotalCount records → $TotalCaPrincipals connected-system accounts, $($CaIdentityMembers.Count) identity-member links" -ForegroundColor Green

        Write-Step "Ingesting governance assignments (role + CRA) per system..."
        # Combine Source 1 (role assignments) + Source 2 (CRA) per system: both
        # are governed=true Direct memberships sharing one reconcile partition, so
        # they must be sent together or each full-sync delete wipes the other's.
        $TotalGovIns = 0
        $AllSysKeys = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($k in $RaBySys.Keys)            { [void]$AllSysKeys.Add($k) }
        foreach ($k in $CaAssignmentsBySys.Keys) { [void]$AllSysKeys.Add($k) }
        foreach ($Key in $AllSysKeys) {
            $SysId = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
            $Combined = [System.Collections.Generic.List[object]]::new()
            if ($RaBySys.ContainsKey($Key))            { $Combined.AddRange($RaBySys[$Key]) }
            if ($CaAssignmentsBySys.ContainsKey($Key)) { $Combined.AddRange($CaAssignmentsBySys[$Key]) }
            $Seen  = [System.Collections.Generic.HashSet[string]]::new()
            $Dedup = @($Combined | Where-Object { $Seen.Add("$($_.principalId)|$($_.resourceId)") })
            if ($Dedup.Count -eq 0) { continue }
            $R = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SysId `
                -SyncMode 'full' -Scope @{ assignmentType = 'Direct'; governed = $true } -Records $Dedup
            $TotalGovIns += ($R.inserted ?? 0)
        }
        Write-Host "  Governance assignments (Direct, governed): +$TotalGovIns" -ForegroundColor Green

        Write-Phase -Name 'Assignments' -Duration ([datetime]::UtcNow - $T) `
            -Records @{ roleAssignments = ($RaBySys.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
                        craAssignments  = ($CaAssignmentsBySys.Values + $CaAssignmentsBysD.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Assignments phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Assignments: $Msg")
        Write-Phase -Name 'Assignments' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
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
