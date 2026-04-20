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

.PARAMETER SyncContexts
    Sync calculated department contexts (default: true)

.PARAMETER RefreshViews
    Refresh materialized SQL views after sync (default: true)

.EXAMPLE
    .\Start-EntraIDCrawler.ps1 -ApiBaseUrl "https://myapp.azurewebsites.net/api" -ApiKey "fgc_abc123..." -ConfigFile ".\Config\mycompany.json"
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$ApiKey,

    [Parameter(Mandatory = $true)]
    [string]$ConfigFile,

    [switch]$SyncPrincipals = $true,
    [switch]$SyncServicePrincipals = $false,
    [switch]$SyncResources = $true,
    [switch]$SyncAssignments = $true,
    [switch]$SyncGovernance = $true,
    [switch]$SyncContexts = $true,
    [switch]$SyncPim = $false,
    [switch]$RefreshViews = $true,

    # Custom user attributes to include in the sync (added to $select)
    [string[]]$CustomUserAttributes = @(),

    # Custom group attributes to include in the sync (added to $select)
    [string[]]$CustomGroupAttributes = @(),

    # Extra regex fragments applied to servicePrincipal.displayName to flag an
    # SP as AIAgent. Combined with the built-in list ('copilot', 'openai', etc).
    # Case-insensitive; use \b word boundaries if exactness matters.
    [string[]]$AINamePatterns = @(),

    # Identity filter: select which users are treated as identities
    # Format: @{ attribute='employeeId'; condition='isNotNull' }
    #     or: @{ attribute='employeeType'; condition='equals'; value='Employee' }
    #     or: @{ attribute='companyName'; condition='inValues'; values=@('Contoso','Fabrikam') }
    [hashtable]$IdentityFilter = @{},

    # Optional CrawlerJobs.id — when set, the crawler reports fine-grained progress
    # back to the API so the UI can show a live "what is it doing right now" line.
    # Zero / unset = no progress reporting (script is being run standalone).
    [int]$JobId = 0
)

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

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
    $uri = "$ApiBaseUrl/$Endpoint"

    # Retry policy: up to 5 attempts with exponential backoff (2s, 4s, 8s, 16s, 32s).
    # Retries on transient failures (connection refused, timeouts, 5xx, 429). 4xx errors
    # other than 429 are considered permanent and fail immediately. This makes the crawler
    # survive short web container restarts (e.g. `docker compose up -d web`) without
    # aborting an in-progress sync.
    $maxAttempts = 5
    $attempt = 0
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
            $statusCode = $null
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

            # Decide if this is retryable: no status (network/connect failure), 5xx, or 429
            $isTransient = (-not $statusCode) -or ($statusCode -ge 500) -or ($statusCode -eq 429)

            if ($isTransient -and $attempt -lt $maxAttempts) {
                $delay = [Math]::Pow(2, $attempt)  # 2, 4, 8, 16, 32 seconds
                $reason = if ($statusCode) { "HTTP $statusCode" } else { $_.Exception.Message }
                Write-Host "  Transient failure on $Endpoint ($reason) — retry $attempt/$($maxAttempts - 1) in ${delay}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
                continue
            }

            $payloadMB = [Math]::Round($json.Length / 1MB, 2)
            Write-Host "  ERROR: $Endpoint returned $statusCode after $attempt attempt(s) (payload: ${payloadMB} MB)" -ForegroundColor Red
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
        [string]$SyncMode = 'full',
        [hashtable]$Scope = @{},
        [array]$Records,
        # 5000 strikes a balance between MERGE round-trip overhead and lock
        # duration. With RCSI enabled on the database, readers don't block on
        # writers, but smaller batches still make the crawler give back the
        # CPU more often and reduce tempdb version-store pressure.
        [int]$BatchSize = 5000
    )

    if (-not $Records -or $Records.Count -eq 0) {
        Write-Host "  No records to send" -ForegroundColor Yellow
        return @{ inserted = 0; updated = 0; deleted = 0 }
    }

    Write-Host "  Sending $($Records.Count) records to $Endpoint..." -ForegroundColor Cyan

    if ($Records.Count -le $BatchSize) {
        # Single batch
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

    # Chunked session
    $totalInserted = 0
    $totalUpdated = 0
    $syncId = $null

    for ($i = 0; $i -lt $Records.Count; $i += $BatchSize) {
        $batch = $Records[$i..([Math]::Min($i + $BatchSize - 1, $Records.Count - 1))]
        $isFirst = ($i -eq 0)
        $isLast = ($i + $BatchSize -ge $Records.Count)

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
        $totalUpdated += ($result.updated ?? 0)

        $batchNum = [Math]::Floor($i / $BatchSize) + 1
        $totalBatches = [Math]::Ceiling($Records.Count / $BatchSize)
        Write-Host "  Batch $batchNum/$totalBatches done" -ForegroundColor Gray
    }

    $deleted = $result.deleted ?? 0
    Write-Host "  Total: $totalInserted inserted, $totalUpdated updated, $deleted deleted" -ForegroundColor Green
    return @{ inserted = $totalInserted; updated = $totalUpdated; deleted = $deleted }
}

