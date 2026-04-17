<#
.SYNOPSIS
    Orchestrates a full Omada Identity sync via the Identity Atlas Ingest API.

.DESCRIPTION
    Standalone crawler that fetches data from the Omada Identity OData API and POSTs
    it to the Identity Atlas Ingest API. No CSV export step is required.

    Uses the OmadaWeb.PS module (Install-Module OmadaWeb.PS) for authentication on
    Windows. On Linux (e.g. the Docker worker container) authentication falls back to
    direct Invoke-RestMethod calls.

    Supports three authentication modes:
    - WindowsIntegrated: Uses the current process's Windows identity (Kerberos/NTLM).
      Best for domain-joined worker containers running as the service account.
    - Credential: Explicit DOMAIN\user + password via PSCredential.
      Uses NTLM/Negotiate on Windows; Basic auth on Linux.
    - OAuth2: Entra ID app registration (client credentials). For Omada Cloud or
      on-premise Omada configured to trust an Entra ID external identity provider.

.PARAMETER ApiBaseUrl
    Base URL of the Identity Atlas Ingest API (e.g., http://localhost:3001)

.PARAMETER ApiKey
    Crawler API key (fgc_...)

.PARAMETER OmadaBaseUrl
    Base URL of the Omada OData endpoint including the dataobjects path
    (e.g., http://omada.contoso.com/odata/dataobjects)

.PARAMETER AuthMode
    Authentication mode: WindowsIntegrated, Credential, or OAuth2 (default: WindowsIntegrated)

.PARAMETER OmadaCredential
    PSCredential for Credential mode (DOMAIN\user + password)

.PARAMETER TenantId
    Entra ID tenant ID for OAuth2 mode

.PARAMETER ClientId
    App registration client ID for OAuth2 mode

.PARAMETER ClientSecret
    App registration client secret for OAuth2 mode

.PARAMETER SystemName
    Display name for the Omada system record in Identity Atlas (default: "Omada Identity")

.PARAMETER SystemType
    System type identifier stored on the system record (default: "Omada")

.PARAMETER SyncPrincipals
    Sync Omada Identities and Users as principals/identities/identity-members (default: true)

.PARAMETER SyncResources
    Sync Omada Resources as Identity Atlas resources (default: true)

.PARAMETER SyncAssignments
    Sync Omada Resourceassignments as governed resource assignments (default: true)

.PARAMETER SyncSystems
    Sync Omada Systems and System Categories as Identity Atlas systems (default: true)

.PARAMETER SyncContexts
    Sync OrgUnit contexts from the Omada Orgunit entity (default: true)

.PARAMETER RefreshViews
    Refresh materialized SQL views and classify business-role assignments after sync (default: true)

.PARAMETER BatchSize
    Number of records per Ingest API batch (default: 5000)

.PARAMETER ODataPageSize
    OData $top page size for Omada requests (default: 1000)

.PARAMETER JobId
    Optional CrawlerJobs.id — when set, reports fine-grained progress to the API

.EXAMPLE
    # Windows Integrated (domain-joined machine)
    .\Start-OmadaCrawler.ps1 -ApiBaseUrl http://localhost:3001 -ApiKey fgc_abc123 `
        -OmadaBaseUrl http://omada.contoso.com/odata/dataobjects

.EXAMPLE
    # Explicit credential (NTLM on Windows, Basic on Linux)
    $cred = Get-Credential
    .\Start-OmadaCrawler.ps1 -ApiBaseUrl http://localhost:3001 -ApiKey fgc_abc123 `
        -OmadaBaseUrl http://omada.contoso.com/odata/dataobjects `
        -AuthMode Credential -OmadaCredential $cred

.EXAMPLE
    # OAuth2 (Entra ID app registration)
    .\Start-OmadaCrawler.ps1 -ApiBaseUrl http://localhost:3001 -ApiKey fgc_abc123 `
        -OmadaBaseUrl https://omada.cloud.com/odata/dataobjects `
        -AuthMode OAuth2 -TenantId <tid> -ClientId <cid> -ClientSecret <secret>

.NOTES
    On Windows, the OmadaWeb.PS module is used when available (Install-Module OmadaWeb.PS).
    On Linux, authentication uses direct Invoke-RestMethod calls.
#>

[CmdletBinding()]
Param(
    # Identity Atlas Ingest API
    [Parameter(Mandatory = $true)]
    [string]$ApiBaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$ApiKey,

    # Omada OData endpoint (include /dataobjects path, e.g. http://server/odata/dataobjects)
    [Parameter(Mandatory = $true)]
    [string]$OmadaBaseUrl,

    # Auth mode
    [ValidateSet('WindowsIntegrated', 'Credential', 'OAuth2')]
    [string]$AuthMode = 'WindowsIntegrated',

    # Credential mode (NTLM/Negotiate on Windows; Basic on Linux)
    [PSCredential]$OmadaCredential,

    # OAuth2 mode (Entra ID app registration - client credentials)
    [string]$TenantId,
    [string]$ClientId,
    [string]$ClientSecret,

    # Sync options
    [string]$SystemName      = 'Omada Identity',
    [string]$SystemType      = 'Omada',
    [switch]$SyncSystems     = $true,
    [switch]$SyncPrincipals  = $true,
    [switch]$SyncResources   = $true,
    [switch]$SyncAssignments = $true,
    [switch]$SyncContexts    = $true,
    [switch]$RefreshViews    = $true,
    [int]$BatchSize         = 5000,
    [int]$ODataPageSize     = 1000,
    [int]$JobId             = 0
)

$ErrorActionPreference = 'Stop'
$ApiBaseUrl   = $ApiBaseUrl.TrimEnd('/')
$OmadaBaseUrl = $OmadaBaseUrl.TrimEnd('/')

# ─── Parameter validation ─────────────────────────────────────────

if ($AuthMode -eq 'Credential' -and -not $OmadaCredential) {
    throw "AuthMode 'Credential' requires -OmadaCredential"
}
if ($AuthMode -eq 'OAuth2') {
    if (-not $TenantId -or -not $ClientId -or -not $ClientSecret) {
        throw "AuthMode 'OAuth2' requires -TenantId, -ClientId, and -ClientSecret"
    }
}

# ─── Module dependency (Windows only) ────────────────────────────
# OmadaWeb.PS handles auth on Windows. On Linux (worker container)
# we fall back to direct Invoke-RestMethod calls.

$Script:UseOmadaModule = $false
if ($IsWindows -and (Get-Module -Name OmadaWeb.PS -ListAvailable)) {
    try {
        Import-Module OmadaWeb.PS -ErrorAction Stop
        $Script:UseOmadaModule = $true
        Write-Host "  Using OmadaWeb.PS module for Omada requests" -ForegroundColor Gray
    } catch {
        Write-Host "  OmadaWeb.PS import failed, using direct requests: $($_.Exception.Message)" -ForegroundColor Yellow
    }
} elseif ($IsWindows) {
    Write-Host "  OmadaWeb.PS not installed, using direct requests (Install-Module OmadaWeb.PS for enhanced auth)" -ForegroundColor Yellow
} else {
    Write-Host "  Running on Linux — using direct Invoke-RestMethod for Omada requests" -ForegroundColor Gray
}

# ─── Helper: POST to Ingest API ──────────────────────────────────

function Invoke-IngestAPI {
    param(
        [string]$Endpoint,
        [hashtable]$Body
    )

    $headers = @{
        'Authorization' = "Bearer $ApiKey"
        'Content-Type'  = 'application/json'
    }

    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    $uri  = "$ApiBaseUrl/$Endpoint"

    $maxAttempts = 5
    $attempt     = 0
    while ($true) {
        $attempt++
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $json -TimeoutSec 300
            if ($attempt -gt 1) {
                Write-Host "  Recovered on attempt $attempt" -ForegroundColor Green
            }
            return $response
        }
        catch {
            $statusCode   = $null
            $responseBody = $null
            try {
                $statusCode = $_.Exception.Response.StatusCode.value__
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream) {
                    $reader = [System.IO.StreamReader]::new($stream)
                    $responseBody = $reader.ReadToEnd()
                    $reader.Close()
                }
            } catch {}

            $isTransient = (-not $statusCode) -or ($statusCode -ge 500) -or ($statusCode -eq 429)

            if ($isTransient -and $attempt -lt $maxAttempts) {
                $delay  = [Math]::Pow(2, $attempt)
                $reason = if ($statusCode) { "HTTP $statusCode" } else { $_.Exception.Message }
                Write-Host "  Transient failure on $Endpoint ($reason) — retry $attempt/$($maxAttempts - 1) in ${delay}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
                continue
            }

            Write-Host "  ERROR: $Endpoint returned $statusCode after $attempt attempt(s)" -ForegroundColor Red
            if ($responseBody) {
                Write-Host "  Response: $responseBody" -ForegroundColor Yellow
            } else {
                Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
            }
            throw
        }
    }
}

