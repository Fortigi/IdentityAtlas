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

.PARAMETER SyncCRAs
    Sync Omada certification review activities → CertificationDecisions.

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

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [string]$ConfigFile,

    [switch]$SyncContexts        = $true,
    [switch]$SyncIdentities      = $true,
    [switch]$SyncAccounts        = $true,
    [switch]$SyncContextMembers  = $true,
    [switch]$SyncResources       = $true,
    [switch]$SyncEntitlements    = $true,
    [switch]$SyncAssignments     = $true,
    [switch]$SyncCRAs            = $true,
    [switch]$RefreshViews        = $true,

    [ValidateSet('full','delta')]
    [string]$SyncMode = 'full',

    [int]$JobId = 0
)

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

# ─── Load config ─────────────────────────────────────────────────
if (-not (Test-Path $ConfigFile)) { throw "Config file not found: $ConfigFile" }
$cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
$baseUrl               = $cfg.baseUrl
$apiVersion            = if ($cfg.apiVersion) { $cfg.apiVersion } else { 'v14' }
$pageSize              = if ($cfg.pageSize)   { [int]$cfg.pageSize } else { 100 }
$sessionTimeoutMinutes = if ($cfg.sessionTimeoutMinutes) { [int]$cfg.sessionTimeoutMinutes } else { 30 }

# Default type mappings (operator can override in config)
$defaultTypeMappings = @{
    identityTypeToIdentityAtlas    = @{ Employee = 'User'; Primary = 'User'; Person = 'User'; Contractor = 'ExternalUser'; 'External Worker' = 'ExternalUser'; 'Service Account' = 'ServicePrincipal'; 'Non-Person' = 'ServicePrincipal'; Machine = 'ServicePrincipal' }
    resourceTypeToIdentityAtlas    = @{ 'Business Role' = 'BusinessRole' }
    contextTypeToIdentityAtlas     = @{ 'OrgUnit' = 'OrgUnit'; 'Organisational Unit' = 'OrgUnit'; Department = 'Department'; Location = 'Location'; 'Cost Center' = 'CostCenter'; CostCenter = 'CostCenter' }
    identityTypesForIdentityTable  = @('Employee', 'Primary', 'Person')
    resourceTypesAsBusinessRoles   = @('Business Role')
}

function Merge-TypeMappings {
    param($Defaults, $Overrides)
    if (-not $Overrides) { return $Defaults }
    $result = @{}
    foreach ($k in $Defaults.Keys) {
        if ($Overrides.PSObject.Properties.Name -contains $k) {
            $ov = $Overrides.$k
            if ($ov -is [System.Management.Automation.PSCustomObject]) {
                # Convert PSCustomObject to hashtable and merge
                $merged = @{}
                foreach ($dk in $Defaults[$k].Keys) { $merged[$dk] = $Defaults[$k][$dk] }
                foreach ($ok in $ov.PSObject.Properties) { $merged[$ok.Name] = $ok.Value }
                $result[$k] = $merged
            } elseif ($ov -is [array]) {
                $result[$k] = @($ov)
            } else {
                $result[$k] = $ov
            }
        } else {
            $result[$k] = $Defaults[$k]
        }
    }
    return $result
}

$typeMappings = Merge-TypeMappings -Defaults $defaultTypeMappings -Overrides $cfg.typeMappings
$identityTypesForIdentityTable = @($typeMappings['identityTypesForIdentityTable'])

function Map-IdentityTypeToAtlas {
    param([string]$OmadaType)
    $map = $typeMappings['identityTypeToIdentityAtlas']
    if ($map.ContainsKey($OmadaType)) { return $map[$OmadaType] }
    Write-Host "    Warning: unknown IdentityType '$OmadaType' — defaulting to 'User'" -ForegroundColor Yellow
    return 'User'
}

function Map-ResourceTypeToAtlas {
    param([string]$OmadaType)
    $map = $typeMappings['resourceTypeToIdentityAtlas']
    if ($map.ContainsKey($OmadaType)) { return $map[$OmadaType] }
    # Normalise: remove spaces, keep as-is
    return $OmadaType -replace '\s+', ''
}

function Map-ContextTypeToAtlas {
    param([string]$OmadaType)
    $map = $typeMappings['contextTypeToIdentityAtlas']
    if ($map.ContainsKey($OmadaType)) { return $map[$OmadaType] }
    return $OmadaType -replace '\s+', ''
}

# ─── Phase tracking ───────────────────────────────────────────────
$script:phases      = [System.Collections.Generic.List[object]]::new()
$script:phaseErrors = [System.Collections.Generic.List[string]]::new()
$script:startTime   = [datetime]::UtcNow

function Write-Phase {
    param([string]$Name, [TimeSpan]$Duration, [string]$ErrorMsg = $null, [hashtable]$Records = $null)
    $phase = @{ name = $Name; durationMs = [int]$Duration.TotalMilliseconds; status = if ($ErrorMsg) { 'failed' } else { 'ok' } }
    if ($ErrorMsg)  { $phase.error   = $ErrorMsg }
    if ($Records)   { $phase.records = $Records }
    $script:phases.Add($phase)
}