# ─── Helper: parallel Graph fetch for per-group children ─────────
# Fetches a per-group sub-collection (members, owners, eligibilitySchedules, ...)
# in parallel using PowerShell 7's runspace pool. This is the single biggest
# speedup in the crawler — for a tenant with 9k+ groups it cuts the assignment
# phases from 40-60 minutes down to 3-5 minutes.
#
# Why this exists: the previous implementation was a single foreach loop calling
# Invoke-FGGetRequest one group at a time. With ~150ms latency per Graph call,
# that's ~25 minutes per phase regardless of CPU/RAM. Parallelism is the only
# real lever — Graph allows ~10k req/10s on these endpoints, so 16 in flight
# leaves plenty of headroom for throttling.
#
# How it works:
#   - Groups are split into batches of 200
#   - Each batch is processed with -Parallel -ThrottleLimit 16
#   - The token is captured into a local var and passed via $using: (globals
#     don't propagate into runspaces)
#   - Each runspace handles its own retries on 429/5xx with exponential backoff
#   - Pagination inside the parallel block follows @odata.nextLink
#   - Between batches, the parent thread refreshes the token if needed and
#     reports progress to the UI
#
# Output: a hashtable @{ records = @(...); errorCount = N }
function Get-FGGroupChildrenParallel {
    param(
        [Parameter(Mandatory)] [array]$Groups,
        [Parameter(Mandatory)] [string]$ChildPath,    # 'members' or 'owners'
        [Parameter(Mandatory)] [scriptblock]$RecordBuilder,  # builds a record from $args=@($groupId,$child)
        [int]$ThrottleLimit = 16,
        [int]$BatchSize = 200,
        [string]$ProgressStep,
        [int]$ProgressStartPct,
        [int]$ProgressEndPct
    )

    $totalGroups = $Groups.Count
    $allRecords  = [System.Collections.Generic.List[object]]::new()
    $totalErrors = 0
    $checked     = 0

    # Process in batches so we can refresh the token and emit progress between rounds.
    for ($i = 0; $i -lt $totalGroups; $i += $BatchSize) {
        # Refresh token before each batch — Graph tokens last ~1h, but a long crawl
        # can outlast that, and we don't want runspaces holding stale tokens.
        if (Get-Command Update-FGAccessTokenIfExpired -ErrorAction SilentlyContinue) {
            Update-FGAccessTokenIfExpired -DebugFlag 'T' | Out-Null
        }
        $token = $Global:AccessToken
        if (-not $token) { throw "No Graph access token available" }

        $end = [Math]::Min($i + $BatchSize - 1, $totalGroups - 1)
        $batch = $Groups[$i..$end]

        # Run the batch in parallel. Each runspace returns an array of [pscustomobject]:
        #   - { kind='record';  resourceId; principalId; childType; ... } for each child
        #   - { kind='error';   resourceId; message } when a group fails after retries
        $batchOutput = $batch | ForEach-Object -Parallel {
            $g            = $_
            $token        = $using:token
            $childPathLoc = $using:ChildPath

            $headers = @{ Authorization = "Bearer $token" }
            $uri     = "https://graph.microsoft.com/beta/groups/$($g.id)/$childPathLoc`?`$select=id&`$top=999"

            $items = [System.Collections.Generic.List[object]]::new()
            $attempt = 0
            $maxAttempts = 4

            while ($uri) {
                $attempt++
                try {
                    $resp = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -TimeoutSec 60 -ErrorAction Stop
                    if ($resp.value) { foreach ($v in $resp.value) { $items.Add($v) } }
                    $uri = $resp.'@odata.nextLink'
                    $attempt = 0  # reset on success for nextLink retries
                }
                catch {
                    $status = $null
                    try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
                    # Retry transient errors with backoff. Skip the group entirely
                    # if we're still failing after maxAttempts.
                    if (($status -eq 429 -or ($status -ge 500 -and $status -lt 600) -or -not $status) -and $attempt -lt $maxAttempts) {
                        Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
                        continue
                    }
                    # Permanent failure — surface but don't break the whole batch
                    [pscustomobject]@{ kind = 'error'; resourceId = $g.id; message = $_.Exception.Message }
                    return
                }
            }

            foreach ($child in $items) {
                [pscustomobject]@{
                    kind        = 'record'
                    resourceId  = $g.id
                    principalId = $child.id
                    childType   = $child.'@odata.type'
                }
            }
        } -ThrottleLimit $ThrottleLimit

        # Fold parallel results into the totals (parent thread, not parallel).
        # Note: PowerShell's parser rejects `$list.Add(& $sb $arg)` because the
        # call-operator syntax is ambiguous inside a method call. Invoke the
        # script block via .Invoke() and store the result in a temp first.
        foreach ($o in $batchOutput) {
            if ($o.kind -eq 'error') {
                $totalErrors++
            } else {
                $rec = $RecordBuilder.Invoke($o)[0]
                $allRecords.Add($rec)
            }
        }

        $checked = [Math]::Min($i + $BatchSize, $totalGroups)
        if ($ProgressStep) {
            $span    = $ProgressEndPct - $ProgressStartPct
            $subPct  = $ProgressStartPct + [int](([double]$checked / $totalGroups) * $span)
            $errorTag = if ($totalErrors -gt 0) { " · $totalErrors errors" } else { '' }
            Update-CrawlerProgress -Step $ProgressStep -Pct $subPct `
                -Detail "$checked of $totalGroups groups · $($allRecords.Count) results$errorTag"
        }
    }

    return @{ records = $allRecords; errorCount = $totalErrors }
}

# ─── Helper: report fine-grained progress to the API ─────────────
# Sends partial updates (any of step/pct/detail) to /crawlers/job-progress so
# the UI can display "what is the crawler doing right now" between the
# worker's coarse-grained progress markers. No-op when running standalone
# (no JobId set).
#
# This function doubles as our abort-detection channel. The server-side
# endpoint returns HTTP 409 when the job is no longer `running` / `queued`
# — most commonly because the web container's bootstrap marked the job as
# `failed` on restart. Before: that signal was silently swallowed and the
# crawler kept processing an orphaned run, blocking the queue for hours.
# Now: 409 causes an immediate throw, which the dispatcher catches and
# turns into a clean "skip and move on" at the next poll.
#
# Transient errors (network blips, temporary 5xx) are still swallowed —
# progress reporting is non-critical and a 5s API hiccup should never
# kill a 90-minute crawl.
function Update-CrawlerProgress {
    param(
        [string]$Step,
        [int]$Pct = -1,
        [string]$Detail
    )
    if (-not $JobId -or $JobId -le 0) { return }
    $body = @{ jobId = $JobId }
    if ($PSBoundParameters.ContainsKey('Step'))   { $body['step']   = $Step }
    if ($Pct -ge 0)                                { $body['pct']    = $Pct }
    if ($PSBoundParameters.ContainsKey('Detail')) { $body['detail'] = $Detail }
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $json = $body | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post `
            -Headers $headers -Body $json -TimeoutSec 10 | Out-Null
    } catch {
        $statusCode = $null
        try { $statusCode = $_.Exception.Response.StatusCode.value__ } catch {}
        if ($statusCode -eq 409) {
            # The job has been terminated server-side. Propagate so the
            # dispatcher breaks out of the current crawl and the worker
            # moves on to the next queued job. Message format is
            # deliberately distinctive so operators grepping logs can
            # see the self-heal event.
            throw "Job $JobId terminated server-side (HTTP 409) — aborting crawl"
        }
        # Everything else is transient and non-critical.
    }
}

# ─── Main ─────────────────────────────────────────────────────────

Write-Host "`n=== FortigiGraph EntraID Crawler ===" -ForegroundColor Cyan
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting EntraID sync via Ingest API" -ForegroundColor Cyan

# Verify API connectivity
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Verifying API connectivity..." -ForegroundColor Cyan
try {
    $headers = @{ 'Authorization' = "Bearer $ApiKey" }
    $whoami = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/whoami" -Headers $headers
    Write-Host "  Connected as: $($whoami.displayName)" -ForegroundColor Green
}
catch {
    Write-Host "  FAILED to connect to API: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Get Graph access token
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Authenticating to Microsoft Graph..." -ForegroundColor Cyan
Get-FGAccessToken -ConfigFile $ConfigFile

# Register/get system
Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Registering system..." -ForegroundColor Cyan
$systemResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
    syncMode = 'delta'
    records  = @(@{
        systemType   = 'EntraID'
        displayName  = "Entra ID ($Global:TenantId)"
        tenantId     = $Global:TenantId
        enabled      = $true
        syncEnabled  = $true
    })
}

# Read the actual system ID from the API response. The ingest/systems endpoint
# returns systemIds[] in the response after looking up the merged record(s).
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

# ─── Helper: get attribute value, handling extensionAttributeN ────
# extensionAttribute1-15 live under onPremisesExtensionAttributes
function Get-UserAttrValue {
    param($User, [string]$AttrName)
    if ($AttrName -match '^extensionAttribute\d+$') {
        if ($User.onPremisesExtensionAttributes) {
            return $User.onPremisesExtensionAttributes.$AttrName
        }
        return $null
    }
    return $User.$AttrName
}

# ─── Sync Principals ─────────────────────────────────────────────
if ($SyncPrincipals) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing principals (users)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing users' -Pct 12 -Detail 'Fetching from Microsoft Graph...'

    # Build $select dynamically — core attributes + custom.
    # signInActivity and userType are included so the risk scoring engine can
    # compute "stale account" and "guest user" signals. signInActivity requires
    # AuditLog.Read.All (already in the base permission set). `manager` is
    # expanded inline so we get managerId in one round trip — the alternative
    # (/users/{id}/manager per user) is ~4,500 requests for a mid-size tenant.
    $coreUserAttrs = @(
        'id','displayName','mail','userPrincipalName','accountEnabled',
        'givenName','surname','department','jobTitle','companyName','employeeId',
        'createdDateTime','userType','signInActivity','externalUserState'
    )

    # If any custom attribute is extensionAttributeN, add onPremisesExtensionAttributes to the select
    $extraSelectAttrs = @()
    $hasExtensionAttrs = $false
    foreach ($attr in $CustomUserAttributes) {
        if ($attr -match '^extensionAttribute\d+$') {
            $hasExtensionAttrs = $true
        } else {
            $extraSelectAttrs += $attr
        }
    }
    # Also check identity filter — if it filters on extensionAttributeN we need the parent
    if ($IdentityFilter['attribute'] -match '^extensionAttribute\d+$') {
        $hasExtensionAttrs = $true
    }
    if ($hasExtensionAttrs) {
        $extraSelectAttrs += 'onPremisesExtensionAttributes'
    }
    $allUserAttrs = $coreUserAttrs + $extraSelectAttrs | Select-Object -Unique
    $userSelect = $allUserAttrs -join ','
    # $expand=manager($select=id) pulls the manager reference inline — only the
    # id is needed on the Principals side, the ingest endpoint resolves it.
    $users = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/users?`$select=$userSelect&`$expand=manager(`$select=id)&`$top=999"
    Update-CrawlerProgress -Detail "Building $($users.Count) user records..."

    $records = @($users | ForEach-Object {
        $rec = @{
            id               = $_.id
            displayName      = $_.displayName
            email            = $_.mail ?? $_.userPrincipalName
            accountEnabled   = [bool]$_.accountEnabled
            principalType    = 'User'
            givenName        = $_.givenName
            surname          = $_.surname
            department       = $_.department
            jobTitle         = $_.jobTitle
            companyName      = $_.companyName
            employeeId       = $_.employeeId
            createdDateTime  = $_.createdDateTime
        }
        # Manager relationship (from $expand=manager)
        if ($_.manager -and $_.manager.id) {
            $rec['managerId'] = $_.manager.id
        }

        # Build extendedAttributes: signInActivity, userType, externalUserState
        # plus any custom attributes the operator asked for. We put hygiene
        # signals in extendedAttributes because there are no first-class
        # columns for them on Principals — the scoring engine reads them from
        # the jsonb blob at scoring time.
        $ext = @{}
        if ($_.userType)          { $ext['userType']          = $_.userType }
        if ($_.externalUserState) { $ext['externalUserState'] = $_.externalUserState }
        if ($_.signInActivity) {
            $sia = @{}
            if ($_.signInActivity.lastSignInDateTime)                     { $sia['lastSignInDateTime']                     = $_.signInActivity.lastSignInDateTime }
            if ($_.signInActivity.lastNonInteractiveSignInDateTime)       { $sia['lastNonInteractiveSignInDateTime']       = $_.signInActivity.lastNonInteractiveSignInDateTime }
            if ($_.signInActivity.lastSuccessfulSignInDateTime)           { $sia['lastSuccessfulSignInDateTime']           = $_.signInActivity.lastSuccessfulSignInDateTime }
            if ($sia.Count -gt 0) { $ext['signInActivity'] = $sia }
        }
        if ($CustomUserAttributes.Count -gt 0) {
            foreach ($attr in $CustomUserAttributes) {
                $val = Get-UserAttrValue -User $_ -AttrName $attr
                if ($null -ne $val -and $val -ne '') { $ext[$attr] = $val }
            }
        }
        if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }
        $rec
    })

    Update-CrawlerProgress -Detail "Uploading $($records.Count) users to ingest API..."
    Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode 'full' `
        -Scope @{ principalType = 'User' } -Records $records

    # ─── Identity sync (filtered subset of users) ────────────────
    if ($IdentityFilter.Count -gt 0 -and $IdentityFilter['attribute']) {
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing identities (filtered from users)..." -ForegroundColor Cyan
        $attr = $IdentityFilter['attribute']
        $condition = $IdentityFilter['condition']
        $filterValue = $IdentityFilter['value']
        $filterValues = $IdentityFilter['values']

        # Coerce filter value to match the attribute's runtime type — booleans
        # need a real $true/$false (PowerShell -eq is type-strict for booleans)
        function ConvertTo-FilterValue {
            param($Value, $Sample)
            if ($null -eq $Value -or $null -eq $Sample) { return $Value }
            if ($Sample -is [bool]) {
                if ($Value -is [bool]) { return $Value }
                $s = "$Value".Trim().ToLower()
                if ($s -in @('true','1','yes','on'))  { return $true }
                if ($s -in @('false','0','no','off')) { return $false }
            }
            if ($Sample -is [int] -or $Sample -is [long]) {
                $n = 0; if ([int]::TryParse("$Value", [ref]$n)) { return $n }
            }
            return $Value
        }

        $identityUsers = $users | Where-Object {
            $val = Get-UserAttrValue -User $_ -AttrName $attr
            $coercedValue = ConvertTo-FilterValue -Value $filterValue -Sample $val
            $coercedValues = if ($filterValues) { $filterValues | ForEach-Object { ConvertTo-FilterValue -Value $_ -Sample $val } } else { @() }
            switch ($condition) {
                'isNotNull'  { $null -ne $val -and $val -ne '' }
                'equals'     { $val -eq $coercedValue }
                'notEquals'  { $val -ne $coercedValue }
                'inValues'   { $coercedValues -contains $val }
                default      { $false }
            }
        }

        Write-Host "  Matched $($identityUsers.Count) of $($users.Count) users as identities (filter: $attr $condition $filterValue$($filterValues -join ','))" -ForegroundColor Cyan

        if ($identityUsers.Count -gt 0) {
            $idRecords = @($identityUsers | ForEach-Object {
                $idRec = @{
                    id            = $_.id
                    displayName   = $_.displayName
                    email         = $_.mail ?? $_.userPrincipalName
                    department    = $_.department
                    jobTitle      = $_.jobTitle
                    companyName   = $_.companyName
                    employeeId    = $_.employeeId
                }
                # Identities also get custom attributes in extendedAttributes
                if ($CustomUserAttributes.Count -gt 0) {
                    $ext = @{}
                    foreach ($a in $CustomUserAttributes) {
                        $v = Get-UserAttrValue -User $_ -AttrName $a
                        if ($null -ne $v -and $v -ne '') { $ext[$a] = $v }
                    }
                    if ($ext.Count -gt 0) { $idRec['extendedAttributes'] = $ext }
                }
                $idRec
            })

            Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $systemId -SyncMode 'full' -Records $idRecords

            # Link identities to principals
            $idMembers = @($identityUsers | ForEach-Object {
                @{
                    identityId  = $_.id
                    principalId = $_.id
                }
            })
            Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $systemId -SyncMode 'full' -Records $idMembers
        }
    }
}

# ─── Sync Service Principals ─────────────────────────────────────
# Service principals are Entra ID's non-human identities — enterprise-app SPs,
# managed identities, AI agents (Copilot Studio / Azure OpenAI), etc. They own
# a large fraction of role assignments in Azure and M365, so we want them in
# the `Principals` table alongside human users.
#
# We classify each SP into one of the schema's principalType values via
# Get-FGServicePrincipalType (from tools/powershell-sdk/helpers). Each class
# gets its own full-sync batch because the ingest API's scoped-delete works
# on exactly one principalType value at a time.
if ($SyncServicePrincipals) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing service principals..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing service principals' -Pct 18 -Detail 'Fetching from Microsoft Graph...'

    # `tags` and `servicePrincipalType` drive classification; `appId`,
    # `appOwnerOrganizationId`, and `notes` go into extendedAttributes for
    # downstream visibility. `accountEnabled` lives in its dedicated column.
    $spSelectAttrs = @(
        'id','appId','displayName','servicePrincipalType','accountEnabled',
        'tags','appOwnerOrganizationId','createdDateTime','notes',
        'servicePrincipalNames','homepage','publisherName'
    )
    $spSelect = $spSelectAttrs -join ','
    $sps = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals?`$select=$spSelect&`$top=999"
    Update-CrawlerProgress -Detail "Classifying $($sps.Count) service principals..."

    # Bucket records by principalType so we can submit one scoped full-sync
    # per type. An empty bucket is skipped entirely to avoid an unintended
    # delete-everything-of-that-type against the DB.
    $buckets = @{
        ServicePrincipal = New-Object System.Collections.ArrayList
        ManagedIdentity  = New-Object System.Collections.ArrayList
        AIAgent          = New-Object System.Collections.ArrayList
    }

    foreach ($sp in $sps) {
        $pt = Get-FGServicePrincipalType -ServicePrincipal $sp -AINamePatterns $AINamePatterns

        $rec = @{
            id             = $sp.id
            displayName    = $sp.displayName
            accountEnabled = [bool]$sp.accountEnabled
            principalType  = $pt
        }
        if ($sp.createdDateTime) { $rec['createdDateTime'] = $sp.createdDateTime }

        # Everything that isn't a first-class column but is useful for filters
        # or risk signals lives in extendedAttributes. We stringify arrays
        # (tags, servicePrincipalNames) because jsonb_typeof filters arrays out
        # of the filter-dropdown discovery and a comma-joined string keeps the
        # key discoverable.
        $ext = @{}
        if ($sp.appId)                   { $ext['appId']                   = $sp.appId }
        if ($sp.servicePrincipalType)    { $ext['servicePrincipalType']    = $sp.servicePrincipalType }
        if ($sp.appOwnerOrganizationId)  { $ext['appOwnerOrganizationId']  = $sp.appOwnerOrganizationId }
        if ($sp.publisherName)           { $ext['publisherName']           = $sp.publisherName }
        if ($sp.homepage)                { $ext['homepage']                = $sp.homepage }
        if ($sp.notes)                   { $ext['notes']                   = $sp.notes }
        if ($sp.tags -and $sp.tags.Count -gt 0) {
            $ext['tags'] = ($sp.tags -join ',')
        }
        if ($sp.servicePrincipalNames -and $sp.servicePrincipalNames.Count -gt 0) {
            $ext['servicePrincipalNames'] = ($sp.servicePrincipalNames -join ',')
        }
        if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }

        [void]$buckets[$pt].Add($rec)
    }

    Write-Host ("  Classified: {0} ServicePrincipal / {1} ManagedIdentity / {2} AIAgent" -f `
        $buckets.ServicePrincipal.Count, $buckets.ManagedIdentity.Count, $buckets.AIAgent.Count) -ForegroundColor Gray

    foreach ($pt in @('ServicePrincipal','ManagedIdentity','AIAgent')) {
        $bucket = $buckets[$pt]
        if ($bucket.Count -eq 0) { continue }
        Update-CrawlerProgress -Detail "Uploading $($bucket.Count) $pt records..."
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ principalType = $pt } -Records @($bucket)
    }
}