function Send-IngestBatch {
    param(
        [string]$Endpoint,
        [int]$SystemId,
        [string]$SyncMode   = 'full',
        [hashtable]$Scope   = @{},
        [array]$Records
    )

    if (-not $Records -or $Records.Count -eq 0) {
        Write-Host "  No records to send" -ForegroundColor Yellow
        return @{ inserted = 0; updated = 0; deleted = 0 }
    }

    Write-Host "  Sending $($Records.Count) records to $Endpoint..." -ForegroundColor Cyan

    if ($Records.Count -le $BatchSize) {
        $body = @{
            systemId = $SystemId
            syncMode = $SyncMode
            scope    = $Scope
            records  = $Records
        }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        Write-Host "  Result: $($result.inserted) inserted, $($result.updated) updated, $($result.deleted) deleted" -ForegroundColor Green
        return $result
    }

    # Chunked session for large payloads
    $totalInserted = 0
    $totalUpdated  = 0
    $syncId        = $null

    for ($i = 0; $i -lt $Records.Count; $i += $BatchSize) {
        $batch   = $Records[$i..([Math]::Min($i + $BatchSize - 1, $Records.Count - 1))]
        $isFirst = ($i -eq 0)
        $isLast  = ($i + $BatchSize -ge $Records.Count)

        $body = @{
            systemId    = $SystemId
            syncMode    = $SyncMode
            scope       = $Scope
            records     = $batch
            syncSession = if ($isFirst) { 'start' } elseif ($isLast) { 'end' } else { 'continue' }
        }
        if ($syncId) { $body.syncId = $syncId }

        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        if ($isFirst) { $syncId = $result.syncId }

        $totalInserted += ($result.inserted ?? 0)
        $totalUpdated  += ($result.updated  ?? 0)

        $batchNum    = [Math]::Floor($i / $BatchSize) + 1
        $totalBatches = [Math]::Ceiling($Records.Count / $BatchSize)
        Write-Host "  Batch $batchNum/$totalBatches done" -ForegroundColor Gray
    }

    $deleted = $result.deleted ?? 0
    Write-Host "  Total: $totalInserted inserted, $totalUpdated updated, $deleted deleted" -ForegroundColor Green
    return @{ inserted = $totalInserted; updated = $totalUpdated; deleted = $deleted }
}

