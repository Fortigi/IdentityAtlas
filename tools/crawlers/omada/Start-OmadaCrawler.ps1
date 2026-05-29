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

    Supported auth methods: FormCookie, OAuth2CC, OAuth2ROPC, ApiToken, CookieString.
    WindowsAuth is not supported — use FormCookie or OAuth2ROPC for on-premise.

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

    [switch]$SyncContexts      = $true,
    [switch]$SyncIdentities    = $true,
    [switch]$SyncAccounts      = $true,
    [switch]$SyncResources     = $true,
    [switch]$SyncEntitlements  = $true,
    [switch]$SyncAssignments   = $true,
    [switch]$SyncCRAs          = $true,
    [switch]$RefreshViews      = $true,

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
    identityTypeToIdentityAtlas    = @{ Employee = 'User'; Primary = 'User'; Person = 'User'; Contractor = 'ExternalUser'; 'External Worker' = 'ExternalUser'; 'Service Account' = 'ServicePrincipal'; 'Non-Person' = 'ServicePrincipal' }
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

# ─── Omada API path helper ────────────────────────────────────────
# Omada on-premise v14/v15 uses /api/data/ prefix.
# Omada Cloud may use /api/v2/ or similar. The apiVersion key drives this.
function Get-OmadaPath {
    param([string]$EntityPath)
    switch ($apiVersion) {
        'cloud' { return "/api/v2/$EntityPath" }
        'v15'   { return "/api/data/$EntityPath" }
        default { return "/api/data/$EntityPath" }  # v14 default
    }
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

# Register system
Update-CrawlerProgress -Step 'Registering system' -Pct 5
$sysResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
    syncMode = 'full'
    records  = @(@{
        systemType  = 'Omada'
        displayName = "Omada ($baseUrl)"
        tenantId    = $baseUrl  # used as unique key alongside systemType
        enabled     = $true
        syncEnabled = $true
    })
}
$systemId = [int]($sysResult.systemIds[0])
Write-Host "  System ID: $systemId" -ForegroundColor Gray

# ─── Phase: Contexts ─────────────────────────────────────────────
if ($SyncContexts) {
    $t = [datetime]::UtcNow
    Write-Host "`nContexts:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing contexts' -Pct 10
    try {
        $items = Invoke-OmadaPagedRequest -Path (Get-OmadaPath 'OrgUnits') -PageSize $pageSize
        Write-Host "  $($items.Count) context records from Omada" -ForegroundColor Gray

        $records = @($items | ForEach-Object {
            $ctxType = Map-ContextTypeToAtlas -OmadaType (Get-OmadaRefValue -Ref $_.ContextType -Fallback 'OrgUnit')
            [PSCustomObject]@{
                externalId       = if ($_._UID) { $_._UID } else { $_._ID }
                displayName      = if ($_._DISPLAYNAME) { $_._DISPLAYNAME } else { $_.Name }
                contextType      = $ctxType
                variant          = 'synced'
                targetType       = 'Identity'
                description      = $_.Description
                parentExternalId = Get-OmadaRefUid -Ref $_.ParentRef -Fallback (if ($_.Parent_OU_Key) { $_.Parent_OU_Key } else { $null })
            }
        } | Where-Object { $_.externalId })

        $r = Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ variant = 'synced' } -Records $records
        Write-Host "  Contexts: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'Contexts' -Duration ([datetime]::UtcNow - $t) -Records @{ contexts = $records.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Contexts phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Contexts: $msg")
        Write-Phase -Name 'Contexts' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Identities ───────────────────────────────────────────
