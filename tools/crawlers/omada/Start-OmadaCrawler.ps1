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
    Sync Omada role assignments → ResourceAssignments (Governed).

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
    [Parameter(Mandatory)] [string]$ConfigFile,

    [switch]$SyncContexts        = $True,
    [switch]$SyncIdentities      = $True,
    [switch]$SyncAccounts        = $True,
    [switch]$SyncContextMembers  = $True,
    [switch]$SyncResources       = $True,
    [switch]$SyncEntitlements    = $True,
    [switch]$SyncAssignments     = $True,
    [switch]$RefreshViews        = $True,

    [ValidateSet('full','delta')]
    [string]$SyncMode = 'full',

    [int]$JobId = 0
)

#endregion Parameters

#region Configuration

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

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

function Map-ResourceCategory {
    param([string]$Category)
    foreach ($M in $ResourceCategoryMapping) {
        if ($M.category -eq $Category -or $M.category -eq '') {
            return $M.resourceType
        }
    }
    return 'Resource'
}

# Default type mappings (operator can override in config)
$DefaultTypeMappings = @{
    identityTypeToIdentityAtlas    = @{ Employee = 'User'; Primary = 'User'; Person = 'User'; Contractor = 'ExternalUser'; 'External Worker' = 'ExternalUser'; 'Service Account' = 'ServicePrincipal'; 'Non-Person' = 'ServicePrincipal'; Machine = 'ServicePrincipal' }
    resourceTypeToIdentityAtlas    = @{ 'Business Role' = 'BusinessRole' }
    contextTypeToIdentityAtlas     = @{ 'OrgUnit' = 'OrgUnit'; 'Organisational Unit' = 'OrgUnit'; Department = 'Department'; Location = 'Location'; 'Cost Center' = 'CostCenter'; CostCenter = 'CostCenter' }
    identityTypesForIdentityTable  = @('Employee', 'Primary', 'Person')
    resourceTypesAsBusinessRoles   = @('Business Role')
}

function Merge-TypeMappings {
    param($Defaults, $Overrides)
    if (-not $Overrides) { return $Defaults }
    $Result = @{}
    foreach ($K in $Defaults.Keys) {
        if ($Overrides.PSObject.Properties.Name -contains $K) {
            $Ov = $Overrides.$K
            if ($Ov -is [System.Management.Automation.PSCustomObject]) {
                # Convert PSCustomObject to hashtable and merge
                $Merged = @{}
                foreach ($Dk in $Defaults[$K].Keys) { $Merged[$Dk] = $Defaults[$K][$Dk] }
                foreach ($Ok in $Ov.PSObject.Properties) { $Merged[$Ok.Name] = $Ok.Value }
                $Result[$K] = $Merged
            } elseif ($Ov -is [array]) {
                $Result[$K] = @($Ov)
            } else {
                $Result[$K] = $Ov
            }
        } else {
            $Result[$K] = $Defaults[$K]
        }
    }
    return $Result
}

$TypeMappings = Merge-TypeMappings -Defaults $DefaultTypeMappings -Overrides $Cfg.typeMappings
$IdentityTypesForIdentityTable = @($TypeMappings['identityTypesForIdentityTable'])

function Map-IdentityTypeToAtlas {
    param([string]$OmadaType)
    $Map = $TypeMappings['identityTypeToIdentityAtlas']
    if ($Map.ContainsKey($OmadaType)) { return $Map[$OmadaType] }
    Write-Host "    Warning: unknown IdentityType '$OmadaType' — defaulting to 'User'" -ForegroundColor Yellow
    return 'User'
}

function Map-ResourceTypeToAtlas {
    param([string]$OmadaType)
    $Map = $TypeMappings['resourceTypeToIdentityAtlas']
    if ($Map.ContainsKey($OmadaType)) { return $Map[$OmadaType] }
    # Normalise: remove spaces, keep as-is
    return $OmadaType -replace '\s+', ''
}

function Map-ContextTypeToAtlas {
    param([string]$OmadaType)
    $Map = $TypeMappings['contextTypeToIdentityAtlas']
    if ($Map.ContainsKey($OmadaType)) { return $Map[$OmadaType] }
    return $OmadaType -replace '\s+', ''
}

# ─── Step logging ─────────────────────────────────────────────────
function Write-Step {
    param([string]$Msg)
    Write-Host "  → $Msg" -ForegroundColor DarkGray
}

# ─── Phase tracking ───────────────────────────────────────────────
$Script:phases      = [System.Collections.Generic.List[object]]::new()
$Script:phaseErrors = [System.Collections.Generic.List[string]]::new()
$Script:startTime   = [datetime]::UtcNow

function Write-Phase {
    param([string]$Name, [TimeSpan]$Duration, [string]$ErrorMsg = $Null, [hashtable]$Records = $Null)
    $Phase = @{ name = $Name; durationMs = [int]$Duration.TotalMilliseconds; status = if ($ErrorMsg) { 'failed' } else { 'ok' } }
    if ($ErrorMsg)  { $Phase.error   = $ErrorMsg }
    if ($Records)   { $Phase.records = $Records }
    $Script:phases.Add($Phase)
}