# ─── Helper: report progress to the API ──────────────────────────

function Update-CrawlerProgress {
    param(
        [string]$Step,
        [int]$Pct    = -1,
        [string]$Detail
    )
    if (-not $JobId -or $JobId -le 0) { return }
    $body = @{ jobId = $JobId }
    if ($PSBoundParameters.ContainsKey('Step'))   { $body['step']   = $Step }
    if ($Pct -ge 0)                                { $body['pct']    = $Pct }
    if ($PSBoundParameters.ContainsKey('Detail')) { $body['detail'] = $Detail }
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post `
            -Headers $headers -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 10 | Out-Null
    } catch {
        # Silent — progress reporting must never break the crawl
    }
}

# ─── Auth: build request parameter hashtable ─────────────────────
# On Windows with OmadaWeb.PS: splatted to Invoke-OmadaODataMethod.
# On Linux / without module: splatted to Invoke-RestMethod directly.
# The hashtable holds auth-only params; OData headers are added per-call.

$Script:OmadaAuthParams = @{}
$Script:OmadaIsHttp     = $OmadaBaseUrl -like 'http://*'

switch ($AuthMode) {
    'WindowsIntegrated' {
        Write-Host "  Auth mode: Windows Integrated (Kerberos/NTLM)" -ForegroundColor Gray
        if ($Script:UseOmadaModule) {
            # OmadaWeb.PS 'Integrated' adds -UseDefaultCredentials to Invoke-RestMethod
            $Script:OmadaAuthParams['AuthenticationType'] = 'Integrated'
        } else {
            $Script:OmadaAuthParams['UseDefaultCredentials'] = $true
        }
    }
    'Credential' {
        Write-Host "  Auth mode: Explicit credential ($($OmadaCredential.UserName))" -ForegroundColor Gray
        if ($Script:UseOmadaModule) {
            # AuthenticationType='None' passes -Credential/-Authentication directly to
            # Invoke-RestMethod via Set-RequestParameter (not in the exclusion list).
            # (The module's 'Windows' type does Basic auth, not NTLM/Negotiate.)
            $Script:OmadaAuthParams['AuthenticationType'] = 'None'
            $Script:OmadaAuthParams['Credential']         = $OmadaCredential
            $Script:OmadaAuthParams['Authentication']     = 'Negotiate'
        } else {
            # On Linux, -Authentication Negotiate is not available.
            # Build a Basic auth header (Omada on-premise IIS accepts Basic alongside NTLM).
            $credPair = '{0}:{1}' -f $OmadaCredential.UserName, $OmadaCredential.GetNetworkCredential().Password
            $Script:OmadaAuthParams['_BasicAuthHeader'] = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($credPair))
        }
    }
    'OAuth2' {
        Write-Host "  Auth mode: OAuth2 (Entra ID client credentials)" -ForegroundColor Gray
        if ($Script:UseOmadaModule) {
            # OmadaWeb.PS 'OAuth' acquires token via client_credentials grant.
            # Credential.UserName = ClientId, Credential.Password = ClientSecret.
            $oauthCred = New-Object PSCredential(
                $ClientId,
                (ConvertTo-SecureString $ClientSecret -AsPlainText -Force)
            )
            $Script:OmadaAuthParams['AuthenticationType'] = 'OAuth'
            $Script:OmadaAuthParams['Credential']         = $oauthCred
            $Script:OmadaAuthParams['EntraIdTenantId']    = $TenantId
        } else {
            # Token acquired on first use; refreshed when near expiry
            $Script:OmadaOAuthToken  = $null
            $Script:OmadaTokenExpiry = [datetime]::MinValue
        }
    }
}

# HTTP (non-HTTPS) requires explicit opt-in for unencrypted auth in PS7
if ($Script:OmadaIsHttp) {
    $Script:OmadaAuthParams['AllowUnencryptedAuthentication'] = $true
}

function Get-OmadaOAuthToken {
    $tokenUri = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"
    $body = @{
        grant_type    = 'client_credentials'
        client_id     = $ClientId
        client_secret = $ClientSecret
        scope         = "$OmadaBaseUrl/.default"
    }
    $resp = Invoke-RestMethod -Uri $tokenUri -Method Post -Body $body `
        -ContentType 'application/x-www-form-urlencoded'
    $Script:OmadaOAuthToken  = $resp.access_token
    $Script:OmadaTokenExpiry = (Get-Date).AddSeconds($resp.expires_in - 300)
}

# ─── Helper: build auth headers for direct (non-module) requests ──

function Get-OmadaHeaders {
    param([hashtable]$Extra = @{})
    $h = @{ 'Accept' = 'application/json'; 'OData-Version' = '4.0'; 'OData-MaxVersion' = '4.0' }
    if ($Script:OmadaAuthParams.ContainsKey('_BasicAuthHeader')) {
        $h['Authorization'] = $Script:OmadaAuthParams['_BasicAuthHeader']
    }
    if ($AuthMode -eq 'OAuth2' -and -not $Script:UseOmadaModule) {
        if (-not $Script:OmadaOAuthToken -or (Get-Date) -ge $Script:OmadaTokenExpiry) {
            Get-OmadaOAuthToken
        }
        $h['Authorization'] = "Bearer $Script:OmadaOAuthToken"
    }
    foreach ($k in $Extra.Keys) { $h[$k] = $Extra[$k] }
    return $h
}