# ─── Sync Resources (Groups) ─────────────────────────────────────
if ($SyncResources) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing resources (groups)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing groups' -Pct 20 -Detail 'Fetching groups from Microsoft Graph...'
    $coreGroupAttrs = @('id','displayName','description','mail','visibility','createdDateTime','groupTypes','securityEnabled','mailEnabled')
    $allGroupAttrs = $coreGroupAttrs + $CustomGroupAttributes | Select-Object -Unique
    $groupSelect = $allGroupAttrs -join ','
    $groups = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/groups?`$select=$groupSelect&`$top=999"

    $records = @($groups | ForEach-Object {
        $ext = @{
            groupTypes      = ($_.groupTypes -join ',')
            securityEnabled = $_.securityEnabled
            mailEnabled     = $_.mailEnabled
        }
        foreach ($attr in $CustomGroupAttributes) {
            if ($_.$attr -ne $null) { $ext[$attr] = $_.$attr }
        }
        @{
            id              = $_.id
            displayName     = $_.displayName
            description     = $_.description
            resourceType    = 'EntraGroup'
            mail            = $_.mail
            visibility      = $_.visibility
            enabled         = $true
            createdDateTime = $_.createdDateTime
            extendedAttributes = $ext
        }
    })

    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $systemId -SyncMode 'full' `
        -Scope @{ resourceType = 'EntraGroup' } -Records $records
}

# ─── Sync Assignments (Group Members) ────────────────────────────
if ($SyncAssignments) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing assignments (group memberships)..." -ForegroundColor Cyan
    $totalGroups = $groups.Count
    Update-CrawlerProgress -Step 'Syncing group memberships' -Pct 25 -Detail "0 of $totalGroups groups"

    # Parallel fetch — see Get-FGGroupChildrenParallel for design notes.
    $memberResult = Get-FGGroupChildrenParallel `
        -Groups $groups -ChildPath 'members' -ThrottleLimit 16 `
        -ProgressStep 'Syncing group memberships' -ProgressStartPct 25 -ProgressEndPct 50 `
        -RecordBuilder {
            param($o)
            @{
                resourceId     = $o.resourceId
                principalId    = $o.principalId
                assignmentType = 'Direct'
                principalType  = if ($o.childType -eq '#microsoft.graph.group') { 'Group' } else { 'User' }
            }
        }
    $allMembers = $memberResult.records
    if ($memberResult.errorCount -gt 0) {
        Write-Host "  WARNING: $($memberResult.errorCount) groups failed after retries (skipped)" -ForegroundColor Yellow
    }

    Update-CrawlerProgress -Detail "Uploading $($allMembers.Count) memberships to ingest API..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $systemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Direct' } -Records $allMembers

    # Group Owners
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing assignments (group owners)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing group owners' -Pct 51 -Detail "0 of $totalGroups groups"

    $ownerResult = Get-FGGroupChildrenParallel `
        -Groups $groups -ChildPath 'owners' -ThrottleLimit 16 `
        -ProgressStep 'Syncing group owners' -ProgressStartPct 51 -ProgressEndPct 60 `
        -RecordBuilder {
            param($o)
            @{
                resourceId     = $o.resourceId
                principalId    = $o.principalId
                assignmentType = 'Owner'
            }
        }
    $allOwners = $ownerResult.records
    if ($ownerResult.errorCount -gt 0) {
        Write-Host "  WARNING: $($ownerResult.errorCount) groups failed during owner fetch (skipped)" -ForegroundColor Yellow
    }

    Update-CrawlerProgress -Detail "Uploading $($allOwners.Count) owner assignments..."
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $systemId -SyncMode 'full' `
        -Scope @{ assignmentType = 'Owner' } -Records $allOwners
}