$allIdentities = $null  # retained for IdentityMembers join
if ($SyncIdentities) {
    $t = [datetime]::UtcNow
    Write-Host "`nIdentities:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing identities' -Pct 20
    try {
        $allIdentities = Invoke-OmadaPagedRequest -Path (Get-OmadaPath 'Identities') -PageSize $pageSize
        Write-Host "  $($allIdentities.Count) identity records from Omada" -ForegroundColor Gray

        # Filter to person-type identities for the Identities table
        $personIdentities = @($allIdentities | Where-Object {
            $idType = Get-OmadaRefValue -Ref $_.IdentityType -Fallback (if ($_.IDENTITYTYPE_ENGLISH) { $_.IDENTITYTYPE_ENGLISH } else { 'Employee' })
            $identityTypesForIdentityTable -contains $idType
        })

        $identRecords = @($personIdentities | ForEach-Object {
            $idType   = Get-OmadaRefValue -Ref $_.IdentityType -Fallback ($_.IDENTITYTYPE_ENGLISH)
            $idCat    = Get-OmadaRefValue -Ref $_.IdentityCategory -Fallback ''
            $extId    = if ($_._UID) { $_._UID } else { $_._ID }
            $dispName = if ($_._DISPLAYNAME) { $_._DISPLAYNAME } `
                        elseif ($_.Firstname -and $_.Lastname) { "$($_.Firstname) $($_.Lastname)".Trim() } `
                        else { $_.DisplayName }
            [PSCustomObject]@{
                externalId = $extId
                displayName = $dispName
                email       = if ($_.Email) { $_.Email } else { $_.EMAIL }
                employeeId  = if ($_.EmployeeId) { $_.EmployeeId } else { $_.EMPLOYEEID }
                jobTitle    = if ($_.JobTitle) { $_.JobTitle } else { $_.JOBTITLE }
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
$allAccounts = $null  # retained for IdentityMembers join
if ($SyncAccounts) {
    $t = [datetime]::UtcNow
    Write-Host "`nAccounts (Principals):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing accounts' -Pct 30
    try {
        $allAccounts = Invoke-OmadaPagedRequest -Path (Get-OmadaPath 'Users') -PageSize $pageSize
        Write-Host "  $($allAccounts.Count) account records from Omada" -ForegroundColor Gray

        $accountRecords = @($allAccounts | ForEach-Object {
            $empType = Get-OmadaRefValue -Ref $_.Employee_Type -Fallback ($_.EmployeeType)
            $principalType = if ($empType -eq 'Contractor') { 'ExternalUser' } else { Map-IdentityTypeToAtlas -OmadaType $empType }
            $extId = if ($_.Employee_ID) { $_.Employee_ID } `
                     elseif ($_._UID) { $_._UID } `
                     else { $_.EmployeeNumber }
            [PSCustomObject]@{
                externalId     = $extId
                displayName    = if ($_.Employee_fullname) { $_.Employee_fullname } else { $_._DISPLAYNAME }
                email          = if ($_.EmailAddress) { $_.EmailAddress } else { $_.Email }
                principalType  = $principalType
                accountEnabled = $true
                jobTitle       = $_.Job_Title
                department     = Get-OmadaRefValue -Ref $_.OrgUnitRef -Fallback ($_.OU_KEY)
                managerId      = Get-OmadaRefUid -Ref $_.ManagerRef -Fallback ($_.Managers_CorperateKey)
            }
        } | Where-Object { $_.externalId -and $_.displayName })

        $r = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ principalType = 'User' } -Records ($accountRecords | Where-Object { $_.principalType -eq 'User' })
        Write-Host "  Principals (User): +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green

        $extUsers = @($accountRecords | Where-Object { $_.principalType -eq 'ExternalUser' })
        if ($extUsers.Count -gt 0) {
            $r2 = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ principalType = 'ExternalUser' } -Records $extUsers
            Write-Host "  Principals (ExternalUser): +$($r2.inserted) ~$($r2.updated) -$($r2.deleted)" -ForegroundColor Green
        }

        $otherAccounts = @($accountRecords | Where-Object { $_.principalType -notin @('User','ExternalUser') })
        if ($otherAccounts.Count -gt 0) {
            $r3 = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ principalType = 'ServicePrincipal' } -Records $otherAccounts
            Write-Host "  Principals (other): +$($r3.inserted) ~$($r3.updated) -$($r3.deleted)" -ForegroundColor Green
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
# Omada's Identities.IDENTITYID = Users.Employee_ID (system account link key).
# This is NOT EmployeeId / EMPLOYEEID, which is the HR number.
if ($SyncIdentities -and $allIdentities -and $SyncAccounts -and $allAccounts) {
    $t = [datetime]::UtcNow
    Write-Host "`nIdentity Members:" -ForegroundColor Cyan
    try {
        # Build account lookup by Employee_ID
        $accountByEmpId = @{}
        foreach ($a in $allAccounts) {
            $k = if ($a.Employee_ID) { $a.Employee_ID } else { $a.EmployeeNumber }
            if ($k) { $accountByEmpId[$k] = $a }
        }

        $memberRecords = @($allIdentities | Where-Object {
            $joinKey = $_.IDENTITYID
            $joinKey -and $accountByEmpId.ContainsKey($joinKey)
        } | ForEach-Object {
            $identExternalId = if ($_._UID) { $_._UID } else { $_._ID }
            $userExternalId  = if ($_.Employee_ID) { $_.Employee_ID } `
                               elseif ($accountByEmpId[$_.IDENTITYID].Employee_ID) { $accountByEmpId[$_.IDENTITYID].Employee_ID } `
                               else { $_.IDENTITYID }
            [PSCustomObject]@{
                identityExternalId  = $identExternalId
                principalExternalId = $userExternalId
                accountType         = 'Primary'
            }
        } | Where-Object { $_.identityExternalId -and $_.principalExternalId })

        $r = Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $systemId -SyncMode 'full' -Records $memberRecords
        Write-Host "  IdentityMembers: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'IdentityMembers' -Duration ([datetime]::UtcNow - $t) -Records @{ members = $memberRecords.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  IdentityMembers phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("IdentityMembers: $msg")
        Write-Phase -Name 'IdentityMembers' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Resources ────────────────────────────────────────────
if ($SyncResources) {
    $t = [datetime]::UtcNow
    Write-Host "`nResources:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing resources' -Pct 50
    try {
        $items = Invoke-OmadaPagedRequest -Path (Get-OmadaPath 'Permissions') -PageSize $pageSize
        Write-Host "  $($items.Count) resource records from Omada" -ForegroundColor Gray

        # Group by mapped resourceType for scoped-delete semantics
        $byType = @{}
        foreach ($item in $items) {
            $omadaType   = Get-OmadaRefValue -Ref $item.RoleTypeRef -Fallback (if ($item.ROLETYPEREF_VALUE) { $item.ROLETYPEREF_VALUE } else { $item.ResourceTypeName })
            $atlasType   = Map-ResourceTypeToAtlas -OmadaType $omadaType
            $omadaCat    = Get-OmadaRefValue -Ref $item.ResourceCategoryRef -Fallback ''
            $sysName     = Get-OmadaRefValue -Ref $item.SystemRef -Fallback (if ($item.SYSTEMREF_VALUE) { $item.SYSTEMREF_VALUE } else { $item.SystemName })
            $extId       = if ($item._UID) { $item._UID } else { $item._ID }
            $dispName    = if ($item._DISPLAYNAME) { $item._DISPLAYNAME } else { $item.DisplayName }
            $enabled     = -not ($item.RESOURCESTATUS_ENGLISH -and $item.RESOURCESTATUS_ENGLISH -ne 'Active') `
                           -and -not ($item.Deleted -eq 'True')

            if (-not $extId -or -not $dispName) { continue }

            $rec = [PSCustomObject]@{
                externalId         = $extId
                displayName        = $dispName
                resourceType       = $atlasType
                description        = $item.DESCRIPTION
                enabled            = $enabled
                extendedAttributes = @{ resourceCategory = $omadaCat; omadaSystem = $sysName }
            }
            if (-not $byType.ContainsKey($atlasType)) { $byType[$atlasType] = [System.Collections.Generic.List[object]]::new() }
            $byType[$atlasType].Add($rec)
        }

        $totalInserted = 0; $totalUpdated = 0
        foreach ($atlasType in $byType.Keys) {
            $recs = @($byType[$atlasType])
            $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ resourceType = $atlasType } -Records $recs
            Write-Host "  Resources ($atlasType): +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
            $totalInserted += ($r.inserted ?? 0); $totalUpdated += ($r.updated ?? 0)
        }

        Write-Phase -Name 'Resources' -Duration ([datetime]::UtcNow - $t) -Records @{ resources = $items.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Resources phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Resources: $msg")
        Write-Phase -Name 'Resources' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Entitlements (Resource Relationships) ─────────────────
if ($SyncEntitlements) {
    $t = [datetime]::UtcNow
    Write-Host "`nEntitlements (Resource Relationships):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing entitlements' -Pct 65
    try {
        $items = Invoke-OmadaPagedRequest -Path (Get-OmadaPath 'PermissionNesting') -PageSize $pageSize

        $records = @($items | ForEach-Object {
            $parentId = Get-OmadaRefUid -Ref $_.ParentRef -Fallback (if ($_.ParentUID) { $_.ParentUID } else { $_.ParentPermissionID })
            $childId  = Get-OmadaRefUid -Ref $_.ChildRef  -Fallback (if ($_.ChildUID)  { $_.ChildUID }  else { $_.ChildPermissionID })
            [PSCustomObject]@{
                parentExternalId = $parentId
                childExternalId  = $childId
                relationshipType = 'Contains'
            }
        } | Where-Object { $_.parentExternalId -and $_.childExternalId })

        $r = Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ relationshipType = 'Contains' } -Records $records
        Write-Host "  Entitlements: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $t) -Records @{ relationships = $records.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Entitlements phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Entitlements: $msg")
        Write-Phase -Name 'Entitlements' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: Assignments ───────────────────────────────────────────
if ($SyncAssignments) {
    $t = [datetime]::UtcNow
    Write-Host "`nRole Assignments:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing role assignments' -Pct 75
    try {
        $items = Invoke-OmadaPagedRequest -Path (Get-OmadaPath 'RoleAssignments') -PageSize $pageSize

        $records = @($items | ForEach-Object {
            $resourceId   = Get-OmadaRefUid -Ref $_.ResourceRef   -Fallback (if ($_.ResouceUID) { $_.ResouceUID } elseif ($_.ResourceUID) { $_.ResourceUID } else { $_.PermissionID })
            $principalId  = Get-OmadaRefUid -Ref $_.IdentityRef   -Fallback (if ($_.Employee_ID) { $_.Employee_ID } else { $_.AccountID })
            [PSCustomObject]@{
                resourceExternalId  = $resourceId
                principalExternalId = $principalId
                assignmentType      = 'Governed'
                extendedAttributes  = @{
                    startDate = $_.StartDate
                    endDate   = $_.EndDate
                }
            }
        } | Where-Object { $_.resourceExternalId -and $_.principalExternalId })

        $r = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ assignmentType = 'Governed' } -Records $records
        Write-Host "  Assignments: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'Assignments' -Duration ([datetime]::UtcNow - $t) -Records @{ assignments = $records.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  Assignments phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("Assignments: $msg")
        Write-Phase -Name 'Assignments' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
    }
}

# ─── Phase: CRAs ──────────────────────────────────────────────────
if ($SyncCRAs) {
    $t = [datetime]::UtcNow
    Write-Host "`nCertification Reviews (CRAs):" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing certification reviews' -Pct 85
    try {
        $items = Invoke-OmadaPagedRequest -Path (Get-OmadaPath 'CertificationReviews') -PageSize $pageSize

        $records = @($items | ForEach-Object {
            $extId      = if ($_._UID) { $_._UID } elseif ($_.CraId) { $_.CraId } else { "$($_.ResourceId)|$($_.GlobID)" }
            $resourceId = if ($_.ResourceRef) { Get-OmadaRefUid -Ref $_.ResourceRef } else { $_.ResourceId }
            $decision   = Get-OmadaRefValue -Ref $_.Decision -Fallback (if ($_.ComplianceState) { $_.ComplianceState } else { $_.Decision })
            [PSCustomObject]@{
                externalId           = $extId
                resourceExternalId   = $resourceId
                principalDisplayName = if ($_.IdentityRef) { Get-OmadaRefValue -Ref $_.IdentityRef } else { $_.DisplayName }
                decision             = $decision
                reviewedByDisplayName = if ($_.ReviewerRef) { Get-OmadaRefValue -Ref $_.ReviewerRef } else { $_.ReviewerDisplayName }
                reviewedDateTime     = $_.ReviewedDate
            }
        } | Where-Object { $_.externalId -and $_.resourceExternalId })

        $r = Send-IngestBatch -Endpoint 'ingest/governance/certifications' -SystemId $systemId -SyncMode 'full' -Records $records
        Write-Host "  CRAs: +$($r.inserted) ~$($r.updated) -$($r.deleted)" -ForegroundColor Green
        Write-Phase -Name 'CRAs' -Duration ([datetime]::UtcNow - $t) -Records @{ certifications = $records.Count }
    } catch {
        $msg = $_.Exception.Message
        Write-Host "  CRAs phase failed: $msg" -ForegroundColor Red
        $script:phaseErrors.Add("CRAs: $msg")
        Write-Phase -Name 'CRAs' -Duration ([datetime]::UtcNow - $t) -ErrorMsg $msg
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