# ─── Helper: build Invoke-RestMethod splat for direct requests ────

function Get-OmadaRestParams {
    param([string]$Uri)
    $p = @{ Uri = $Uri; Method = 'Get'; Headers = (Get-OmadaHeaders); TimeoutSec = 120 }
    if ($Script:OmadaAuthParams.ContainsKey('UseDefaultCredentials')) {
        $p['UseDefaultCredentials'] = $true
    }
    if ($Script:OmadaIsHttp) {
        $p['AllowUnencryptedAuthentication'] = $true
    }
    return $p
}

# ─── Helper: GET all records from Omada OData ────────────────────
# The Omada OData service does not return @odata.nextLink — it either
# returns all records at once (no $top) or truncates to $top with no
# continuation token. We use $skip-based pagination: request pages of
# $ODataPageSize until a page comes back with fewer rows than requested.
# Uses OmadaWeb.PS on Windows, direct Invoke-RestMethod on Linux.
# Retries on transient failures with exponential backoff.

function Invoke-OmadaPage {
    param([string]$Uri)

    $maxAttempts = 5
    $attempt     = 0
    while ($true) {
        $attempt++
        try {
            if ($Script:UseOmadaModule) {
                $modParams = @{}
                foreach ($k in $Script:OmadaAuthParams.Keys) {
                    if ($k -ne '_BasicAuthHeader') { $modParams[$k] = $Script:OmadaAuthParams[$k] }
                }
                return Invoke-OmadaODataMethod -Uri $Uri -Method Get `
                    -Headers @{ 'OData-Version' = '4.0'; 'OData-MaxVersion' = '4.0' } `
                    -TimeoutSec 180 @modParams
            } else {
                $p = Get-OmadaRestParams -Uri $Uri
                return Invoke-RestMethod @p
            }
        }
        catch {
            $statusCode = $null
            try { $statusCode = $_.Exception.Response.StatusCode.value__ } catch {}
            $isTransient = (-not $statusCode) -or ($statusCode -ge 500) -or ($statusCode -eq 429)

            if ($isTransient -and $attempt -lt $maxAttempts) {
                $delay = [Math]::Pow(2, $attempt)
                Write-Host "  Omada request transient failure ($(if ($statusCode) { "HTTP $statusCode" } else { $_.Exception.Message })) — retry $attempt in ${delay}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
            } else {
                throw
            }
        }
    }
}

function Get-OmadaData {
    param(
        [Parameter(Mandatory)][string]$BaseUri   # URL without $top/$skip — appended here
    )

    $allResults = [System.Collections.Generic.List[object]]::new()
    $skip       = 0
    $sep        = if ($BaseUri -like '*?*') { '&' } else { '?' }

    while ($true) {
        $pageUri = "$BaseUri$($sep)`$top=$ODataPageSize&`$skip=$skip"
        $resp    = Invoke-OmadaPage -Uri $pageUri

        $batch = @($resp.value)
        if ($batch.Count -gt 0) {
            foreach ($item in $batch) { $allResults.Add($item) }
        }

        # Stop when the page is smaller than requested — we're at the end
        if ($batch.Count -lt $ODataPageSize) { break }
        $skip += $ODataPageSize
    }

    return $allResults
}

# ─── Helper: build OData query URL ───────────────────────────────
# Returns a URL without $top/$skip — Get-OmadaData appends those.
# Entity names are lowercase as required by the Omada OData service.

function Get-OmadaUrl {
    param([string]$Entity, [string[]]$Select, [string]$Filter = 'Deleted eq false')
    $entity  = $Entity.ToLower()
    $parts   = @()
    if ($Filter)  { $parts += "`$filter=$Filter" }
    if ($Select)  { $parts += "`$select=$($Select -join ',')" }
    $query   = if ($parts) { '?' + ($parts -join '&') } else { '' }
    return "$OmadaBaseUrl/$entity$query"
}

# ─── Main ─────────────────────────────────────────────────────────

Write-Host "`n=== Identity Atlas — Omada OData Crawler ===" -ForegroundColor Cyan
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting Omada sync via Ingest API" -ForegroundColor Cyan