# ─── Progress reporting ───────────────────────────────────────────
function Update-CrawlerProgress {
    param([string]$Step, [int]$Pct = -1, [string]$Detail = '')
    if (-not $JobId -or $JobId -le 0) { return }
    $body = @{ jobId = $JobId }
    if ($PSBoundParameters.ContainsKey('Step'))   { $body['step']   = $Step }
    if ($Pct -ge 0)                                { $body['pct']    = $Pct }
    if ($PSBoundParameters.ContainsKey('Detail')) { $body['detail'] = $Detail }
    try {
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post -TimeoutSec 10 `
            -Headers @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } `
            -Body ($body | ConvertTo-Json -Compress) | Out-Null
    } catch {
        $sc = $null; try { $sc = $_.Exception.Response.StatusCode.value__ } catch {}
        if ($sc -eq 409) { throw "Job $JobId terminated server-side (HTTP 409) — aborting crawl" }
        # Transient errors are non-fatal for progress reporting
    }
}

# ─── Ingest API helpers ───────────────────────────────────────────
function Invoke-IngestAPI {
    param([string]$Endpoint, [hashtable]$Body)
    $delays = @(2, 4, 8, 16, 32)
    $uri    = "$ApiBaseUrl/$Endpoint"
    $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    for ($i = 0; $i -le $delays.Count; $i++) {
        try {
            return Invoke-RestMethod -Uri $uri -Method Post -Headers $headers `
                -Body ($Body | ConvertTo-Json -Depth 20 -Compress) -TimeoutSec 300
        } catch {
            $sc = $null; try { $sc = $_.Exception.Response.StatusCode.value__ } catch {}
            if ($sc -eq 409) { throw "Job $JobId terminated server-side (HTTP 409)" }
            $isTransient = ($null -eq $sc) -or ($sc -eq 429) -or ($sc -ge 500 -and $sc -le 504)
            if (-not $isTransient -or $i -ge $delays.Count) { throw }
            Write-Host "    Ingest retry in $($delays[$i])s (HTTP $sc)..." -ForegroundColor Yellow
            Start-Sleep -Seconds $delays[$i]
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
        $body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = @() }
        return Invoke-IngestAPI -Endpoint $Endpoint -Body $body
    }

    if ($DeletedIds.Count -gt 0) {
        $delBody = @{ systemId = $SystemId; syncMode = 'delta'; scope = $Scope; records = @(); deletedIds = ConvertTo-JsonArray $DeletedIds }
        Invoke-IngestAPI -Endpoint $Endpoint -Body $delBody | Out-Null
    }

    if ($Records.Count -le $BatchSize) {
        $body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = ConvertTo-JsonArray $Records }
        return Invoke-IngestAPI -Endpoint $Endpoint -Body $body
    }

    # Chunked session for large batches
    $syncId = $null; $totalInserted = 0; $totalUpdated = 0; $totalDeleted = 0
    for ($i = 0; $i -lt $Records.Count; $i += $BatchSize) {
        $chunk   = $Records[$i..([Math]::Min($i + $BatchSize - 1, $Records.Count - 1))]
        $isFirst = ($i -eq 0)
        $isLast  = ($i + $BatchSize -ge $Records.Count)
        $body    = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = ConvertTo-JsonArray $chunk
                      syncSession = if ($isFirst) { 'start' } elseif ($isLast) { 'end' } else { 'continue' } }
        if ($syncId) { $body.syncId = $syncId }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        if ($isFirst -and $result.syncId) { $syncId = $result.syncId }
        $totalInserted += ($result.inserted ?? 0); $totalUpdated += ($result.updated ?? 0); $totalDeleted += ($result.deleted ?? 0)
    }
    return @{ inserted = $totalInserted; updated = $totalUpdated; deleted = $totalDeleted }
}

# ─── Main ─────────────────────────────────────────────────────────
Write-Host "`n=== Omada Crawler ===" -ForegroundColor Cyan
Write-Host "Base URL:    $baseUrl" -ForegroundColor Gray
Write-Host "API version: $apiVersion" -ForegroundColor Gray
Write-Host "Auth method: $($cfg.authMethod)" -ForegroundColor Gray
Write-Host "Sync mode:   full (Omada has no delta API)" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Authenticating to Omada' -Pct 2

# Authenticate
$authParams = @{
    BaseUrl               = $baseUrl
    AuthMethod            = $cfg.authMethod
    ApiVersion            = $apiVersion
    SessionTimeoutMinutes = $sessionTimeoutMinutes
}
if ($cfg.username)      { $authParams['Username']      = $cfg.username }
if ($cfg.password)      { $authParams['Password']      = $cfg.password }
if ($cfg.clientId)      { $authParams['ClientId']      = $cfg.clientId }
if ($cfg.clientSecret)  { $authParams['ClientSecret']  = $cfg.clientSecret }
if ($cfg.tokenEndpoint) { $authParams['TokenEndpoint'] = $cfg.tokenEndpoint }
if ($cfg.apiToken)      { $authParams['ApiToken']      = $cfg.apiToken }
if ($cfg.cookieString)  { $authParams['CookieString']  = $cfg.cookieString }
Connect-OmadaAPI @authParams

# Derive the Builtin OData service URL from the DataObjects base URL
# e.g. http://server/odata/dataobjects → http://server/odata/builtin
$builtinBaseUrl = [regex]::Replace($baseUrl.TrimEnd('/'), '/[^/]+$', '') + '/builtin'
Write-Host "Builtin URL: $builtinBaseUrl" -ForegroundColor Gray

# Discover available entity sets from OData $metadata (diagnostic — non-blocking)
Update-CrawlerProgress -Step 'Checking Omada API' -Pct 3
$availableEntitySets = @(Get-OmadaEntitySets)
if ($availableEntitySets.Count -gt 0) {
    Write-Host "  Entity sets: $($availableEntitySets -join ', ')" -ForegroundColor Gray
} else {
    Write-Host "  Entity set check skipped (metadata unavailable — all phases will attempt to run)" -ForegroundColor Yellow
}

function Test-EntitySetAvailable {
    param([string]$Name)
    if ($availableEntitySets.Count -eq 0) { return $true }
    return $availableEntitySets -contains $Name
}

# Register all Omada connected systems as separate Identity Atlas Systems
Update-CrawlerProgress -Step 'Registering Omada connected systems' -Pct 5
$allOmadaSystems = $null
$omadaSystemMap  = @{}  # Omada System.UId → Identity Atlas system.id
$systemId        = 0    # ID for the main Omada IGA system (used for Contexts/Identities)
try {
    $allOmadaSystems = Invoke-OmadaPagedRequest -Path '/System' `
        -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize 100
    Write-Host "  $($allOmadaSystems.Count) connected systems in Omada" -ForegroundColor Gray

    $sysRecords = @($allOmadaSystems | ForEach-Object {
        [PSCustomObject]@{
            systemType  = 'Omada'
            displayName = $_.DisplayName
            tenantId    = [string]$_.UId
            enabled     = $true
            syncEnabled = $true
        }
    })

    Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'full'
        records  = ConvertTo-JsonArray $sysRecords
    } | Out-Null

    # Build UId → system.id map by querying Identity Atlas
    $atlasSystems = Invoke-RestMethod -Uri "$ApiBaseUrl/systems" `
        -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
    foreach ($s in $atlasSystems) {
        if ($s.systemType -eq 'Omada' -and $s.tenantId) {
            $omadaSystemMap[$s.tenantId] = [int]$s.id
        }
    }
    Write-Host "  System map: $($omadaSystemMap.Count) entries" -ForegroundColor Gray

    # Omada Identity is the main IGA system — use it for Contexts/Identities
    $mainSysUId = ($allOmadaSystems | Where-Object { $_.DisplayName -eq 'Omada Identity' } |
                   Select-Object -First 1).UId
    if ($mainSysUId -and $omadaSystemMap.ContainsKey([string]$mainSysUId)) {
        $systemId = $omadaSystemMap[[string]$mainSysUId]
    } elseif ($omadaSystemMap.Count -gt 0) {
        $systemId = ($omadaSystemMap.Values | Select-Object -First 1)
    }
    Write-Host "  Main Omada IGA system ID: $systemId" -ForegroundColor Gray
} catch {
    Write-Host "  Warning: could not register Omada systems — $($_.Exception.Message)" -ForegroundColor Yellow
    # Fall back to single system registration
    $fbResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'full'
        records  = @(@{ systemType = 'Omada'; displayName = "Omada ($baseUrl)"; tenantId = $baseUrl; enabled = $true; syncEnabled = $true })
    }
    $systemId = [int]($fbResult.systemIds[0])
    Write-Host "  Fallback system ID: $systemId" -ForegroundColor Gray
}

# Shared state across phases
$allIdentities         = $null  # Identity records — retained for Accounts principalType lookup and IdentityMembers join
$allAccounts           = $null  # User records — retained for IdentityMembers, ContextMembers, Assignments joins
$identityLookup        = @{}    # IDENTITYID (string) → @{ uid = UId; identityType = string }
$userNameToUid         = @{}    # UserName (string) → User.UId — for resolving Assignments AccountName to Principal FK
$identityUidToUserUids = @{}    # Identity.UId → List[User.UId] — for fanning out Contextassignment to all accounts
$syncedContextIds      = [System.Collections.Generic.HashSet[string]]::new()  # UIds of synced Contexts (OrgUnits) — filters CA_CONTEXT refs
$allResources          = $null  # Resource records — retained for Entitlements (CHILDROLES extraction)

# ─── Phase: Contexts ─────────────────────────────────────────────
# OData entity: Orgunit
# Type discriminator: OUTYPE (OIS.ReferenceValue) — .DisplayName gives the type label
if ($SyncContexts) {
    $t = [datetime]::UtcNow
    Write-Host "`nContexts:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing contexts' -Pct 10
    try {
        if (-not (Test-EntitySetAvailable 'Orgunit')) {
            throw "Orgunit entity set not found in OData metadata"
        }
        $items = Invoke-OmadaPagedRequest -Path '/Orgunit' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $pageSize
        Write-Host "  $($items.Count) context records from Omada" -ForegroundColor Gray

        $rawRecords = @($items | ForEach-Object {
            $ctxType   = Map-ContextTypeToAtlas -OmadaType (Get-OmadaRefValue -Ref $_.OUTYPE -Fallback 'OrgUnit')
            $parentUid = Get-OmadaRefUid -Ref $_.PARENTOU
            [PSCustomObject]@{
                id               = [string]$_.UId  # Omada UIds are valid UUIDs — use directly as PK
                externalId       = [string]$_.UId
                displayName      = if ($_.NAME) { $_.NAME } else { $_.DisplayName }
                contextType      = $ctxType
                variant          = 'synced'
                targetType       = 'Identity'
                parentContextId  = if ($parentUid) { $parentUid } else { $null }
            }
        } | Where-Object { $_.externalId -and $_.displayName })

        # Topological sort: parents must be inserted before children so the
        # parentContextId FK is satisfied. Walk the tree level by level.
        $recordById  = @{}
        foreach ($r in $rawRecords) { $recordById[$r.id] = $r }
        $records     = [System.Collections.Generic.List[object]]::new()
        $remaining   = [System.Collections.Generic.List[object]]::new($rawRecords)
        $inserted    = [System.Collections.Generic.HashSet[string]]::new()
        $maxPasses   = $rawRecords.Count + 1
        $pass        = 0
        while ($remaining.Count -gt 0 -and $pass -lt $maxPasses) {
            $pass++
            $nextRem = [System.Collections.Generic.List[object]]::new()
            foreach ($rec in $remaining) {
                $parentId = $rec.parentContextId
                if (-not $parentId -or $inserted.Contains($parentId)) {
                    $records.Add($rec)
                    $inserted.Add($rec.id) | Out-Null
                } else {
                    $nextRem.Add($rec)
                }
            }
            $remaining = $nextRem
        }
        # Any remaining have dangling parents — append them last (FK will accept or warn)
        foreach ($rec in $remaining) { $records.Add($rec) }

        $r = Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ variant = 'synced' } -Records @($records)
        Write-Host "  Contexts: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green

        # Populate shared set so ContextMembers phase can skip CA_CONTEXT refs to unknown entities
        foreach ($rec in $records) { $syncedContextIds.Add($rec.id) | Out-Null }

        Write-Phase -Name 'Contexts' -Duration ([datetime]::UtcNow - $t) -Records @{ contexts = $records.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Contexts phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Contexts: $msg")
        Write-Phase -Name 'Contexts' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Identities ───────────────────────────────────────────
# OData entity: Identity
# Type discriminator: IDENTITYTYPE (OIS.SetValue) — .Value gives the type label
# Builds $identityLookup (IDENTITYID→uid+identityType) used by Accounts and IdentityMembers phases
if ($SyncIdentities) {
    $t = [datetime]::UtcNow
    Write-Host "`nIdentities:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing identities' -Pct 20
    try {
        if (-not (Test-EntitySetAvailable 'Identity')) {
            throw "Identity entity set not found in OData metadata"
        }
        $allIdentities = Invoke-OmadaPagedRequest -Path '/Identity' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $pageSize
        Write-Host "  $($allIdentities.Count) identity records from Omada" -ForegroundColor Gray

        # Build lookup: Identity.IDENTITYID (string) → { uid, identityType }
        # IDENTITYID is Omada's internal string key (not EMPLOYEEID which is the HR number)
        $identityLookup = @{}
        foreach ($id in $allIdentities) {
            $key = [string]$id.IDENTITYID
            if ($key) {
                $idType = if ($id.IDENTITYTYPE) { [string]$id.IDENTITYTYPE.Value } else { 'Employee' }
                $identityLookup[$key] = @{ uid = [string]$id.UId; identityType = $idType }
            }
        }

        # Person-type identities go to the Identities table
        $personIdentities = @($allIdentities | Where-Object {
            $idType = if ($_.IDENTITYTYPE) { [string]$_.IDENTITYTYPE.Value } else { 'Employee' }
            $identityTypesForIdentityTable -contains $idType
        })

        $identRecords = @($personIdentities | ForEach-Object {
            $idType = if ($_.IDENTITYTYPE)   { [string]$_.IDENTITYTYPE.Value }   else { 'Employee' }
            $idCat  = if ($_.IDENTITYCATEGORY) { [string]$_.IDENTITYCATEGORY.Value } else { '' }
            $name   = "$($_.FIRSTNAME) $($_.LASTNAME)".Trim()
            if (-not $name) { $name = $_.DisplayName }
            [PSCustomObject]@{
                id                 = [string]$_.UId  # Omada UId is a valid UUID
                externalId         = [string]$_.UId
                displayName        = $name
                email              = $_.EMAIL
                employeeId         = $_.EMPLOYEEID
                jobTitle           = $_.JOBTITLE
                extendedAttributes = @{ identityType = $idType; identityCategory = $idCat }
            }
        } | Where-Object { $_.externalId -and $_.displayName })

        $r = Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $systemId -SyncMode 'full' -Records $identRecords
        Write-Host "  Identities: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'Identities' -Duration ([datetime]::UtcNow - $t) -Records @{ identities = $identRecords.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Identities phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Identities: $msg")
        Write-Phase -Name 'Identities' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Accounts / Principals ────────────────────────────────
# OData entity: User
# principalType resolved from linked Identity's IDENTITYTYPE via $identityLookup
# Join key: User.IDENTITYREF.IDENTITYID (string) = Identity.IDENTITYID (string)
if ($SyncAccounts) {
    $t = [datetime]::UtcNow
    Write-Host "`nAccounts (Principals):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing accounts' -Pct 30
    try {
        if (-not (Test-EntitySetAvailable 'User')) {
            throw "User entity set not found in OData metadata"
        }
        $allAccounts = Invoke-OmadaPagedRequest -Path '/User' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $pageSize
        Write-Host "  $($allAccounts.Count) account records from Omada" -ForegroundColor Gray

        $accountRecords = @($allAccounts | Where-Object { -not $_.Inactive } | ForEach-Object {
            $extId = [string]$_.UId
            $name  = "$($_.FIRSTNAME) $($_.LASTNAME)".Trim()
            if (-not $name) { $name = $_.DisplayName }

            # Resolve principalType from the linked Identity's IDENTITYTYPE
            $principalType = 'User'
            $identId = if ($_.IDENTITYREF) { [string]$_.IDENTITYREF.IDENTITYID } else { $null }
            if ($identId -and $identityLookup.ContainsKey($identId)) {
                $principalType = Map-IdentityTypeToAtlas -OmadaType $identityLookup[$identId].identityType
            }

            [PSCustomObject]@{
                id                 = $extId  # Omada UId is a valid UUID
                externalId         = $extId
                displayName        = $name
                email              = $_.EMAIL
                principalType      = $principalType
                accountEnabled     = $true
                jobTitle           = $_.JOBTITLE
                extendedAttributes = @{ userName = $_.UserName }
            }
        } | Where-Object { $_.externalId -and $_.displayName })

        foreach ($pType in @('User', 'ExternalUser', 'ServicePrincipal')) {
            $subset = @($accountRecords | Where-Object { $_.principalType -eq $pType })
            if ($subset.Count -eq 0) { continue }
            $r = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ principalType = $pType } -Records $subset
            Write-Host "  Principals ($pType): +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        }
        $otherTypes = @($accountRecords | Where-Object { $_.principalType -notin @('User','ExternalUser','ServicePrincipal') })
        if ($otherTypes.Count -gt 0) {
            $grouped = $otherTypes | Group-Object principalType
            foreach ($g in $grouped) {
                $r = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode 'full' `
                    -Scope @{ principalType = $g.Name } -Records @($g.Group)
                Write-Host "  Principals ($($g.Name)): +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
            }
        }

        # Build shared lookups used by ContextMembers and Assignments phases:
        #   $userNameToUid:         UserName → User.UId (CalculatedAssignment.AccountName lookup)
        #   $identityUidToUserUids: Identity.UId → [User.UIds] (Contextassignment fan-out to all accounts)
        foreach ($acc in $allAccounts) {
            if ($acc.Inactive) { continue }
            if ($acc.UserName) { $userNameToUid[[string]$acc.UserName] = [string]$acc.UId }
            $identIdStr = if ($acc.IDENTITYREF) { [string]$acc.IDENTITYREF.IDENTITYID } else { $null }
            if ($identIdStr -and $identityLookup.ContainsKey($identIdStr)) {
                $identUid = $identityLookup[$identIdStr].uid
                if (-not $identityUidToUserUids.ContainsKey($identUid)) {
                    $identityUidToUserUids[$identUid] = [System.Collections.Generic.List[string]]::new()
                }
                $identityUidToUserUids[$identUid].Add([string]$acc.UId)
            }
        }

        Write-Phase -Name 'Accounts' -Duration ([datetime]::UtcNow - $t) -Records @{ accounts = $accountRecords.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Accounts phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Accounts: $msg")
        Write-Phase -Name 'Accounts' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: IdentityMembers ───────────────────────────────────────
# Join: User.IDENTITYREF.IDENTITYID (string) = Identity.IDENTITYID (string)
# identityExternalId = Identity.UId, principalExternalId = User.UId
if ($SyncIdentities -and $allIdentities -and $SyncAccounts -and $allAccounts) {
    $t = [datetime]::UtcNow
    Write-Host "`nIdentity Members:" -ForegroundColor Cyan
    try {
        $memberRecords = [System.Collections.Generic.List[object]]::new()
        foreach ($acc in $allAccounts) {
            if ($acc.Inactive) { continue }
            $identId = if ($acc.IDENTITYREF) { [string]$acc.IDENTITYREF.IDENTITYID } else { $null }
            if (-not $identId -or -not $identityLookup.ContainsKey($identId)) { continue }
            # Only link accounts whose identity type is stored in the Identities table.
            # Non-person identities (Machine, etc.) are not in Identities → skip to avoid FK errors.
            $identEntry = $identityLookup[$identId]
            if ($identityTypesForIdentityTable -notcontains $identEntry.identityType) { continue }
            $memberRecords.Add([PSCustomObject]@{
                identityId  = $identEntry.uid                 # direct UUID FK to Identities.id
                principalId = [string]$acc.UId                # direct UUID FK to Principals.id
                accountType = 'Primary'
            })
        }

        $r = Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $systemId -SyncMode 'full' -Records @($memberRecords)
        Write-Host "  IdentityMembers: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'IdentityMembers' -Duration ([datetime]::UtcNow - $t) -Records @{ members = $memberRecords.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  IdentityMembers phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("IdentityMembers: $msg")
        Write-Phase -Name 'IdentityMembers' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Context Members ──────────────────────────────────────
# OData entity: Contextassignment
# Maps Identity → OrgUnit/Context. Stored as ContextMembers (memberType='Principal')
# so the UI query (IdentityMembers → ContextMembers via principalId) resolves correctly.
# Each identity assignment is fanned out to all the identity's active User accounts.
if ($SyncContextMembers) {
    $t = [datetime]::UtcNow
    Write-Host "`nContext Members:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing context members' -Pct 45
    try {
        if (-not (Test-EntitySetAvailable 'Contextassignment')) {
            throw "Contextassignment entity set not found in OData metadata"
        }
        $items = Invoke-OmadaPagedRequest -Path '/Contextassignment' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $pageSize
        Write-Host "  $($items.Count) context assignment records from Omada" -ForegroundColor Gray

        $ctxMemberRecords = [System.Collections.Generic.List[object]]::new()
        foreach ($item in $items) {
            $identUid  = if ($item.CA_IDENTITY) { [string]$item.CA_IDENTITY.UId } else { $null }
            $contextUid = if ($item.CA_CONTEXT)  { [string]$item.CA_CONTEXT.UId  } else { $null }
            if (-not $identUid -or -not $contextUid) { continue }
            # Skip Contextassignment records that reference entity types not in our Contexts table
            # (e.g. training programmes, projects) — CA_CONTEXT can reference any Omada context
            if ($syncedContextIds.Count -gt 0 -and -not $syncedContextIds.Contains($contextUid)) { continue }

            # Fan out to all User accounts for this identity so the UI query resolves:
            # IdentityMembers.principalId → ContextMembers.memberId → Contexts
            $userUids = if ($identityUidToUserUids.ContainsKey($identUid)) { $identityUidToUserUids[$identUid] } else { $null }
            if (-not $userUids -or $userUids.Count -eq 0) { continue }
            foreach ($userUid in $userUids) {
                $ctxMemberRecords.Add([PSCustomObject]@{
                    contextId  = $contextUid
                    memberId   = $userUid
                    memberType = 'Principal'
                    addedBy    = 'sync'
                })
            }
        }

        $r = Send-IngestBatch -Endpoint 'ingest/context-members' -SystemId $systemId -SyncMode 'full' -Records @($ctxMemberRecords)
        Write-Host "  ContextMembers: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'ContextMembers' -Duration ([datetime]::UtcNow - $t) -Records @{ members = $ctxMemberRecords.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  ContextMembers phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("ContextMembers: $msg")
        Write-Phase -Name 'ContextMembers' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Resources ────────────────────────────────────────────
# OData entity: Resource
# Type discriminator: ROLETYPEREF (OIS.ReferenceValue) — .DisplayName gives the type label
# Category: ROLECATEGORY (OIS.SetValue) — .Value gives the category label
# $allResources retained for Entitlements phase (CHILDROLES extraction)
if ($SyncResources) {
    $t = [datetime]::UtcNow
    Write-Host "`nResources:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing resources' -Pct 50
    try {
        if (-not (Test-EntitySetAvailable 'Resource')) {
            throw "Resource entity set not found in OData metadata"
        }
        $allResources = Invoke-OmadaPagedRequest -Path '/Resource' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $pageSize
        Write-Host "  $($allResources.Count) resource records from Omada" -ForegroundColor Gray

        # Group resources by their connected system (SYSTEMREF) so each batch is
        # scoped to one system — preserving scoped-delete correctness.
        $bySysUId = @{}  # OmadaSystemUId → List[record]
        foreach ($item in $allResources) {
            $omadaType = Get-OmadaRefValue -Ref $item.ROLETYPEREF -Fallback 'Role'
            $atlasType = Map-ResourceTypeToAtlas -OmadaType $omadaType
            $omadaCat  = if ($item.ROLECATEGORY) { [string]$item.ROLECATEGORY.Value } else { '' }
            $sysUId    = Get-OmadaRefUid -Ref $item.SYSTEMREF
            $sysName   = Get-OmadaRefValue -Ref $item.SYSTEMREF -Fallback ''
            $status    = if ($item.RESOURCESTATUS) { [string]$item.RESOURCESTATUS.Value } else { 'Active' }
            $enabled   = $status -notin @('Inactive', 'Disabled', 'Deleted')
            $extId     = [string]$item.UId
            $dispName  = if ($item.NAME) { $item.NAME } else { $item.DisplayName }

            if (-not $extId -or -not $dispName) { continue }

            $rec = [PSCustomObject]@{
                id                 = $extId
                externalId         = $extId
                displayName        = $dispName
                resourceType       = $atlasType
                description        = $item.DESCRIPTION
                enabled            = $enabled
                extendedAttributes = @{ resourceCategory = $omadaCat; omadaSystem = $sysName }
            }
            # Use the mapped system or fall back to the main Omada system
            $key = if ($sysUId -and $omadaSystemMap.ContainsKey($sysUId)) { $sysUId } else { '__main__' }
            if (-not $bySysUId.ContainsKey($key)) { $bySysUId[$key] = [System.Collections.Generic.List[object]]::new() }
            $bySysUId[$key].Add($rec)
        }

        $totalInserted = 0; $totalUpdated = 0; $totalDeleted = 0
        foreach ($key in $bySysUId.Keys) {
            $sysId   = if ($key -eq '__main__') { $systemId } else { $omadaSystemMap[$key] }
            $sysLabel = if ($key -eq '__main__') { 'Omada' } else {
                ($allOmadaSystems | Where-Object { $_.UId -eq $key } |
                 Select-Object -First 1).DisplayName
            }
            $recs = @($bySysUId[$key])
            $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $sysId -SyncMode 'full' `
                -Scope @{} -Records $recs
            Write-Host "  Resources ($sysLabel, $($recs.Count) records): +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
            $totalInserted += ($r.inserted ?? 0); $totalUpdated += ($r.updated ?? 0); $totalDeleted += ($r.deleted ?? 0)
        }
        Write-Host "  Resources total: +$totalInserted ~$totalUpdated -$totalDeleted" -ForegroundColor Green

        Write-Phase -Name 'Resources' -Duration ([datetime]::UtcNow - $t) -Records @{ resources = $allResources.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Resources phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Resources: $msg")
        Write-Phase -Name 'Resources' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Entitlements (Resource Relationships) ─────────────────
# Omada stores child role nesting in Resource.CHILDROLES (Collection(OIS.ReferenceValue)).
# No separate PermissionNesting endpoint — relationships are extracted from $allResources.
if ($SyncEntitlements) {
    $t = [datetime]::UtcNow
    Write-Host "`nEntitlements (Resource Relationships):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing entitlements' -Pct 65
    try {
        if (-not $allResources) {
            Write-Host "  Skipping entitlements — resources were not synced" -ForegroundColor Yellow
            Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $t) -Records @{ relationships = 0 }
        } else {
            $relRecords = [System.Collections.Generic.List[object]]::new()
            foreach ($item in $allResources) {
                if (-not $item.CHILDROLES) { continue }
                $parentUid = [string]$item.UId
                foreach ($child in $item.CHILDROLES) {
                    $childUid = Get-OmadaRefUid -Ref $child
                    if ($childUid) {
                        $relRecords.Add([PSCustomObject]@{
                            parentResourceId = $parentUid   # direct UUID FK to Resources.id
                            childResourceId  = $childUid    # direct UUID FK to Resources.id
                            relationshipType = 'Contains'
                        })
                    }
                }
            }

            $r = Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ relationshipType = 'Contains' } -Records @($relRecords)
            Write-Host "  Entitlements: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
            Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $t) -Records @{ relationships = $relRecords.Count }
        }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Entitlements phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Entitlements: $msg")
        Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
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
    $t = [datetime]::UtcNow
    Write-Host "`nAssignments:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing assignments' -Pct 75
    try {
        # ── Source 1: Resourceassignment (role/permission assignments) ─────────
        $raItems = Invoke-OmadaPagedRequest -Path '/Resourceassignment' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $pageSize
        Write-Host "  $($raItems.Count) Resourceassignment records from Omada" -ForegroundColor Gray

        # Group by system for per-system full-sync batches
        $raBySys = @{}
        foreach ($item in $raItems) {
            $status = if ($item.ROLEASSNSTATUS) { [string]$item.ROLEASSNSTATUS.Value } else { 'Active' }
            if ($status -notin @('Active', 'Pending')) { continue }

            $identUid    = if ($item.IDENTITYREF) { [string]$item.IDENTITYREF.UId } else { $null }
            $resourceUid = Get-OmadaRefUid -Ref $item.ROLEREF
            $sysUId      = Get-OmadaRefUid -Ref $item.SYSTEMREF
            if (-not $identUid -or -not $resourceUid) { continue }

            # Fan out to all User accounts for this identity
            $userUids = if ($identityUidToUserUids.ContainsKey($identUid)) { $identityUidToUserUids[$identUid] } else { $null }
            if (-not $userUids -or $userUids.Count -eq 0) { continue }

            $sysKey = if ($sysUId -and $omadaSystemMap.ContainsKey($sysUId)) { $sysUId } else { '__main__' }
            if (-not $raBySys.ContainsKey($sysKey)) { $raBySys[$sysKey] = [System.Collections.Generic.List[object]]::new() }

            foreach ($userUid in $userUids) {
                $raBySys[$sysKey].Add([PSCustomObject]@{
                    resourceId         = $resourceUid
                    principalId        = $userUid
                    assignmentType     = 'Governed'
                    extendedAttributes = @{ validFrom = $item.VALIDFROM; validTo = $item.VALIDTO }
                })
            }
        }

        $totalRaInserted = 0; $totalRaUpdated = 0
        foreach ($key in $raBySys.Keys) {
            $sysId = if ($key -eq '__main__') { $systemId } else { $omadaSystemMap[$key] }
            # Deduplicate (principalId, resourceId) pairs — fanout can produce duplicates
            # if the same identity has multiple accounts or the same resource appears twice.
            $seen  = [System.Collections.Generic.HashSet[string]]::new()
            $dedup = @($raBySys[$key] | Where-Object {
                $k = "$($_.principalId)|$($_.resourceId)"
                $seen.Add($k)
            })
            $r = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $sysId `
                -SyncMode 'full' -Scope @{ assignmentType = 'Governed' } -Records $dedup
            $totalRaInserted += ($r.inserted ?? 0); $totalRaUpdated += ($r.updated ?? 0)
        }
        Write-Host "  Role assignments (Governed): +$totalRaInserted ~$totalRaUpdated" -ForegroundColor Green

        # ── Source 2: CalculatedAssignments (account provisioning) ────────────
        $caItems = Invoke-OmadaPagedRequest -Path '/CalculatedAssignments' `
            -QueryParams @{ '$filter' = 'Status eq true'; '$expand' = 'Identity,Resource,System,ResourceType' } `
            -PageSize $pageSize -OverrideBaseUrl $builtinBaseUrl
        Write-Host "  $($caItems.Count) CalculatedAssignment records from Omada" -ForegroundColor Gray

        $caBySysGov    = @{}  # governed per system
        $caBySysDirect = @{}  # direct per system

        foreach ($item in $caItems) {
            $accountName  = if ($item.AccountName) { [string]$item.AccountName } else { $null }
            $principalUid = if ($accountName -and $userNameToUid.ContainsKey($accountName)) { $userNameToUid[$accountName] } else { $null }
            $resourceUid  = if ($item.Resource)  { [string]$item.Resource.UId  } else { $null }
            if (-not $principalUid -or -not $resourceUid) { continue }

            # Use the System navigation property to link to the correct Identity Atlas system
            $sysUId = if ($item.System) { [string]$item.System.UId } else { $null }
            $sysKey = if ($sysUId -and $omadaSystemMap.ContainsKey($sysUId)) { $sysUId } else { '__main__' }

            $rec = [PSCustomObject]@{
                resourceId         = $resourceUid
                principalId        = $principalUid
                assignmentType     = if ($item.IsManaged) { 'Governed' } else { 'Direct' }
                extendedAttributes = @{ validFrom = $item.ValidFrom; validTo = $item.ValidTo;
                                        resourceType = if ($item.ResourceType) { $item.ResourceType.DisplayName } else { '' } }
            }
            if ($item.IsManaged) {
                if (-not $caBySysGov.ContainsKey($sysKey))    { $caBySysGov[$sysKey]    = [System.Collections.Generic.List[object]]::new() }
                $caBySysGov[$sysKey].Add($rec)
            } else {
                if (-not $caBySysDirect.ContainsKey($sysKey)) { $caBySysDirect[$sysKey] = [System.Collections.Generic.List[object]]::new() }
                $caBySysDirect[$sysKey].Add($rec)
            }
        }

        $totalCaGovIns = 0; $totalCaDirIns = 0
        foreach ($key in $caBySysGov.Keys) {
            $sysId = if ($key -eq '__main__') { $systemId } else { $omadaSystemMap[$key] }
            $seen  = [System.Collections.Generic.HashSet[string]]::new()
            $dedup = @($caBySysGov[$key] | Where-Object { $seen.Add("$($_.principalId)|$($_.resourceId)") })
            $r = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $sysId `
                -SyncMode 'full' -Scope @{ assignmentType = 'Governed' } -Records $dedup
            $totalCaGovIns += ($r.inserted ?? 0)
        }
        foreach ($key in $caBySysDirect.Keys) {
            $sysId = if ($key -eq '__main__') { $systemId } else { $omadaSystemMap[$key] }
            $seen  = [System.Collections.Generic.HashSet[string]]::new()
            $dedup = @($caBySysDirect[$key] | Where-Object { $seen.Add("$($_.principalId)|$($_.resourceId)") })
            $r = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $sysId `
                -SyncMode 'full' -Scope @{ assignmentType = 'Direct' } -Records $dedup
            $totalCaDirIns += ($r.inserted ?? 0)
        }
        Write-Host "  Account assignments (Governed): +$totalCaGovIns, (Direct): +$totalCaDirIns" -ForegroundColor Green

        Write-Phase -Name 'Assignments' -Duration ([datetime]::UtcNow - $t) `
            -Records @{ roleAssignments = ($raBySys.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
                        accountAssignments = ($caBySysGov.Values + $caBySysDirect.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Assignments phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Assignments: $msg")
        Write-Phase -Name 'Assignments' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: CRAs ──────────────────────────────────────────────────
# CertificationReviews is an optional Omada module (not always enabled).
# Skip gracefully if absent from the metadata or if the endpoint returns 400/404.
if ($SyncCRAs) {
    $t = [datetime]::UtcNow
    Write-Host "`nCertification Reviews (CRAs):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing certification reviews' -Pct 85

    try {
        $items = Invoke-OmadaPagedRequest -Path '/CertificationReviews' `
            -QueryParams @{ '$filter' = 'Deleted eq false' } -PageSize $pageSize

        $records = @($items | ForEach-Object {
            $extId      = [string]$_.UId
            $resUid     = Get-OmadaRefUid -Ref $_.ResourceRef
            $decision   = Get-OmadaRefValue -Ref $_.Decision -Fallback (Get-OmadaRefValue -Ref $_.ComplianceState -Fallback '')
            [PSCustomObject]@{
                id                    = $extId
                externalId            = $extId
                resourceId            = $resUid
                principalDisplayName  = Get-OmadaRefValue -Ref $_.IdentityRef -Fallback $_.DisplayName
                decision              = $decision
                reviewedByDisplayName = Get-OmadaRefValue -Ref $_.ReviewerRef -Fallback ''
                reviewedDateTime      = $_.ReviewedDate
            }
        } | Where-Object { $_.externalId -and $_.resourceId })

        $r = Send-IngestBatch -Endpoint 'ingest/governance/certifications' -SystemId $systemId -SyncMode 'full' -Records $records
        Write-Host "  CRAs: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'CRAs' -Duration ([datetime]::UtcNow - $t) -Records @{ certifications = $records.Count }
    } catch {
        $msg = $_.Exception.Message
        $sc  = $null
        try { $sc = $_.Exception.Response.StatusCode.value__ } catch {}
        # Invoke-OmadaGetRequest throws a string: "... failed (HTTP 404): ..." — parse it if needed
        if ($null -eq $sc -and $msg -match '\(HTTP (\d+)\)') { $sc = [int]$Matches[1] }
        if ($sc -in @(400, 404, 501)) {
            Write-Host "  CRAs: endpoint unavailable (HTTP $sc) — skipping" -ForegroundColor Yellow
            Write-Phase -Name 'CRAs' -Duration ([datetime]::UtcNow - $t) -Records @{ certifications = 0 }
        } else {
            Write-Host "  CRAs phase failed: $msg" -ForegroundColor Red
            $script:phaseErrors.Add("CRAs: $msg")
            Write-Phase -Name 'CRAs' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
        }
    }
}

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
$elapsed = [datetime]::UtcNow - $script:startTime
Write-Host "`n=== Omada Crawler Summary ===" -ForegroundColor Cyan
Write-Host ("Total time: {0:mm}m {0:ss}s" -f $elapsed) -ForegroundColor Gray
Write-Host ""
Write-Host ("{0,-20} {1,-10} {2}" -f 'Phase', 'Status', 'Duration') -ForegroundColor Gray
Write-Host ("{0,-20} {1,-10} {2}" -f ('─'*20), ('─'*10), ('─'*10)) -ForegroundColor Gray
foreach ($p in $script:phases) {
    $status = if ($p.status -eq 'ok') { 'ok' } else { 'FAILED' }
    $color  = if ($p.status -eq 'ok') { 'Green' } else { 'Red' }
    Write-Host ("{0,-20} {1,-10} {2}ms" -f $p.name, $status, $p.durationMs) -ForegroundColor $color
}

if ($script:phaseErrors.Count -gt 0) {
    Write-Host "`nPhase errors:" -ForegroundColor Red
    foreach ($e in $script:phaseErrors) { Write-Host "  $e" -ForegroundColor Red }
    throw "Omada sync completed with $($script:phaseErrors.Count) phase error(s). See above for details."
}

Write-Host "`nOmada sync completed successfully." -ForegroundColor Green