# ─── Sync PIM (Eligible group memberships) ───────────────────────
# Privileged Identity Management gives users "Eligible" (not active) membership
# in groups. Each group must be queried individually because the Graph API
# requires a groupId filter on /privilegedAccess/group/eligibilitySchedules.
if ($SyncPim) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing PIM eligible memberships..." -ForegroundColor Cyan
    try {
        # Filter out dynamic groups (cannot be PIM-enabled)
        $candidateGroups = $groups | Where-Object { $_.groupTypes -notcontains 'DynamicMembership' }
        $pimTotal = $candidateGroups.Count
        Write-Host "  Checking $pimTotal groups for PIM eligibility..." -ForegroundColor Gray
        Update-CrawlerProgress -Step 'Syncing PIM eligibilities' -Pct 61 -Detail "0 of $pimTotal groups"

        # Parallel PIM eligibility check. Same pattern as Get-FGGroupChildrenParallel
        # but inlined because the URI is filter-based instead of /groups/{id}/sub.
        # Most groups will return zero eligibilities (and Graph returns 4xx for some
        # group types), so per-group errors are normal — we just count them.
        $pimRecordsList = [System.Collections.Generic.List[object]]::new()
        $pimGroupCount  = 0
        $pimBatchSize   = 200
        $pimChecked     = 0

        for ($i = 0; $i -lt $pimTotal; $i += $pimBatchSize) {
            if (Get-Command Update-FGAccessTokenIfExpired -ErrorAction SilentlyContinue) {
                Update-FGAccessTokenIfExpired -DebugFlag 'T' | Out-Null
            }
            $token = $Global:AccessToken
            $end = [Math]::Min($i + $pimBatchSize - 1, $pimTotal - 1)
            $batch = $candidateGroups[$i..$end]

            $batchOutput = $batch | ForEach-Object -Parallel {
                $g = $_
                $token = $using:token
                $headers = @{ Authorization = "Bearer $token" }
                $uri = "https://graph.microsoft.com/beta/identityGovernance/privilegedAccess/group/eligibilitySchedules?`$filter=groupId eq '$($g.id)'"
                try {
                    $resp = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -TimeoutSec 30 -ErrorAction Stop
                    if ($resp.value -and $resp.value.Count -gt 0) {
                        foreach ($e in $resp.value) {
                            [pscustomobject]@{
                                resourceId         = $e.groupId
                                principalId        = $e.principalId
                                principalType      = 'User'
                                assignmentType     = 'Eligible'
                                state              = $e.status
                                expirationDateTime = $e.scheduleInfo.expiration.endDateTime
                            }
                        }
                    }
                } catch {
                    # Most groups are not PIM-enabled — silently skip
                }
            } -ThrottleLimit 16

            # Group output by source group to compute pimGroupCount accurately
            $groupSet = @{}
            foreach ($r in $batchOutput) {
                $pimRecordsList.Add(@{
                    resourceId         = $r.resourceId
                    principalId        = $r.principalId
                    principalType      = $r.principalType
                    assignmentType     = $r.assignmentType
                    state              = $r.state
                    expirationDateTime = $r.expirationDateTime
                })
                $groupSet[$r.resourceId] = $true
            }
            $pimGroupCount += $groupSet.Count

            $pimChecked = [Math]::Min($i + $pimBatchSize, $pimTotal)
            $subPct = 61 + [int](([double]$pimChecked / $pimTotal) * 4)
            Update-CrawlerProgress -Pct $subPct -Detail "$pimChecked of $pimTotal groups · $pimGroupCount with eligibilities"
        }

        $pimRecords = @($pimRecordsList)
        Write-Host "  Found $pimGroupCount PIM-enabled group(s) with $($pimRecords.Count) eligible memberships" -ForegroundColor Gray

        if ($pimRecords.Count -gt 0) {
            # Dedup by (resourceId, principalId)
            $seen = @{}
            $pimRecords = @($pimRecords | Where-Object {
                $k = "$($_.resourceId)|$($_.principalId)"
                if ($seen.ContainsKey($k)) { $false } else { $seen[$k] = $true; $true }
            })
            Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ assignmentType = 'Eligible' } -Records $pimRecords
        }
    } catch {
        Write-Host "  PIM sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ─── Sync Governance ─────────────────────────────────────────────
if ($SyncGovernance) {
    Update-CrawlerProgress -Step 'Syncing governance' -Pct 66 -Detail 'Catalogs, access packages, policies, reviews...'
    try {
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (catalogs)..." -ForegroundColor Cyan
        $catalogs = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs?`$top=999"

        $catRecords = @($catalogs | ForEach-Object {
            @{
                id              = $_.id
                displayName     = $_.displayName
                description     = $_.description
                catalogType     = $_.catalogType
                enabled         = [bool]$_.isPublished
                createdDateTime = $_.createdDateTime
                modifiedDateTime = $_.modifiedDateTime
            }
        })
        Send-IngestBatch -Endpoint 'ingest/governance/catalogs' -SystemId $systemId -SyncMode 'full' -Records $catRecords

        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access packages -> business roles)..." -ForegroundColor Cyan
        $accessPackages = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages?`$top=999"

        $apRecords = @($accessPackages | ForEach-Object {
            @{
                id              = $_.id
                displayName     = $_.displayName
                description     = $_.description
                resourceType    = 'BusinessRole'
                catalogId       = $_.catalogId
                isHidden        = [bool]$_.isHidden
                enabled         = $true
                createdDateTime = $_.createdDateTime
                modifiedDateTime = $_.modifiedDateTime
            }
        })
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $systemId -SyncMode 'full' `
            -Scope @{ resourceType = 'BusinessRole' } -Records $apRecords

        # ── Access Package Resource Role Scopes (which groups each AP grants) ─
        # Each AP has resourceRoleScopes that describe the groups/resources it
        # contains. Without these, the matrix view can't show the AP coloring on
        # user→group cells, because vw_UserPermissionAssignmentViaBusinessRole
        # joins via ResourceRelationships(relationshipType='Contains').
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access package resource scopes)..." -ForegroundColor Cyan
        try {
            $relRecords = @()
            foreach ($ap in $accessPackages) {
                try {
                    $apDetail = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages/$($ap.id)?`$expand=accessPackageResourceRoleScopes(`$expand=accessPackageResourceRole,accessPackageResourceScope)"
                    foreach ($rrs in @($apDetail.accessPackageResourceRoleScopes)) {
                        $scope = $rrs.accessPackageResourceScope
                        $role = $rrs.accessPackageResourceRole
                        if (-not $scope -or -not $scope.originId) { continue }
                        $relRecords += @{
                            parentResourceId = $ap.id
                            childResourceId  = $scope.originId
                            relationshipType = 'Contains'
                            roleName         = if ($role) { $role.displayName } else { 'Member' }
                            roleOriginSystem = if ($role) { $role.originSystem } else { 'AadGroup' }
                        }
                    }
                } catch {
                    Write-Host "  Skipping AP $($ap.displayName): $($_.Exception.Message)" -ForegroundColor Yellow
                }
            }

            if ($relRecords.Count -gt 0) {
                # Dedupe (parent + child) — Graph can return duplicates if AP has multiple roles on same group
                $seen = @{}
                $relRecords = @($relRecords | Where-Object {
                    $k = "$($_.parentResourceId)|$($_.childResourceId)"
                    if ($seen.ContainsKey($k)) { $false } else { $seen[$k] = $true; $true }
                })
                Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $systemId -SyncMode 'full' `
                    -Scope @{ relationshipType = 'Contains' } -Records $relRecords
            } else {
                Write-Host "  No access package resource scopes found" -ForegroundColor Yellow
            }
        }
        catch {
            Write-Host "  Resource scope sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }

        # ── Access Package Assignments (Governed) ────────────────────
        # Each assignment links a user (target) to an access package
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access package assignments)..." -ForegroundColor Cyan
        try {
            $assignments = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignments?`$expand=target,accessPackage&`$top=999"

            # Deduplicate by (resourceId, principalId) — keep the most recent active assignment.
            # Graph can return multiple assignments per user/AP (delivered, expired, removed, etc.)
            $seenKeys = @{}
            $assignRecords = @()
            foreach ($a in $assignments) {
                $apId = if ($a.accessPackage) { $a.accessPackage.id } else { $null }
                $targetId = if ($a.target) { $a.target.objectId } else { $null }
                if (-not $apId -or -not $targetId) { continue }

                $state = $a.assignmentState
                # Skip non-active states (Expired, Removed, Denied)
                if ($state -and $state -notin @('Delivered','PendingApproval','Active')) { continue }

                $key = "$apId|$targetId"
                if ($seenKeys.ContainsKey($key)) { continue }
                $seenKeys[$key] = $true

                $assignRecords += @{
                    resourceId         = $apId
                    principalId        = $targetId
                    principalType      = 'User'
                    assignmentType     = 'Governed'
                    state              = $state
                    assignmentStatus   = $a.assignmentStatus
                    expirationDateTime = $a.expiredDateTime
                }
            }

            if ($assignRecords.Count -gt 0) {
                Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $systemId -SyncMode 'full' `
                    -Scope @{ assignmentType = 'Governed' } -Records $assignRecords
            } else {
                Write-Host "  No active access package assignments found" -ForegroundColor Yellow
            }
        }
        catch {
            Write-Host "  Access Package assignments sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }

        # ── Access Package Assignment Policies ───────────────────────
        # Drives the "Type" column on the Business Roles page (Auto-assigned vs
        # Request-based) and the hasReviewConfigured flag. Without this the page
        # shows blank type/review badges even when policies exist in Graph.
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (assignment policies)..." -ForegroundColor Cyan
        try {
            $policies = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/assignmentPolicies?`$expand=accessPackage&`$top=999"
            $polRecords = @()
            foreach ($pol in $policies) {
                $apId = if ($pol.accessPackage) { $pol.accessPackage.id } else { $pol.accessPackageId }
                if (-not $apId) { continue }
                $hasAutoAdd = $false
                $hasAutoRemove = $false
                if ($pol.automaticRequestSettings) {
                    $hasAutoAdd    = [bool]$pol.automaticRequestSettings.requestAccessForAllowedTargets
                    $hasAutoRemove = [bool]$pol.automaticRequestSettings.removeAccessWhenTargetLeavesAllowedTargets
                }
                $hasReview = $false
                if ($pol.reviewSettings) {
                    $hasReview = [bool]$pol.reviewSettings.isEnabled
                }
                $polRecords += @{
                    id                 = $pol.id
                    resourceId         = $apId
                    displayName        = $pol.displayName
                    description        = $pol.description
                    allowedTargetScope = $pol.allowedTargetScope
                    hasAutoAddRule     = $hasAutoAdd
                    hasAutoRemoveRule  = $hasAutoRemove
                    hasAccessReview    = $hasReview
                    reviewSettings     = $pol.reviewSettings
                    policyConditions   = $pol.requestorSettings
                }
            }
            if ($polRecords.Count -gt 0) {
                Send-IngestBatch -Endpoint 'ingest/governance/policies' -SystemId $systemId -SyncMode 'full' -Records $polRecords
            } else {
                Write-Host "  No assignment policies found" -ForegroundColor Yellow
            }
        }
        catch {
            Write-Host "  Assignment policy sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }

        # ── Access Reviews → CertificationDecisions ──────────────────
        # Drives the Last Review / Reviewer / Compliance columns on the Business
        # Roles page. Walks all access review definitions whose scope targets an
        # access package, then pulls instance decisions. Best-effort: tenant may
        # not use access reviews at all, in which case this is a no-op.
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access review decisions)..." -ForegroundColor Cyan
        try {
            $reviewDefs = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions?`$top=100"
            $certRecords = @()
            foreach ($def in $reviewDefs) {
                $scopeQuery = if ($def.scope) { $def.scope.query } else { $null }
                if (-not $scopeQuery -or $scopeQuery -notmatch 'accessPackages') { continue }
                # Extract the access package id from the scope query
                $apId = $null
                if ($scopeQuery -match "accessPackages/([0-9a-fA-F-]{36})") { $apId = $Matches[1] }
                if (-not $apId) { continue }
                try {
                    $instances = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions/$($def.id)/instances?`$top=100"
                    foreach ($inst in $instances) {
                        try {
                            $decisions = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions/$($def.id)/instances/$($inst.id)/decisions?`$top=999"
                            foreach ($d in $decisions) {
                                $certRecords += @{
                                    id                          = $d.id
                                    resourceId                  = $apId
                                    principalId                 = if ($d.principal) { $d.principal.id } else { $null }
                                    principalDisplayName        = if ($d.principal) { $d.principal.displayName } else { $null }
                                    decision                    = $d.decision
                                    recommendation              = $d.recommendation
                                    justification               = $d.justification
                                    reviewedBy                  = if ($d.reviewedBy) { $d.reviewedBy.id } else { $null }
                                    reviewedByDisplayName       = if ($d.reviewedBy) { $d.reviewedBy.displayName } else { $null }
                                    reviewedDateTime            = $d.reviewedDateTime
                                    reviewDefinitionId          = $def.id
                                    reviewInstanceId            = $inst.id
                                    reviewInstanceStatus        = $inst.status
                                    reviewInstanceStartDateTime = $inst.startDateTime
                                    reviewInstanceEndDateTime   = $inst.endDateTime
                                }
                            }
                        } catch {
                            Write-Host "    Skipping instance $($inst.id): $($_.Exception.Message)" -ForegroundColor Yellow
                        }
                    }
                } catch {
                    Write-Host "  Skipping review definition $($def.id): $($_.Exception.Message)" -ForegroundColor Yellow
                }
            }
            if ($certRecords.Count -gt 0) {
                Send-IngestBatch -Endpoint 'ingest/governance/certifications' -SystemId $systemId -SyncMode 'full' -Records $certRecords
            } else {
                Write-Host "  No access review decisions found" -ForegroundColor Yellow
            }
        }
        catch {
            Write-Host "  Access review sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "  This tenant may not use access reviews on access packages." -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "  Governance sync skipped: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  This tenant may not have Entitlement Management (Access Packages) enabled." -ForegroundColor Yellow
    }
}