# Verify Identity Atlas API connectivity
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Verifying Identity Atlas API connectivity..." -ForegroundColor Cyan
try {
    $headers = @{ 'Authorization' = "Bearer $ApiKey" }
    $whoami  = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers $headers
    Write-Host "  Connected as: $($whoami.displayName)" -ForegroundColor Green
} catch {
    Write-Host "  FAILED to connect to Identity Atlas API: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Verify Omada OData connectivity via $metadata
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Verifying Omada OData connectivity..." -ForegroundColor Cyan
try {
    $metaParams = Get-OmadaRestParams -Uri "$OmadaBaseUrl/`$metadata"
    $metaParams['Headers'] = Get-OmadaHeaders -Extra @{ Accept = 'application/xml' }
    if ($Script:UseOmadaModule) {
        $modParams = @{}
        foreach ($k in $Script:OmadaAuthParams.Keys) {
            if ($k -ne '_BasicAuthHeader') { $modParams[$k] = $Script:OmadaAuthParams[$k] }
        }
        Invoke-OmadaODataMethod -Uri "$OmadaBaseUrl/`$metadata" -Method Get `
            -Headers @{ Accept = 'application/xml' } -TimeoutSec 30 @modParams | Out-Null
    } else {
        Invoke-RestMethod @metaParams | Out-Null
    }
    Write-Host "  Connected to $OmadaBaseUrl" -ForegroundColor Green
} catch {
    Write-Host "  FAILED to connect to Omada OData API: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Register system
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Registering Omada system..." -ForegroundColor Cyan
$systemResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
    syncMode = 'delta'
    records  = @(@{
        systemType  = $SystemType
        displayName = $SystemName
        enabled     = $true
        syncEnabled = $true
    })
}

$systemId = $null
if ($systemResult.systemIds -and $systemResult.systemIds.Count -gt 0) {
    $systemId = [int]$systemResult.systemIds[0]
}
if (-not $systemId) {
    Write-Host "  WARNING: ingest/systems did not return a systemId — falling back to 1" -ForegroundColor Yellow
    $systemId = 1
}
Write-Host "  System ID: $systemId" -ForegroundColor Green

$syncStart = Get-Date

# Maps Omada system UId → IA system id; populated by the SyncSystems phase
# and used by SyncResources to route each resource to the right IA system.
$Script:OmadaSystemIdMap = @{}

# ─── Sync Omada Systems ───────────────────────────────────────────
# Fetches the Omada system catalog (SAP, Active Directory, etc.) and registers
# each as a separate Identity Atlas system so resources can be grouped correctly.
# System categories are fetched and stored on each system's extendedAttributes.

if ($SyncSystems) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing Omada Systems..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing Omada systems' -Pct 3

    # ── System categories ─────────────────────────────────────────
    $sysCatMap = @{}   # UId → { name, ident, contentType }
    try {
        $omadaSysCats = Get-OmadaData -BaseUri (Get-OmadaUrl 'systemcategory' -Select @(
            'UId','NAME','DisplayName','SC_IDENT','SC_CONTENT','SC_DEPRECATED'
        ))
        foreach ($cat in $omadaSysCats) {
            $catName = $cat.NAME; if (-not $catName) { $catName = $cat.DisplayName }
            $sysCatMap[$cat.UId] = @{
                name        = $catName
                ident       = $cat.SC_IDENT
                contentType = if ($cat.SC_CONTENT) { $cat.SC_CONTENT.Value } else { $null }
                deprecated  = [bool]$cat.SC_DEPRECATED
            }
        }
        Write-Host "  Fetched $($sysCatMap.Count) system categories" -ForegroundColor Gray
    } catch {
        Write-Host "  System category fetch skipped: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    # ── Systems ───────────────────────────────────────────────────
    try {
        $omadaSystems = Get-OmadaData -BaseUri (Get-OmadaUrl 'system' -Select @(
            'UId','NAME','DisplayName','DESCRIPTION','SYSTEMID','SYSTEMCATEGORY','SYSTEMSTATUS','ISLOGICALSYSTEM'
        ))
        Write-Host "  Fetched $($omadaSystems.Count) Omada Systems" -ForegroundColor Gray

        # Preserve order so we can map returned systemIds back to UIds
        $omadaSystemsList = @($omadaSystems)

        $sysRecords = @($omadaSystemsList | ForEach-Object {
            $name       = $_.NAME; if (-not $name) { $name = $_.DisplayName }
            $statusVal  = if ($_.SYSTEMSTATUS) { $_.SYSTEMSTATUS.Value } else { '' }
            $enabled    = (-not $statusVal) -or ($statusVal -eq 'Active')

            $ext = @{ omadaSystemId = $_.SYSTEMID }
            if ($_.DESCRIPTION) { $ext['description'] = $_.DESCRIPTION }

            # Category — display name is already inline on the system record
            if ($_.SYSTEMCATEGORY -and $_.SYSTEMCATEGORY.DisplayName) {
                $ext['systemCategory'] = $_.SYSTEMCATEGORY.DisplayName
                # Add extra category metadata if we fetched the catalog
                if ($_.SYSTEMCATEGORY.UId -and $sysCatMap.ContainsKey($_.SYSTEMCATEGORY.UId)) {
                    $cat = $sysCatMap[$_.SYSTEMCATEGORY.UId]
                    if ($cat.ident)       { $ext['systemCategoryIdent']       = $cat.ident }
                    if ($cat.contentType) { $ext['systemCategoryContentType'] = $cat.contentType }
                }
            }

            @{
                displayName        = $name
                systemType         = 'Omada'
                enabled            = $enabled
                syncEnabled        = $false   # provisioning is through Omada, not direct
                extendedAttributes = $ext
            }
        })

        if ($sysRecords.Count -gt 0) {
            $sysResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
                syncMode = 'delta'   # never delete — Omada systems are reference data
                records  = $sysRecords
            }

            # Build Omada system UId → IA system id map (returned order matches input order)
            if ($sysResult.systemIds) {
                for ($i = 0; $i -lt $omadaSystemsList.Count -and $i -lt $sysResult.systemIds.Count; $i++) {
                    $Script:OmadaSystemIdMap[$omadaSystemsList[$i].UId] = [int]$sysResult.systemIds[$i]
                }
            }
            Write-Host "  Registered $($sysRecords.Count) Omada Systems" -ForegroundColor Green
        }
    } catch {
        Write-Host "  System sync failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ─── Sync Contexts ────────────────────────────────────────────────
# Two sources:
#   1. orgunit entity  → contextType='OrgUnit'  (with parent hierarchy via PARENTOU)
#   2. contextassignment.CA_CONTEXT → contextType='Context' (non-hierarchical groupings)
# Must run before principals so contextId references exist.

$Script:CtxAssignments    = @()   # context assignments from contextassignment entity
$Script:IdentityToUserMap = @{}   # Omada Identity UId → User UId (built during user sync)

if ($SyncContexts) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing contexts (OrgUnits + Contexts)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing contexts' -Pct 5

    # ── OrgUnits ──────────────────────────────────────────────────
    try {
        $omadaOrgUnits = Get-OmadaData -BaseUri (Get-OmadaUrl 'orgunit' -Select @(
            'UId','NAME','DisplayName','OUID','PARENTOU','OUTYPE'
        ))
        Write-Host "  Fetched $($omadaOrgUnits.Count) Org Units" -ForegroundColor Gray

        $ouRecords = @($omadaOrgUnits | ForEach-Object {
            $displayName = $_.NAME
            if (-not $displayName) { $displayName = $_.DisplayName }
            if (-not $displayName) { $displayName = $_.UId }

            $rec = @{
                id          = $_.UId
                displayName = $displayName
                contextType = 'OrgUnit'
            }
            if ($_.PARENTOU -and $_.PARENTOU.UId) {
                $rec['parentContextId'] = $_.PARENTOU.UId
            }
            $rec
        })

        Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ contextType = 'OrgUnit' } -Records $ouRecords
    } catch {
        Write-Host "  OrgUnit sync failed: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }

    # ── Context assignments ───────────────────────────────────────
    # Collect unique CA_CONTEXT entries and ingest as contextType='Context'.
    # Also cache $Script:CtxAssignments so identities can inherit their primary context.
    try {
        $Script:CtxAssignments = Get-OmadaData -BaseUri (Get-OmadaUrl 'contextassignment' -Select @(
            'UId','CA_IDENTITY','CA_CONTEXT','VALIDFROM','VALIDTO'
        ))
        Write-Host "  Fetched $($Script:CtxAssignments.Count) context assignments" -ForegroundColor Gray

        $uniqueCtx = @{}
        foreach ($ca in $Script:CtxAssignments) {
            if ($ca.CA_CONTEXT -and $ca.CA_CONTEXT.UId -and -not $uniqueCtx.ContainsKey($ca.CA_CONTEXT.UId)) {
                $uniqueCtx[$ca.CA_CONTEXT.UId] = $ca.CA_CONTEXT.DisplayName
            }
        }

        if ($uniqueCtx.Count -gt 0) {
            $ctxRecords = @($uniqueCtx.GetEnumerator() | ForEach-Object {
                @{
                    id          = $_.Key
                    displayName = if ($_.Value) { $_.Value } else { $_.Key }
                    contextType = 'Context'
                }
            })
            Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ contextType = 'Context' } -Records $ctxRecords
        } else {
            Write-Host "  No additional context assignments found" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  Context assignment sync failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
        $Script:CtxAssignments = @()
    }
}

# ─── Sync Principals (Identities + Users) ────────────────────────

if ($SyncPrincipals) {

    # ── Omada Identities → IA Principals ──────────────────────────
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing principals (Omada Identities)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing identity principals' -Pct 15 -Detail 'Fetching from Omada...'

    try {
        $omadaIdentities = Get-OmadaData -BaseUri (Get-OmadaUrl 'identity' -Select @(
            'UId','IDENTITYID','FIRSTNAME','LASTNAME','EMAIL','JOBTITLE',
            'OUREF','IDENTITYTYPE','IDENTITYSTATUS','IDENTITYCATEGORY'
        ))

        Write-Host "  Fetched $($omadaIdentities.Count) Omada Identities" -ForegroundColor Gray
        Update-CrawlerProgress -Detail "Building $($omadaIdentities.Count) identity records..."

        # ── Omada Identities → IA Identities ─────────────────────
        # Omada Identities are real-person records (HR records), not accounts.
        # They map directly to the Identity Atlas Identities table.
        # User accounts (Omada User entity) are the principals that carry resource assignments.

        $identityRecords = @($omadaIdentities | ForEach-Object {
            $displayName = "$($_.FIRSTNAME) $($_.LASTNAME)".Trim()
            if (-not $displayName) { $displayName = $_.DisplayName }

            $identityTypeVal = if ($_.IDENTITYTYPE)   { $_.IDENTITYTYPE.Value   } else { '' }
            $statusVal       = if ($_.IDENTITYSTATUS) { $_.IDENTITYSTATUS.Value } else { '' }

            $rec = @{
                id          = $_.UId
                displayName = $displayName
                email       = $_.EMAIL
                employeeId  = $_.IDENTITYID
                jobTitle    = $_.JOBTITLE
            }

            if ($_.OUREF -and $_.OUREF.DisplayName) { $rec['department'] = $_.OUREF.DisplayName }
            if ($SyncContexts -and $_.OUREF -and $_.OUREF.UId) { $rec['contextId'] = $_.OUREF.UId }

            $ext = @{ omadaIdentityId = $_.IDENTITYID }
            if ($identityTypeVal)                                   { $ext['omadaIdentityType']     = $identityTypeVal }
            if ($_.IDENTITYCATEGORY -and $_.IDENTITYCATEGORY.Value){ $ext['omadaIdentityCategory'] = $_.IDENTITYCATEGORY.Value }
            if ($statusVal)                                         { $ext['omadaIdentityStatus']   = $statusVal }
            $rec['extendedAttributes'] = $ext

            $rec
        })

        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing identities (Omada Identities → IA Identities)..." -ForegroundColor Cyan
        Update-CrawlerProgress -Step 'Syncing identities' -Pct 25

        Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $systemId -SyncMode 'full' -Records $identityRecords

        # Store the identities list for later use (IdentityMembers, assignment mapping)
        $Script:OmadaIdentities = $omadaIdentities

    } catch {
        Write-Host "  Identity sync failed: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }

    # ── Omada Users → IA Principals ───────────────────────────────
    # Omada User entities represent managed accounts (e.g. AD accounts) linked to an Identity.
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing principals (Omada Users / managed accounts)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing user accounts' -Pct 35 -Detail 'Fetching Omada Users...'

    try {
        $omadaUsers = Get-OmadaData -BaseUri (Get-OmadaUrl 'user' -Select @(
            'UId','UserName','DisplayName','FIRSTNAME','LASTNAME','EMAIL',
            'JOBTITLE','OBJECTGUID','IDENTITYREF','Inactive'
        ))

        Write-Host "  Fetched $($omadaUsers.Count) Omada Users" -ForegroundColor Gray

        $userPrincipalRecords = @($omadaUsers | ForEach-Object {
            $displayName = $_.DisplayName
            if (-not $displayName) { $displayName = "$($_.FIRSTNAME) $($_.LASTNAME)".Trim() }
            if (-not $displayName) { $displayName = $_.UserName }

            $ext = @{}
            if ($_.OBJECTGUID) { $ext['objectGuid'] = $_.OBJECTGUID }
            if ($_.IDENTITYREF -and $_.IDENTITYREF.UId) {
                $ext['omadaIdentityId'] = $_.IDENTITYREF.UId
            }

            $rec = @{
                id            = $_.UId
                displayName   = $displayName
                email         = $_.EMAIL
                jobTitle      = $_.JOBTITLE
                principalType = 'User'
                enabled       = -not [bool]$_.Inactive
            }
            if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }
            $rec
        })

        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode 'full' -Records $userPrincipalRecords

        # ── Build identity UId → user UId map ─────────────────────
        # Used by the assignments phase to resolve IDENTITYREF to the account's principalId.
        $Script:IdentityToUserMap = @{}
        foreach ($u in $omadaUsers) {
            if ($u.IDENTITYREF -and $u.IDENTITYREF.UId) {
                # First linked user wins if an identity has multiple accounts
                if (-not $Script:IdentityToUserMap.ContainsKey($u.IDENTITYREF.UId)) {
                    $Script:IdentityToUserMap[$u.IDENTITYREF.UId] = $u.UId
                }
            }
        }

        # ── User.IDENTITYREF → IdentityMembers ────────────────────
        $userMembers = @($omadaUsers | Where-Object { $_.IDENTITYREF -and $_.IDENTITYREF.UId } | ForEach-Object {
            @{
                identityId  = $_.IDENTITYREF.UId
                principalId = $_.UId
                accountType = 'Primary'
            }
        })

        if ($userMembers.Count -gt 0) {
            Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing identity-members (User → Identity links)..." -ForegroundColor Cyan
            Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $systemId -SyncMode 'full' -Records $userMembers
        }

    } catch {
        Write-Host "  User/account sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  Continuing without Omada User records." -ForegroundColor Yellow
        $Script:IdentityToUserMap = @{}
    }
}

# ─── Sync Resources ───────────────────────────────────────────────

if ($SyncResources) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing resources (Omada Roles/Permissions)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing resources' -Pct 50 -Detail 'Fetching Omada Resources...'

    try {
        $omadaResources = Get-OmadaData -BaseUri (Get-OmadaUrl 'resource' -Select @(
            'UId','NAME','DisplayName','DESCRIPTION','ROLETYPEREF','SYSTEMREF',
            'RESOURCESTATUS','ROLEID','ROLECATEGORY'
        ))

        Write-Host "  Fetched $($omadaResources.Count) Omada Resources" -ForegroundColor Gray
        Update-CrawlerProgress -Detail "Building $($omadaResources.Count) resource records..."

        # Build (record, omadaSystemUId) pairs so we can route to the right IA system
        $resourcesWithSystem = @($omadaResources | ForEach-Object {
            $displayName = $_.NAME
            if (-not $displayName) { $displayName = $_.DisplayName }

            $resourceType = 'BusinessRole'
            if ($_.ROLETYPEREF -and $_.ROLETYPEREF.DisplayName) {
                $resourceType = $_.ROLETYPEREF.DisplayName
            }

            $statusVal = if ($_.RESOURCESTATUS) { $_.RESOURCESTATUS.Value } else { '' }
            $enabled   = $statusVal -eq 'Active' -or -not $statusVal

            $ext = @{}
            if ($_.ROLEID)                                   { $ext['omadaRoleId']       = $_.ROLEID }
            if ($_.ROLECATEGORY -and $_.ROLECATEGORY.Value)  { $ext['omadaRoleCategory'] = $_.ROLECATEGORY.Value }
            if ($_.SYSTEMREF -and $_.SYSTEMREF.DisplayName)  { $ext['omadaSystem']       = $_.SYSTEMREF.DisplayName }

            $rec = @{
                id           = $_.UId
                displayName  = $displayName
                description  = $_.DESCRIPTION
                resourceType = $resourceType
                enabled      = $enabled
            }
            if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }

            # Track the Omada system UId so we can route to the right IA system below
            $sysUId = if ($_.SYSTEMREF -and $_.SYSTEMREF.UId) { $_.SYSTEMREF.UId } else { $null }

            @{ record = $rec; sysUId = $sysUId }
        })

        # Group by (Omada system UId, resourceType) and ingest each group under
        # the matching IA system if one was registered, otherwise the main Omada system.
        $bySysUId = @{}
        foreach ($item in $resourcesWithSystem) {
            $key = if ($item.sysUId) { $item.sysUId } else { '_none' }
            if (-not $bySysUId.ContainsKey($key)) { $bySysUId[$key] = [System.Collections.Generic.List[object]]::new() }
            $bySysUId[$key].Add($item.record)
        }

        foreach ($sysUId in $bySysUId.Keys) {
            $iaSystemId = $systemId   # default: main Omada source system
            if ($sysUId -ne '_none' -and $Script:OmadaSystemIdMap.ContainsKey($sysUId)) {
                $iaSystemId = $Script:OmadaSystemIdMap[$sysUId]
            }

            $byType = @($bySysUId[$sysUId]) | Group-Object { $_['resourceType'] }
            foreach ($grp in $byType) {
                Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $iaSystemId -SyncMode 'full' `
                    -Scope @{ resourceType = $grp.Name } -Records @($grp.Group)
            }
        }

    } catch {
        Write-Host "  Resource sync failed: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }
}