# ─── Progress reporting ───────────────────────────────────────────
function Update-CrawlerProgress {
    param([string]$Step, [int]$Pct = -1, [string]$Detail = '')
    if (-not $JobId -or $JobId -le 0) { return }
    $Body = @{ jobId = $JobId }
    if ($PSBoundParameters.ContainsKey('Step'))   { $Body['step']   = $Step }
    if ($Pct -ge 0)                                { $Body['pct']    = $Pct }
    if ($PSBoundParameters.ContainsKey('Detail')) { $Body['detail'] = $Detail }
    try {
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post -TimeoutSec 10 `
            -Headers @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } `
            -Body ($Body | ConvertTo-Json -Compress) | Out-Null
    } catch {
        $Sc = $Null; try { $Sc = $_.Exception.Response.StatusCode.value__ } catch {}
        if ($Sc -eq 409) { throw "Job $JobId terminated server-side (HTTP 409) — aborting crawl" }
        # Transient errors are non-fatal for progress reporting
    }
}

# ─── Ingest API helpers ───────────────────────────────────────────
function Invoke-IngestAPI {
    param([string]$Endpoint, [hashtable]$Body)
    $Delays = @(2, 4, 8, 16, 32)
    $Uri    = "$ApiBaseUrl/$Endpoint"
    $Headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    for ($I = 0; $I -le $Delays.Count; $I++) {
        try {
            return Invoke-RestMethod -Uri $Uri -Method Post -Headers $Headers `
                -Body ($Body | ConvertTo-Json -Depth 20 -Compress) -TimeoutSec 300
        } catch {
            $Sc = $Null; try { $Sc = $_.Exception.Response.StatusCode.value__ } catch {}
            if ($Sc -eq 409) { throw "Job $JobId terminated server-side (HTTP 409)" }
            $IsTransient = ($Null -eq $Sc) -or ($Sc -eq 429) -or ($Sc -ge 500 -and $Sc -le 504)
            if (-not $IsTransient -or $I -ge $Delays.Count) { throw }
            Write-Host "    Ingest retry in $($Delays[$I])s (HTTP $Sc)..." -ForegroundColor Yellow
            Start-Sleep -Seconds $Delays[$I]
        }
    }
}

function ConvertTo-JsonArray {
    param([array]$Items)
    if (-not $Items -or $Items.Count -eq 0) { return @() }
    return ,$Items
}

function Send-IngestBatch {
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode   = 'full',
        [hashtable]$Scope   = @{},
        [array]$Records     = @(),
        [string[]]$DeletedIds = @(),
        [int]$BatchSize     = 5000
    )
    if (-not $Records -or $Records.Count -eq 0) {
        # Still send an empty full-sync batch so the server can scoped-delete stale data
        $Body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = @() }
        return Invoke-IngestAPI -Endpoint $Endpoint -Body $Body
    }

    if ($DeletedIds.Count -gt 0) {
        $DelBody = @{ systemId = $SystemId; syncMode = 'delta'; scope = $Scope; records = @(); deletedIds = ConvertTo-JsonArray $DeletedIds }
        Invoke-IngestAPI -Endpoint $Endpoint -Body $DelBody | Out-Null
    }

    if ($Records.Count -le $BatchSize) {
        $Body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = ConvertTo-JsonArray $Records }
        return Invoke-IngestAPI -Endpoint $Endpoint -Body $Body
    }

    # Chunked session for large batches
    $SyncId = $Null; $TotalInserted = 0; $TotalUpdated = 0; $TotalDeleted = 0
    for ($I = 0; $I -lt $Records.Count; $I += $BatchSize) {
        $Chunk   = $Records[$I..([Math]::Min($I + $BatchSize - 1, $Records.Count - 1))]
        $IsFirst = ($I -eq 0)
        $IsLast  = ($I + $BatchSize -ge $Records.Count)
        $Body    = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = ConvertTo-JsonArray $Chunk
                      syncSession = if ($IsFirst) { 'start' } elseif ($IsLast) { 'end' } else { 'continue' } }
        if ($SyncId) { $Body.syncId = $SyncId }
        $Result = Invoke-IngestAPI -Endpoint $Endpoint -Body $Body
        if ($IsFirst -and $Result.syncId) { $SyncId = $Result.syncId }
        $TotalInserted += ($Result.inserted ?? 0); $TotalUpdated += ($Result.updated ?? 0); $TotalDeleted += ($Result.deleted ?? 0)
    }
    return @{ inserted = $TotalInserted; updated = $TotalUpdated; deleted = $TotalDeleted }
}

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
Connect-OmadaAPI @authParams

# Derive the Builtin OData service URL from the DataObjects base URL
Write-Host "Builtin URL: $BuiltinBaseUrl" -ForegroundColor Gray

# Discover available entity sets from OData $metadata (diagnostic — non-blocking)
Update-CrawlerProgress -Step 'Checking Omada API' -Pct 3
$AvailableEntitySets = @(Get-OmadaEntitySets)
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
    $AllOmadaSystems = Invoke-OmadaPagedRequest -Path '/System' `
        -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize 100
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
    $T = [datetime]::UtcNow
    Write-Host "`nContexts:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing contexts' -Pct 10
    $TotalContextsInserted = 0; $TotalContextsUpdated = 0
    $ContextPhaseErrors    = [System.Collections.Generic.List[string]]::new()

    foreach ($Cot in $ContextObjectTypes) {
        $EntitySet   = $Cot.entitySet
        $ContextType = $Cot.contextType
        try {
            if (-not (Test-EntitySetAvailable $EntitySet)) {
                Write-Host "  Skipping $EntitySet — entity set not in OData metadata" -ForegroundColor Yellow
                continue
            }
            Write-Step "Fetching $EntitySet entities from Omada..."
            $Items = Invoke-OmadaPagedRequest -Path "/$EntitySet" `
                -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize
            Write-Host "  $($Items.Count) $EntitySet records from Omada" -ForegroundColor Gray

            if ($EntitySet -eq 'Orgunit') {
                # Orgunit has a parent hierarchy — topological sort required
                $RawRecords = @($Items | ForEach-Object {
                    $CtxType   = Map-ContextTypeToAtlas -OmadaType (Get-OmadaRefValue -Ref $_.OUTYPE -Fallback $ContextType)
                    $ParentUid = Get-OmadaRefUid -Ref $_.PARENTOU
                    [PSCustomObject]@{
                        id              = [string]$_.UId
                        externalId      = [string]$_.UId
                        displayName     = if ($_.NAME) { $_.NAME } else { $_.DisplayName }
                        contextType     = $CtxType
                        variant         = 'synced'
                        targetType      = 'Identity'
                        parentContextId = if ($ParentUid) { $ParentUid } else { $Null }
                    }
                } | Where-Object { $_.externalId -and $_.displayName })

                # Topological sort — parents before children
                $Records   = [System.Collections.Generic.List[object]]::new()
                $Remaining = [System.Collections.Generic.List[object]]::new($RawRecords)
                $Inserted  = [System.Collections.Generic.HashSet[string]]::new()
                $Pass = 0; $MaxPasses = $RawRecords.Count + 1
                while ($Remaining.Count -gt 0 -and $Pass -lt $MaxPasses) {
                    $Pass++
                    $NextRem = [System.Collections.Generic.List[object]]::new()
                    foreach ($Rec in $Remaining) {
                        $ParentId = $Rec.parentContextId
                        if (-not $ParentId -or $Inserted.Contains($ParentId)) {
                            $Records.Add($Rec); $Inserted.Add($Rec.id) | Out-Null
                        } else { $NextRem.Add($Rec) }
                    }
                    $Remaining = $NextRem
                }
                foreach ($Rec in $Remaining) { $Records.Add($Rec) }
            } else {
                # Flat context type — no hierarchy
                $Records = @($Items | ForEach-Object {
                    [PSCustomObject]@{
                        id          = [string]$_.UId
                        externalId  = [string]$_.UId
                        displayName = if ($_.NAME) { $_.NAME } else { $_.DisplayName }
                        contextType = $ContextType
                        variant     = 'synced'
                        targetType  = 'Identity'
                    }
                } | Where-Object { $_.externalId -and $_.displayName })
            }

            Write-Step "Ingesting $($Records.Count) $ContextType contexts..."
            $R = Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ variant = 'synced'; contextType = $ContextType } -Records @($Records)
            Write-Host "  Contexts ($EntitySet): +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green
            foreach ($Rec in $Records) { $SyncedContextIds.Add($Rec.id) | Out-Null }
            $TotalContextsInserted += ($R.inserted ?? 0); $TotalContextsUpdated += ($R.updated ?? 0)
        } catch {
            $EMsg = $_.Exception.Message
            Write-Host "  Contexts ($EntitySet) failed: $EMsg" -ForegroundColor Yellow
            $ContextPhaseErrors.Add($EntitySet + ': ' + $EMsg)
        }
    }

    if ($ContextPhaseErrors.Count -eq $ContextObjectTypes.Count) {
        $Script:phaseErrors.Add("Contexts: all context types failed")
        Write-Phase -Name 'Contexts' -Duration ([datetime]::UtcNow - $T) -ErrorMsg "All context types failed"
    } else {
        Write-Phase -Name 'Contexts' -Duration ([datetime]::UtcNow - $T) -Records @{ contexts = $SyncedContextIds.Count }
    }
}

# ─── Phase: Identities ───────────────────────────────────────────
# OData entity: Identity
# Type discriminator: IDENTITYTYPE (OIS.SetValue) — .Value gives the type label
# Builds $IdentityLookup (IDENTITYID→uid+identityType) used by Accounts and IdentityMembers phases
if ($SyncIdentities) {
    $T = [datetime]::UtcNow
    Write-Host "`nIdentities:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing identities' -Pct 20
    try {
        if (-not (Test-EntitySetAvailable 'Identity')) {
            throw "Identity entity set not found in OData metadata"
        }
        Write-Step 'Fetching identities from Omada...'
        $AllIdentities = Invoke-OmadaPagedRequest -Path '/Identity' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize
        Write-Host "  $($AllIdentities.Count) identity records from Omada" -ForegroundColor Gray

        # Build lookup: Identity.IDENTITYID (string) → { uid, identityType }
        # IDENTITYID is Omada's internal string key (not EMPLOYEEID which is the HR number)
        $IdentityLookup = @{}
        foreach ($Id in $AllIdentities) {
            $Key = [string]$Id.IDENTITYID
            if ($Key) {
                $IdType = if ($Id.IDENTITYTYPE) { [string]$Id.IDENTITYTYPE.Value } else { 'Employee' }
                $IdentityLookup[$Key] = @{ uid = [string]$Id.UId; identityType = $IdType }
            }
        }

        # Person-type identities go to the Identities table
        $PersonIdentities = @($AllIdentities | Where-Object {
            $IdType = if ($_.IDENTITYTYPE) { [string]$_.IDENTITYTYPE.Value } else { 'Employee' }
            $IdentityTypesForIdentityTable -contains $IdType
        })

        $IdentRecords = @($PersonIdentities | ForEach-Object {
            $IdType = if ($_.IDENTITYTYPE)     { [string]$_.IDENTITYTYPE.Value }     else { 'Employee' }
            $IdCat  = if ($_.IDENTITYCATEGORY) { [string]$_.IDENTITYCATEGORY.Value } else { '' }
            $FName  = if ($_.FIRSTNAME)        { [string]$_.FIRSTNAME } else { '' }
            $LName  = if ($_.LASTNAME)         { [string]$_.LASTNAME  } else { '' }
            $Name   = "$FName $LName".Trim()
            if (-not $Name) { $Name = $_.DisplayName }
            [PSCustomObject]@{
                id                 = [string]$_.UId  # Omada UId is a valid UUID
                externalId         = [string]$_.UId
                displayName        = $Name
                givenName          = $FName
                surname            = $LName
                email              = $_.EMAIL
                employeeId         = $_.EMPLOYEEID
                jobTitle           = $_.JOBTITLE
                companyName        = Get-OmadaRefValue -Ref $_.COMPANY -Fallback ''
                city               = if ($_.CITY)    { [string]$_.CITY    } else { '' }
                country            = Get-OmadaRefValue -Ref $_.COUNTRY -Fallback ''
                extendedAttributes = @{
                    # Identity type/category/status
                    identityType     = $IdType
                    identityCategory = $IdCat
                    identityStatus   = if ($_.IDENTITYSTATUS)   { [string]$_.IDENTITYSTATUS.Value }   else { '' }
                    identityId       = if ($_.IDENTITYID)        { [string]$_.IDENTITYID }             else { '' }
                    oisId            = if ($_.OISID)             { [string]$_.OISID }                  else { '' }
                    # Contact / location
                    email2           = if ($_.EMAIL2)            { [string]$_.EMAIL2 }                 else { '' }
                    city             = if ($_.CITY)              { [string]$_.CITY }                   else { '' }
                    zipCode          = if ($_.ZIPCODE)           { [string]$_.ZIPCODE }                else { '' }
                    # Validity
                    validFrom        = $_.VALIDFROM
                    validTo          = $_.VALIDTO
                    # Org references (UIds for use as context IDs)
                    ouRefId          = Get-OmadaRefUid -Ref $_.OUREF
                    countryId        = Get-OmadaRefUid -Ref $_.COUNTRY
                    locationId       = Get-OmadaRefUid -Ref $_.LOCATION
                    buildingId       = Get-OmadaRefUid -Ref $_.BUILDING
                    businessUnitId   = Get-OmadaRefUid -Ref $_.BUSINESSUNIT
                    costCenterId     = Get-OmadaRefUid -Ref $_.COSTCENTER
                    divisionId       = Get-OmadaRefUid -Ref $_.DIVISION
                    subAreaId        = Get-OmadaRefUid -Ref $_.SUBAREA
                    jobTitleRefId    = Get-OmadaRefUid -Ref $_.JOBTITLE_REF
                    # Org display names (human-readable counterparts)
                    company          = Get-OmadaRefValue -Ref $_.COMPANY       -Fallback ''
                    ouRefName        = Get-OmadaRefValue -Ref $_.OUREF         -Fallback ''
                    countryName      = Get-OmadaRefValue -Ref $_.COUNTRY       -Fallback ''
                    jobTitleRef      = Get-OmadaRefValue -Ref $_.JOBTITLE_REF  -Fallback ''
                    # Risk
                    riskScore        = if ($_.RISKSCORE)         { [string]$_.RISKSCORE }              else { '' }
                    riskLevel        = Get-OmadaRefValue -Ref $_.RISKLEVEL     -Fallback ''
                    # People references
                    manager          = ($_.MANAGER        | ForEach-Object { $_.DisplayName }) -join '; '
                    identityOwner    = Get-OmadaRefValue -Ref $_.IDENTITYOWNER  -Fallback ''
                    explicitOwners   = ($_.EXPLICITOWNER   | ForEach-Object { $_.DisplayName }) -join '; '
                }
            }
        } | Where-Object { $_.externalId -and $_.displayName })

        Write-Step "Ingesting $($IdentRecords.Count) identity records..."
        $R = Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $SystemId -SyncMode 'full' -Records $IdentRecords
        Write-Host "  Identities: +$($R.inserted) ~$($R.updated) -$($R.deleted)" -ForegroundColor Green

        # Build set of Identity UIds stored in Identities table so CA processing can
        # guard IdentityMembers against FK violations on non-person identity types.
        foreach ($Rec in $IdentRecords) { $IdentityUidInIdentitiesTable.Add($Rec.id) | Out-Null }

        Write-Phase -Name 'Identities' -Duration ([datetime]::UtcNow - $T) -Records @{ identities = $IdentRecords.Count }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Identities phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Identities: $Msg")
        Write-Phase -Name 'Identities' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
}

# ─── Phase: Accounts / Principals ────────────────────────────────
# OData entity: User
# principalType resolved from linked Identity's IDENTITYTYPE via $IdentityLookup
# Join key: User.IDENTITYREF.IDENTITYID (string) = Identity.IDENTITYID (string)
if ($SyncAccounts) {
    $T = [datetime]::UtcNow
    Write-Host "`nAccounts (Principals):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing accounts' -Pct 30
    try {
        if (-not (Test-EntitySetAvailable 'User')) {
            throw "User entity set not found in OData metadata"
        }
        Write-Step 'Fetching user accounts from Omada...'
        $AllAccounts = Invoke-OmadaPagedRequest -Path '/User' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize
        Write-Host "  $($AllAccounts.Count) account records from Omada" -ForegroundColor Gray

        Write-Step "Building $($AllAccounts.Count) account records..."
        $AccountRecords = @($AllAccounts | Where-Object { -not $_.Inactive } | ForEach-Object {
            $ExtId = [string]$_.UId
            $Name  = "$($_.FIRSTNAME) $($_.LASTNAME)".Trim()
            if (-not $Name) { $Name = $_.DisplayName }

            # Resolve principalType from the linked Identity's IDENTITYTYPE
            $PrincipalType = 'User'
            $IdentId = if ($_.IDENTITYREF) { [string]$_.IDENTITYREF.IDENTITYID } else { $Null }
            if ($IdentId -and $IdentityLookup.ContainsKey($IdentId)) {
                $PrincipalType = Map-IdentityTypeToAtlas -OmadaType $IdentityLookup[$IdentId].identityType
            }

            [PSCustomObject]@{
                id                 = $ExtId  # Omada UId is a valid UUID
                externalId         = $ExtId
                displayName        = $Name
                email              = $_.EMAIL
                principalType      = $PrincipalType
                accountEnabled     = $True
                jobTitle           = $_.JOBTITLE
                extendedAttributes = @{ userName = $_.UserName }
            }
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

        # Build shared lookups used by ContextMembers and Assignments phases:
        #   $UserNameToUid:         UserName → User.UId (CalculatedAssignment.AccountName lookup)
        #   $IdentityUidToUserUids: Identity.UId → [User.UIds] (Contextassignment fan-out to all accounts)
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

        Write-Phase -Name 'Accounts' -Duration ([datetime]::UtcNow - $T) -Records @{ accounts = $AccountRecords.Count }
    } catch {
        $Msg = $_.Exception.Message
        Write-Host "  Accounts phase failed: $Msg" -ForegroundColor Red
        $Script:phaseErrors.Add("Accounts: $Msg")
        Write-Phase -Name 'Accounts' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $Msg
    }
}

# ─── Phase: IdentityMembers ───────────────────────────────────────
# Join: User.IDENTITYREF.IDENTITYID (string) = Identity.IDENTITYID (string)
# identityExternalId = Identity.UId, principalExternalId = User.UId
if ($SyncIdentities -and $AllIdentities -and $SyncAccounts -and $AllAccounts) {
    $T = [datetime]::UtcNow
    Write-Host "`nIdentity Members:" -ForegroundColor Cyan
    try {
        $MemberRecords = [System.Collections.Generic.List[object]]::new()
        foreach ($Acc in $AllAccounts) {
            if ($Acc.Inactive) { continue }
            $IdentId = if ($Acc.IDENTITYREF) { [string]$Acc.IDENTITYREF.IDENTITYID } else { $Null }
            if (-not $IdentId -or -not $IdentityLookup.ContainsKey($IdentId)) { continue }
            # Only link accounts whose identity type is stored in the Identities table.
            # Non-person identities (Machine, etc.) are not in Identities → skip to avoid FK errors.
            $IdentEntry = $IdentityLookup[$IdentId]
            if ($IdentityTypesForIdentityTable -notcontains $IdentEntry.identityType) { continue }
            $MemberRecords.Add([PSCustomObject]@{
                identityId  = $IdentEntry.uid                 # direct UUID FK to Identities.id
                principalId = [string]$Acc.UId                # direct UUID FK to Principals.id
                accountType = 'Primary'
            })
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
        $Items = Invoke-OmadaPagedRequest -Path '/Contextassignment' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize
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
            $CtxMemberRecords.Add([PSCustomObject]@{
                contextId  = $ContextUid
                memberId   = $IdentUid   # Identity.UId → matches Identities table
                memberType = 'Identity'
                addedBy    = 'sync'
            })
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
                    $CtxMemberRecords.Add([PSCustomObject]@{
                        contextId  = $ContextUid
                        memberId   = $IdentUid
                        memberType = 'Identity'
                        addedBy    = 'sync'
                    })
                }
            }
        }

        # ── Source 3: Employment entity (IDENTITYREF → OUREF) ──
        if (Test-EntitySetAvailable 'Employment') {
            try {
                Write-Step 'Fetching employment records from Omada...'
                $EmpItems = Invoke-OmadaPagedRequest -Path '/Employment' `
                    -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize
                foreach ($Emp in $EmpItems) {
                    $IdentUid   = Get-OmadaRefUid -Ref $Emp.IDENTITYREF
                    $ContextUid = Get-OmadaRefUid -Ref $Emp.OUREF
                    if (-not $IdentUid -or -not $ContextUid) { continue }
                    if (-not $SyncedContextIds.Contains($ContextUid)) { continue }
                    if (-not $IdentityUidInIdentitiesTable.Contains($IdentUid)) { continue }
                    $CtxMemberRecords.Add([PSCustomObject]@{
                        contextId  = $ContextUid
                        memberId   = $IdentUid
                        memberType = 'Identity'
                        addedBy    = 'sync'
                    })
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
    $T = [datetime]::UtcNow
    Write-Host "`nResources:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing resources' -Pct 50
    try {
        if (-not (Test-EntitySetAvailable 'Resource')) {
            throw "Resource entity set not found in OData metadata"
        }

        # Pre-fetch Usergroups for USERGROUPREF name lookup
        if ($UserGroupMap.Count -eq 0 -and (Test-EntitySetAvailable 'Usergroup')) {
            try {
                $Ugs = Invoke-OmadaPagedRequest -Path '/Usergroup' `
                    -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize
                foreach ($Ug in $Ugs) { $UserGroupMap[[string]$Ug.UId] = $Ug.DisplayName }
                Write-Host "  Loaded $($UserGroupMap.Count) usergroups for USERGROUPREF lookup" -ForegroundColor Gray
            } catch {
                Write-Host "  Warning: Usergroup fetch failed — USERGROUPREF names unavailable" -ForegroundColor Yellow
            }
        }

        Write-Step 'Fetching resources from Omada (this may take a few minutes)...'
        $AllResources = Invoke-OmadaPagedRequest -Path '/Resource' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $PageSize
        Write-Host "  $($AllResources.Count) resource records from Omada" -ForegroundColor Gray

        Write-Step "Building resource records from $($AllResources.Count) Omada resources..."
        # Group resources by connected system (SYSTEMREF) for correct scoped-delete
        $BySysUId = @{}
        foreach ($Item in $AllResources) {
            $OmadaCat    = if ($Item.ROLECATEGORY)    { [string]$Item.ROLECATEGORY.Value }   else { '' }
            $AtlasType   = Map-ResourceCategory -Category $OmadaCat

            $SysUId      = Get-OmadaRefUid  -Ref $Item.SYSTEMREF
            $SysName     = Get-OmadaRefValue -Ref $Item.SYSTEMREF   -Fallback ''
            $RoleType    = Get-OmadaRefValue -Ref $Item.ROLETYPEREF  -Fallback ''
            $FolderName  = Get-OmadaRefValue -Ref $Item.ROLEFOLDER   -Fallback ''
            $Status      = if ($Item.RESOURCESTATUS) { [string]$Item.RESOURCESTATUS.Value } else { 'Active' }
            $Enabled     = $Status -notin @('Inactive', 'Disabled', 'Deleted')
            $ExtId       = [string]$Item.UId
            $DispName    = if ($Item.NAME) { $Item.NAME } else { $Item.DisplayName }
            if (-not $ExtId -or -not $DispName) { continue }

            # USERGROUPREF — look up name from pre-fetched map
            $UgUId   = Get-OmadaRefUid -Ref $Item.USERGROUPREF
            $UgName  = if ($UgUId -and $UserGroupMap.ContainsKey($UgUId)) { $UserGroupMap[$UgUId] } else { '' }

            # Owner references (EXPLICITOWNER, MANUALOWNER) — take first if collection
            $ExplicitOwner = ''
            if ($Item.EXPLICITOWNER -and $Item.EXPLICITOWNER.Count -gt 0) {
                $ExplicitOwner = ($Item.EXPLICITOWNER | ForEach-Object { $_.DisplayName }) -join '; '
            }
            $ManualOwner = ''
            if ($Item.MANUALOWNER -and $Item.MANUALOWNER.Count -gt 0) {
                $ManualOwner = ($Item.MANUALOWNER | ForEach-Object { $_.DisplayName }) -join '; '
            }

            $Rec = [PSCustomObject]@{
                id                 = $ExtId
                externalId         = $ExtId
                displayName        = $DispName
                resourceType       = $AtlasType
                description        = $Item.DESCRIPTION
                enabled            = $Enabled
                extendedAttributes = @{
                    resourceCategory  = $OmadaCat
                    resourceType      = $RoleType          # ROLETYPEREF.DisplayName
                    roleFolder        = $FolderName        # ROLEFOLDER.DisplayName
                    skipProvisioning  = if ($Null -ne $Item.SKIPPROVISIONING) { [bool]$Item.SKIPPROVISIONING } else { $False }
                    userGroupName     = $UgName            # USERGROUPREF → Usergroup.DisplayName
                    explicitOwner     = $ExplicitOwner     # EXPLICITOWNER collection
                    manualOwner       = $ManualOwner        # MANUALOWNER collection
                    omadaSystem       = $SysName
                }
            }
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
}

# ─── Phase: Entitlements (Resource Relationships) ─────────────────
# Omada stores child role nesting in Resource.CHILDROLES (Collection(OIS.ReferenceValue)).
# No separate PermissionNesting endpoint — relationships are extracted from $AllResources.
if ($SyncEntitlements) {
    $T = [datetime]::UtcNow
    Write-Host "`nEntitlements (Resource Relationships):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing entitlements' -Pct 65
    try {
        if (-not $AllResources) {
            Write-Host "  Skipping entitlements — resources were not synced" -ForegroundColor Yellow
            Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $T) -Records @{ relationships = 0 }
        } else {
            Write-Step "Extracting entitlements (CHILDROLES) from $($AllResources.Count) resources..."
            $RelRecords = [System.Collections.Generic.List[object]]::new()
            foreach ($Item in $AllResources) {
                if (-not $Item.CHILDROLES) { continue }
                $ParentUid = [string]$Item.UId
                foreach ($Child in $Item.CHILDROLES) {
                    $ChildUid = Get-OmadaRefUid -Ref $Child
                    if ($ChildUid) {
                        $RelRecords.Add([PSCustomObject]@{
                            parentResourceId = $ParentUid   # direct UUID FK to Resources.id
                            childResourceId  = $ChildUid    # direct UUID FK to Resources.id
                            relationshipType = 'Contains'
                        })
                    }
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

# ─── Phase: Assignments ───────────────────────────────────────────
# Uses /OData/Builtin/CalculatedAssignments — authoritative source for all effective access.
# Two sources of assignments are combined:
#   1. Resourceassignment (DataObjects) — IGA-governed role assignments (Identity → Role/Resource).
#      All records are Governed. Grouped per connected system for correct scoped-delete.
#   2. CalculatedAssignments (Builtin) — effective account provisioning (Identity → Account resource).
#      IsManaged=true → Governed, IsManaged=false → Direct. Also grouped per system.
if ($SyncAssignments) {
    $T = [datetime]::UtcNow
    Write-Host "`nAssignments:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing assignments' -Pct 75
    try {
        # ── Source 1: Resourceassignment (role/permission assignments) ─────────
        Write-Step 'Fetching role assignments from Omada...'
        $RaItems = Invoke-OmadaPagedRequest -Path '/Resourceassignment' `
            -QueryParams @{ '$Filter' = 'Deleted eq false' } -PageSize $PageSize
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
                $RaBySys[$SysKey].Add([PSCustomObject]@{
                    resourceId         = $ResourceUid
                    principalId        = $UserUid
                    assignmentType     = 'Governed'
                    extendedAttributes = @{ validFrom = $Item.VALIDFROM; validTo = $Item.VALIDTO }
                })
            }
        }

        Write-Step "Ingesting role assignments (Governed) across $($RaBySys.Keys.Count) system(s)..."
        $TotalRaInserted = 0; $TotalRaUpdated = 0
        foreach ($Key in $RaBySys.Keys) {
            $SysId = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
            # Deduplicate (principalId, resourceId) pairs — fanout can produce duplicates
            # if the same identity has multiple accounts or the same resource appears twice.
            $Seen  = [System.Collections.Generic.HashSet[string]]::new()
            $Dedup = @($RaBySys[$Key] | Where-Object {
                $K = "$($_.principalId)|$($_.resourceId)"
                $Seen.Add($K)
            })
            $R = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SysId `
                -SyncMode 'full' -Scope @{ assignmentType = 'Governed' } -Records $Dedup
            $TotalRaInserted += ($R.inserted ?? 0); $TotalRaUpdated += ($R.updated ?? 0)
        }
        Write-Host "  Role assignments (Governed): +$TotalRaInserted ~$TotalRaUpdated" -ForegroundColor Green

        # ── Source 2: Calculated Resource Assignments (CRA — account provisioning per connected system) ──
        # Streamed page-by-page to avoid loading the entire dataset into memory at once.
        # Cloud instances can have 10 000+ CRA records; accumulating them all with full expand
        # consumes several GB of RAM and OOM-kills the worker process.
        # Each page is processed and released before fetching the next.
        $CaPrincipalsBySys  = @{}   # connected-system Principals derived from CRA (keyed by OmadaSystemUId)
        $CaIdentityMembers  = [System.Collections.Generic.List[object]]::new()
        $CaAssignmentsBySys = @{}   # Governed
        $CaAssignmentsBysD  = @{}   # Direct
        $CaTotalCount = 0
        $CaSkip = 0
        $CaPageSize = 1000

        do {
            Write-Step "Fetching CRA page (skip=$CaSkip, total so far: $CaTotalCount)..."
            $CaPage = Invoke-OmadaGetRequest -Path '/CalculatedAssignments' `
                -QueryParams @{ '$filter' = 'Status eq true'; '$expand' = 'Identity,Resource,System,ResourceType'
                                '$top' = $CaPageSize; '$skip' = $CaSkip } `
                -MaxRetries 5 -OverrideBaseUrl $BuiltinBaseUrl
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

                $Fn    = if ($Item.Attributes.'FIRSTNAME') { ($Item.Attributes.'FIRSTNAME' -join ' ').Trim() } else { '' }
                $Ln    = if ($Item.Attributes.'LASTNAME')  { ($Item.Attributes.'LASTNAME'  -join ' ').Trim() } else { '' }
                $Email = if ($Item.Attributes.'EMAIL')     { ($Item.Attributes.'EMAIL'     | Select-Object -First 1) } else { $Null }
                $DName = "$Fn $Ln".Trim(); if (-not $DName) { $DName = $AccountName }

                if (-not $CaPrincipalsBySys.ContainsKey($SysKey)) {
                    $CaPrincipalsBySys[$SysKey] = [System.Collections.Generic.List[object]]::new()
                }
                $CaPrincipalsBySys[$SysKey].Add([PSCustomObject]@{
                    id             = $AccountKey
                    externalId     = $AccountName
                    displayName    = $DName
                    email          = $Email
                    principalType  = 'User'
                    accountEnabled = ($Item.Status -eq $True)
                    extendedAttributes = @{ accountType = $ResType }
                })

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

            # extendedAttributes: status, reasons, validFrom, validTo, accountType
            $Reasons = if ($Item.Reasons) {
                @($Item.Reasons | ForEach-Object { $_.Description }) -join '; '
            } else { '' }
            $ExtAttr = @{
                validFrom   = $Item.ValidFrom
                validTo     = $Item.ValidTo
                status      = if ($Item.Status -eq $True) { 'Enabled' } else { 'Disabled' }
                reasons     = $Reasons
                accountType = $ResType
                accountName = $AccountName
            }

            $Rec = [PSCustomObject]@{
                resourceId         = $ResourceUid
                principalId        = $PrincipalUid
                assignmentType     = if ($Item.IsManaged) { 'Governed' } else { 'Direct' }
                extendedAttributes = $ExtAttr
            }
            if ($Item.IsManaged) {
                if (-not $CaAssignmentsBySys.ContainsKey($SysKey)) { $CaAssignmentsBySys[$SysKey] = [System.Collections.Generic.List[object]]::new() }
                $CaAssignmentsBySys[$SysKey].Add($Rec)
            } else {
                if (-not $CaAssignmentsBysD.ContainsKey($SysKey))  { $CaAssignmentsBysD[$SysKey]  = [System.Collections.Generic.List[object]]::new() }
                $CaAssignmentsBysD[$SysKey].Add($Rec)
            }
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
        Write-Host "  CRA: $CaTotalCount records → $TotalCaPrincipals connected-system accounts, $($CaIdentityMembers.Count) identity-member links" -ForegroundColor Green
                Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SysId `
                    -SyncMode 'delta' -Records $Dedup | Out-Null
                $TotalCaPrincipals += $Dedup.Count
            }
        }
        # Ingest IdentityMembers for connected-system accounts (delta)
        if ($CaIdentityMembers.Count -gt 0) {
            $Seen  = [System.Collections.Generic.HashSet[string]]::new()
            $Dedup = @($CaIdentityMembers | Where-Object { $Seen.Add("$($_.identityId)|$($_.principalId)") })
            Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $SystemId `
                -SyncMode 'delta' -Records $Dedup | Out-Null
        }
        Write-Host "  CRA: $CaTotalCount records → $TotalCaPrincipals connected-system accounts, $($CaIdentityMembers.Count) identity-member links" -ForegroundColor Green

        Write-Step "Ingesting CRA resource assignments (Governed + Direct) per system..."
        # Ingest CRA ResourceAssignments per system
        $TotalCaGovIns = 0; $TotalCaDirIns = 0
        foreach ($Key in $CaAssignmentsBySys.Keys) {
            $SysId = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
            $Seen  = [System.Collections.Generic.HashSet[string]]::new()
            $Dedup = @($CaAssignmentsBySys[$Key] | Where-Object { $Seen.Add("$($_.principalId)|$($_.resourceId)") })
            $R = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SysId `
                -SyncMode 'full' -Scope @{ assignmentType = 'Governed' } -Records $Dedup
            $TotalCaGovIns += ($R.inserted ?? 0)
        }
        foreach ($Key in $CaAssignmentsBysD.Keys) {
            $SysId = if ($Key -eq '__main__') { $SystemId } else { $OmadaSystemMap[$Key] }
            $Seen  = [System.Collections.Generic.HashSet[string]]::new()
            $Dedup = @($CaAssignmentsBysD[$Key] | Where-Object { $Seen.Add("$($_.principalId)|$($_.resourceId)") })
            $R = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SysId `
                -SyncMode 'full' -Scope @{ assignmentType = 'Direct' } -Records $Dedup
            $TotalCaDirIns += ($R.inserted ?? 0)
        }
        Write-Host "  CRA assignments (Governed): +$TotalCaGovIns, (Direct): +$TotalCaDirIns" -ForegroundColor Green

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
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
    try {
        Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null
        Write-Host "`nViews refreshed." -ForegroundColor Gray
    } catch {
        Write-Host "  Warning: view refresh failed — $($_.Exception.Message)" -ForegroundColor Yellow
    }
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