# ─── Refresh Views ───────────────────────────────────────────────
if ($RefreshViews) {
    Update-CrawlerProgress -Step 'Refreshing materialized views' -Pct 76 -Detail 'Rebuilding SQL views...'
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Refreshing materialized views..." -ForegroundColor Cyan
    try {
        Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{}
        Write-Host "  Views refreshed" -ForegroundColor Green
    }
    catch {
        Write-Host "  View refresh failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ─── Summary ─────────────────────────────────────────────────────
$elapsed = (Get-Date) - $syncStart
Write-Host "`n=== Sync Complete ===" -ForegroundColor Green
Write-Host "Duration: $([Math]::Round($elapsed.TotalSeconds)) seconds" -ForegroundColor Gray

# Write a single sync log entry covering the full crawler runtime so the
# Sync Log page reflects the actual end-to-end duration (not just the per-batch
# bulk insert timings written by individual ingest endpoints).
try {
    Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{
        syncType    = 'EntraID-FullCrawl'
        tableName   = $null
        startTime   = $syncStart.ToString('o')
        endTime     = (Get-Date).ToString('o')
        recordCount = 0
        status      = 'Success'
    } | Out-Null
} catch {
    Write-Host "  (sync log write failed: $($_.Exception.Message))" -ForegroundColor DarkGray
}