# ─── Sync Assignments ─────────────────────────────────────────────

if ($SyncAssignments) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing assignments (Omada Resourceassignments)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing assignments' -Pct 70 -Detail 'Fetching Omada Resourceassignments...'

    try {
        $omadaAssignments = Get-OmadaData -BaseUri (Get-OmadaUrl 'resourceassignment' -Select @(
            'UId','IDENTITYREF','ROLEREF','ROLEASSNSTATUS','VALIDFROM','VALIDTO','SYSTEMREF'
        ))

        Write-Host "  Fetched $($omadaAssignments.Count) Omada Resourceassignments" -ForegroundColor Gray
        Update-CrawlerProgress -Detail "Building $($omadaAssignments.Count) assignment records..."

        # Resolve each assignment's principalId: prefer the linked user account (Omada User),
        # fall back to the identity UId when the identity has no managed user account.
        $idToUser = if ($Script:IdentityToUserMap) { $Script:IdentityToUserMap } else { @{} }

        $assignmentRecords = @($omadaAssignments | Where-Object {
            $_.IDENTITYREF -and $_.IDENTITYREF.UId -and $_.ROLEREF -and $_.ROLEREF.UId
        } | ForEach-Object {
            $identityUId = $_.IDENTITYREF.UId
            $principalId = if ($idToUser.ContainsKey($identityUId)) { $idToUser[$identityUId] } else { $identityUId }
            $statusVal   = if ($_.ROLEASSNSTATUS) { $_.ROLEASSNSTATUS.Value } else { $null }

            $rec = @{
                resourceId       = $_.ROLEREF.UId
                principalId      = $principalId
                assignmentType   = 'Governed'
                assignmentStatus = $statusVal
            }

            if ($_.VALIDFROM) { $rec['startDateTime']      = $_.VALIDFROM }
            if ($_.VALIDTO)   { $rec['expirationDateTime'] = $_.VALIDTO }

            $rec
        })

        # Deduplicate by (resourceId, principalId) — keep first occurrence
        $seen = @{}
        $assignmentRecords = @($assignmentRecords | Where-Object {
            $k = "$($_['resourceId'])|$($_['principalId'])"
            if ($seen.ContainsKey($k)) { $false } else { $seen[$k] = $true; $true }
        })

        Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ assignmentType = 'Governed' } -Records $assignmentRecords

    } catch {
        Write-Host "  Assignment sync failed: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }
}

# ─── Refresh views ───────────────────────────────────────────────

if ($RefreshViews) {
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 90 -Detail 'Rebuilding SQL views...'
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Refreshing materialized views..." -ForegroundColor Cyan
    try {
        Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null
        Write-Host "  Views refreshed" -ForegroundColor Green
    } catch {
        Write-Host "  View refresh failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Classifying business-role assignments..." -ForegroundColor Cyan
    try {
        Invoke-IngestAPI -Endpoint 'ingest/classify-business-role-assignments' -Body @{ systemId = $systemId } | Out-Null
        Write-Host "  Business-role assignments classified" -ForegroundColor Green
    } catch {
        Write-Host "  Classification failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ─── Summary and sync log ────────────────────────────────────────

$elapsed = (Get-Date) - $syncStart
Write-Host "`n=== Sync Complete ===" -ForegroundColor Green
Write-Host "Duration: $([Math]::Round($elapsed.TotalSeconds)) seconds" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Done' -Pct 100 -Detail "Completed in $([Math]::Round($elapsed.TotalSeconds))s"

try {
    Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{
        syncType    = 'Omada-FullCrawl'
        tableName   = $null
        startTime   = $syncStart.ToString('o')
        endTime     = (Get-Date).ToString('o')
        recordCount = 0
        status      = 'Success'
    } | Out-Null
} catch {
    Write-Host "  (sync log write failed: $($_.Exception.Message))" -ForegroundColor DarkGray
}
