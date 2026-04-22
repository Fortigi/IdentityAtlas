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

.PARAMETER SyncOAuth2Grants
    Sync OAuth2 delegated permission grants — per-user consents (a user
    authorized app X to call API Y with scope Z on their behalf). Tenant-wide
    (AllPrincipals) grants are skipped because they don't represent a
    user-specific authorization decision. Default: false.

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
    [switch]$SyncSignInLogs = $false,
    [switch]$SyncOAuth2Grants = $false,
    [switch]$RefreshViews = $true,

    # Window for the sign-in logs fetch. Graph retains events for ~30 days so
    # the value is capped there. Default 7 is a good steady-state (daily
    # crawls comfortably overlap); bump to 30 on the first-ever run.
    [ValidateRange(1, 30)]
    [int]$SignInLogsDays = 7,

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
    [int]$JobId = 0,

    # 'full'  — ignore any stored delta tokens and re-fetch everything; the
    #           scoped-delete path removes rows that disappeared upstream.
    # 'delta' — use `/delta` endpoints where available (users, service
    #           principals) with stored deltatoken; first-ever run still
    #           falls back to full because there's no token yet.
    # The worker dispatcher reads `nextRunMode` from the CrawlerConfigs row
    # and forwards it here; after a successful full run the dispatcher
    # resets nextRunMode=delta so subsequent runs stay on the fast path
    # until the operator toggles "Force full sync next run" in the UI.
    [ValidateSet('full', 'delta')]
    [string]$SyncMode = 'delta'
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
        # Optional: a list of ids to DELETE at the target, alongside the
        # upserts in $Records. The ingest API applies `records` first, then
        # deletes any row matching `id IN (...)`. Used by delta flows where
        # Graph `@removed` events give us tombstones that aren't deletable
        # through the upsert path.
        [string[]]$DeletedIds = @(),
        # 5000 strikes a balance between MERGE round-trip overhead and lock
        # duration. With RCSI enabled on the database, readers don't block on
        # writers, but smaller batches still make the crawler give back the
        # CPU more often and reduce tempdb version-store pressure.
        [int]$BatchSize = 5000
    )

    $haveRecords = $Records -and $Records.Count -gt 0
    $haveDeletes = $DeletedIds -and $DeletedIds.Count -gt 0
    if (-not $haveRecords -and -not $haveDeletes) {
        Write-Host "  No records to send" -ForegroundColor Yellow
        return @{ inserted = 0; updated = 0; deleted = 0 }
    }

    if ($haveRecords) {
        Write-Host "  Sending $($Records.Count) records to $Endpoint..." -NoNewline -ForegroundColor Cyan
    } else {
        Write-Host "  Sending $($DeletedIds.Count) deletes to $Endpoint..." -NoNewline -ForegroundColor Cyan
    }
    if ($haveRecords -and $haveDeletes) {
        Write-Host " (+$($DeletedIds.Count) deletes)" -ForegroundColor Cyan
    } else {
        Write-Host '' -ForegroundColor Cyan
    }

    if (-not $haveRecords -or $Records.Count -le $BatchSize) {
        # Single batch (includes the deletes-only case where $Records may be empty)
        $body = @{
            systemId = $SystemId
            syncMode = $SyncMode
            scope    = $Scope
            records  = if ($haveRecords) { $Records } else { @() }
        }
        if ($haveDeletes) { $body['deletedIds'] = $DeletedIds }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        Write-Host "  Result: $($result.inserted) inserted, $($result.updated) updated, $($result.deleted) deleted" -ForegroundColor Green
        return $result
    }

    # Chunked session (records exceed BatchSize)
    # If $DeletedIds is also set, send them as a SEPARATE ingest call first
    # — chunked sessions have start/continue/end semantics that don't mesh
    # with in-band deletes, and the delete API call is small and fast.
    $totalDeleted = 0
    if ($haveDeletes) {
        $delBody = @{
            systemId   = $SystemId
            syncMode   = $SyncMode
            scope      = $Scope
            records    = @()
            deletedIds = $DeletedIds
        }
        $delRes = Invoke-IngestAPI -Endpoint $Endpoint -Body $delBody
        $totalDeleted = ($delRes.deleted ?? 0)
    }

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

    $deleted = ($result.deleted ?? 0) + $totalDeleted
    Write-Host "  Total: $totalInserted inserted, $totalUpdated updated, $deleted deleted" -ForegroundColor Green
    return @{ inserted = $totalInserted; updated = $totalUpdated; deleted = $deleted }
}

# ─── Delta-token helpers ─────────────────────────────────────────
# Graph's /users/delta, /servicePrincipals/delta etc. return an
# `@odata.deltaLink` on the last page containing a `$deltatoken=...` query
# param. We persist just the token string per (systemId, endpoint) via the
# API; next run passes it back as `?$deltatoken=<token>` to get only what
# changed. If Graph rejects the token (typically HTTP 400 with code
# "SyncStateNotFound" or 410), the caller DELETEs the row and falls back
# to a full fetch — next run will save a fresh token.
function Get-FGDeltaToken {
    param([int]$SystemId, [string]$Endpoint)
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey" }
        $uri = "$ApiBaseUrl/crawlers/delta-tokens/$([uri]::EscapeDataString($Endpoint))?systemId=$SystemId"
        $r = Invoke-RestMethod -Uri $uri -Method Get -Headers $headers -TimeoutSec 10
        if ($r.token) { return $r.token }
    } catch {
        # Token not found is the common case on a first run. 500s are logged
        # but we fall through to "no token" which is safe (full fetch).
        Write-Host "  (delta token lookup for $Endpoint returned no token)" -ForegroundColor DarkGray
    }
    return $null
}

function Set-FGDeltaToken {
    param([int]$SystemId, [string]$Endpoint, [string]$Token, [int]$RecordsLastSeen = 0)
    if (-not $Token) { return }
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $uri = "$ApiBaseUrl/crawlers/delta-tokens/$([uri]::EscapeDataString($Endpoint))"
        $body = @{ systemId = $SystemId; token = $Token; recordsLastSeen = $RecordsLastSeen } | ConvertTo-Json
        Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -Body $body -TimeoutSec 10 | Out-Null
    } catch {
        Write-Host "  (delta token save failed for ${Endpoint}: $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}

function Remove-FGDeltaToken {
    param([int]$SystemId, [string]$Endpoint)
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey" }
        $uri = "$ApiBaseUrl/crawlers/delta-tokens/$([uri]::EscapeDataString($Endpoint))?systemId=$SystemId"
        Invoke-RestMethod -Uri $uri -Method Delete -Headers $headers -TimeoutSec 10 | Out-Null
    } catch { }
}

# Extract the deltatoken query-string value from a full Graph deltaLink URL.
# The token may contain URL-escaped characters and we want to persist the
# decoded value so we can re-embed it in URIs freely.
function Get-FGDeltaTokenFromLink {
    param([string]$DeltaLink)
    if (-not $DeltaLink) { return $null }
    if ($DeltaLink -match '[?&]\$deltatoken=([^&]+)') {
        return [uri]::UnescapeDataString($matches[1])
    }
    return $null
}

# Delta-aware fetch: follows @odata.nextLink until exhausted, then returns
# both the accumulated records AND the @odata.deltaLink from the terminal
# page. Existing Invoke-FGGetRequest discards deltaLink — writing a
# dedicated helper avoids mutating that contract.
#
# Returns: @{ value=@(...); deltaLink=<string>; deltaToken=<string or $null> }
function Invoke-FGGetDeltaRequest {
    param(
        [Parameter(Mandatory)] [string]$URI,
        [int]$MaxRetries = 4,
        [int]$TimeoutSec = 0
    )

    if (-not $Global:AccessToken) {
        Throw "No Access Token found."
    }
    Update-FGAccessTokenIfExpired -DebugFlag 'G'
    $AccessToken = $Global:AccessToken

    $retryDelays = @(3, 10, 30, 60, 120, 180)
    $collected = [System.Collections.Generic.List[object]]::new()
    $nextUri = $URI
    $deltaLink = $null
    $pageCount = 0

    while ($nextUri) {
        $pageCount++
        $retryCount = 0
        $success = $false
        $Result = $null

        while (-not $success -and $retryCount -le $MaxRetries) {
            try {
                $rmParams = @{
                    Method  = 'Get'
                    Uri     = $nextUri
                    Headers = @{ 'Authorization' = "Bearer $AccessToken" }
                }
                if ($TimeoutSec -gt 0) { $rmParams['TimeoutSec'] = $TimeoutSec }
                $Result = Invoke-RestMethod @rmParams
                $success = $true
            }
            catch {
                $statusCode = $null
                if ($_.Exception.Response) {
                    $statusCode = [int]$_.Exception.Response.StatusCode
                }
                $isTransient = $statusCode -in @(429, 500, 502, 503, 504) -or
                               $_.Exception.Message -match 'UnknownError|ServiceNotAvailable|GatewayTimeout'
                if ($isTransient -and $retryCount -lt $MaxRetries) {
                    $retryCount++
                    $waitTime = $retryDelays[$retryCount - 1]
                    Write-Warning "[Invoke-FGGetDeltaRequest] Page ${pageCount}: Transient error (Status: $statusCode). Retry $retryCount/$MaxRetries after ${waitTime}s..."
                    Start-Sleep -Seconds $waitTime
                    Update-FGAccessTokenIfExpired -DebugFlag 'G'
                    $AccessToken = $Global:AccessToken
                } else {
                    # 400/410 on a stored token is how Graph signals "token no
                    # longer usable". Surface as a typed exception so the
                    # caller can detect it and fall back to full fetch.
                    if ($statusCode -in @(400, 410)) {
                        throw [System.InvalidOperationException]::new("Delta token rejected by Graph (HTTP $statusCode): $($_.Exception.Message)")
                    }
                    throw $_
                }
            }
        }

        if ($Result.value) {
            foreach ($v in $Result.value) { $collected.Add($v) }
        }
        $nextUri = $Result.'@odata.nextLink'
        if (-not $nextUri) {
            $deltaLink = $Result.'@odata.deltaLink'
        }
    }

    $token = Get-FGDeltaTokenFromLink -DeltaLink $deltaLink
    return @{
        value      = $collected
        deltaLink  = $deltaLink
        deltaToken = $token
    }
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

function Write-Phase {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [TimeSpan]$Duration,
        [string]$ErrorMsg = $null,
        [hashtable]$Records = $null
    )
    $phase = @{
        name       = $Name
        status     = if ($ErrorMsg) { 'failed' } else { 'ok' }
        durationMs = [int]$Duration.TotalMilliseconds
    }
    if ($ErrorMsg) { $phase.error = $ErrorMsg }
    if ($Records)  { $phase.records = $Records }
    $script:phases.Add($phase)
}

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

# Per-phase timings. Each major `if ($Sync...)` block stops a Stopwatch at
# its end and records the elapsed time here. Printed as a table at the end
# so operators can see where the crawl actually spent its time without
# needing to instrument downstream logs. Ordered so the Summary prints in
# execution order.
$phaseTimings = [ordered]@{}

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
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
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
        'createdDateTime','userType','signInActivity','externalUserState',
        # Needed so Add-FGEntraCalculatedAttributes can derive the _OuPath
        # calculated field for on-prem-synced users. Cheap to fetch (single
        # string), high value for reporting. Cloud-native users just leave
        # it null and no _OuPath is emitted.
        'onPremisesDistinguishedName'
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

    # ── Delta vs full fetch decision ─────────────────────────────
    # `/users/delta` doesn't support $expand=manager (Graph limitation), so
    # delta runs lose manager refresh. The recommended pattern is: full-mode
    # runs still use /users?$expand=manager (authoritative managerId), AND
    # prime a delta token by making a second "skipToken=latest" call at the
    # end so the next delta run starts from the current state. Delta-mode
    # runs use /users/delta?$deltatoken=<token> for changes only. If the
    # token is rejected (400/410), we clear it and fall back to a full pass
    # — the operator sees the slower run in the Details drawer.
    $usersEndpoint  = 'users/delta'
    $usersToken     = $null
    $newUsersToken  = $null
    $deltaHit       = $false
    $removedUserIds = @()

    if ($SyncMode -eq 'full') {
        # Explicit full: wipe any stored token so stale context can't survive.
        Remove-FGDeltaToken -SystemId $systemId -Endpoint $usersEndpoint
    } elseif ($SyncMode -eq 'delta') {
        $usersToken = Get-FGDeltaToken -SystemId $systemId -Endpoint $usersEndpoint
    }

    if ($usersToken) {
        Write-Host "  Delta mode: fetching only changes since last run..." -ForegroundColor Gray
        try {
            $deltaUri = "https://graph.microsoft.com/beta/users/delta?`$deltatoken=$([uri]::EscapeDataString($usersToken))"
            $resp = Invoke-FGGetDeltaRequest -URI $deltaUri
            $users = @($resp.value | Where-Object { -not $_.'@removed' })
            $removedUserIds = @($resp.value | Where-Object { $_.'@removed' } | ForEach-Object { $_.id })
            $newUsersToken = $resp.deltaToken
            $deltaHit = $true
            Write-Host "  Delta: $($users.Count) changed + $($removedUserIds.Count) removed" -ForegroundColor Gray
        } catch [System.InvalidOperationException] {
            Write-Host "  Delta token rejected by Graph — clearing and falling back to full fetch" -ForegroundColor Yellow
            Remove-FGDeltaToken -SystemId $systemId -Endpoint $usersEndpoint
            $usersToken = $null
            $users = $null
        } catch {
            Write-Host "  Delta fetch failed: $($_.Exception.Message) — falling back to full" -ForegroundColor Yellow
            $usersToken = $null
            $users = $null
        }
    }

    if (-not $deltaHit) {
        # Full path: authoritative fetch with manager expand. Then prime a
        # delta token with a real /users/delta call — Graph only hands the
        # token out after you've walked the entire collection, so we pay
        # the full pagination cost here (~500KB × N pages). $select=id keeps
        # the payload minimal. This is a one-time cost on forced-full runs
        # (hourly runs after that use delta).
        $users = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/users?`$select=$userSelect&`$expand=manager(`$select=id)&`$top=999"
        try {
            Write-Host "  Priming delta token (walks full /users/delta once)..." -ForegroundColor DarkGray
            $primeResp = Invoke-FGGetDeltaRequest -URI "https://graph.microsoft.com/beta/users/delta?`$select=id"
            $newUsersToken = $primeResp.deltaToken
            if ($newUsersToken) {
                Write-Host "  Primed delta token for next run" -ForegroundColor DarkGray
            } else {
                Write-Host "  (priming call succeeded but no deltaLink returned — Graph may have paginated further)" -ForegroundColor DarkGray
            }
        } catch {
            Write-Host "  (delta token priming skipped: $($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }

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

        # Build extendedAttributes: userType, externalUserState, custom attrs.
        # `signInActivity` DELIBERATELY does NOT live here anymore — it used
        # to, but the four timestamps change on every crawl and a jsonb
        # rewrite triggers a _history row per user per day. Activity data
        # now goes to the purpose-built PrincipalActivity table, which is
        # not audited. See migrations/017_principal_activity.sql.
        $ext = @{}
        if ($_.userType)          { $ext['userType']          = $_.userType }
        if ($_.externalUserState) { $ext['externalUserState'] = $_.externalUserState }
        if ($CustomUserAttributes.Count -gt 0) {
            foreach ($attr in $CustomUserAttributes) {
                $val = Get-UserAttrValue -User $_ -AttrName $attr
                if ($null -ne $val -and $val -ne '') { $ext[$attr] = $val }
            }
        }
        # Identity-Atlas-calculated fields: portal Link and *_OuPath derived
        # from any DN-shaped value in the record. Runs last so it sees both
        # the core attributes above and every CustomUserAttribute.
        Add-FGEntraCalculatedAttributes -Object $_ -Ext $ext -Type 'User' | Out-Null
        if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }
        $rec
    })

    Update-CrawlerProgress -Detail "Uploading $($records.Count) users to ingest API..."
    # In a delta-hit run we also forward @removed tombstone ids, and we use
    # syncMode='delta' so the ingest engine DOESN'T scoped-delete any user
    # we didn't touch (we only saw the changed subset).
    $ingestMode = if ($deltaHit) { 'delta' } else { 'full' }
    Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode $ingestMode `
        -Scope @{ principalType = 'User' } -Records $records -DeletedIds $removedUserIds

    # Save the fresh delta token (if we got one). Next run will pick it up.
    if ($newUsersToken) {
        Set-FGDeltaToken -SystemId $systemId -Endpoint $usersEndpoint -Token $newUsersToken -RecordsLastSeen $records.Count
    }

    # ─── Upload user sign-in activity (aggregate per-principal) ──
    # The four signInActivity timestamps come back on the same /users call,
    # but they live in the dedicated PrincipalActivity table now — sending
    # them to /ingest/principal-activity with resourceId set to the
    # AGG_RESOURCE_ID sentinel (the DEFAULT on the column) produces one
    # aggregate row per user.
    $aggResourceId = '00000000-0000-0000-0000-000000000000'
    $activityRecords = @($users | ForEach-Object {
        $sia = $_.signInActivity
        if ($null -eq $sia) { return }
        $rec = @{
            principalId   = $_.id
            resourceId    = $aggResourceId
            activityType  = 'SignIn'
        }
        if ($sia.lastSignInDateTime)                { $rec['lastSignInDateTime']                = $sia.lastSignInDateTime }
        if ($sia.lastNonInteractiveSignInDateTime)  { $rec['lastNonInteractiveSignInDateTime']  = $sia.lastNonInteractiveSignInDateTime }
        if ($sia.lastSuccessfulSignInDateTime)      { $rec['lastSuccessfulSignInDateTime']      = $sia.lastSuccessfulSignInDateTime }
        # Only emit a record if we have at least one timestamp — users who
        # have never signed in would otherwise produce a row with just the
        # key columns and no meaningful payload.
        if ($rec.Count -gt 3) { $rec }
    })
    if ($activityRecords.Count -gt 0) {
        Update-CrawlerProgress -Detail "Uploading $($activityRecords.Count) user sign-in activity records..."
        Send-IngestBatch -Endpoint 'ingest/principal-activity' -SystemId $systemId -SyncMode 'delta' `
            -Records $activityRecords
    }

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

            # In delta mode we only have changed users, so full-mode
            # scoped-delete would wipe unchanged identities. Use the same
            # $ingestMode as Principals — delta runs upsert only, full runs
            # reconcile deletes. Weekly full run cleans up filter drop-offs.
            Send-IngestBatch -Endpoint 'ingest/identities' -SystemId $systemId -SyncMode $ingestMode -Records $idRecords

            # Link identities to principals
            $idMembers = @($identityUsers | ForEach-Object {
                @{
                    identityId  = $_.id
                    principalId = $_.id
                }
            })
            Send-IngestBatch -Endpoint 'ingest/identity-members' -SystemId $systemId -SyncMode $ingestMode -Records $idMembers
        }
    }
    $__phaseSW.Stop(); $phaseTimings['Principals'] = $__phaseSW.Elapsed
    Write-Phase -Name 'Principals' -Duration $__phaseSW.Elapsed
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
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
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

    # ── Delta vs full (same pattern as Users) ────────────────────
    $spsEndpoint   = 'servicePrincipals/delta'
    $spsToken      = $null
    $newSpsToken   = $null
    $spDeltaHit    = $false
    $removedSpIds  = @()

    if ($SyncMode -eq 'full') {
        Remove-FGDeltaToken -SystemId $systemId -Endpoint $spsEndpoint
    } elseif ($SyncMode -eq 'delta') {
        $spsToken = Get-FGDeltaToken -SystemId $systemId -Endpoint $spsEndpoint
    }

    if ($spsToken) {
        Write-Host "  Delta mode: fetching only changed SPs..." -ForegroundColor Gray
        try {
            $deltaUri = "https://graph.microsoft.com/beta/servicePrincipals/delta?`$deltatoken=$([uri]::EscapeDataString($spsToken))"
            $resp = Invoke-FGGetDeltaRequest -URI $deltaUri
            $sps = @($resp.value | Where-Object { -not $_.'@removed' })
            $removedSpIds = @($resp.value | Where-Object { $_.'@removed' } | ForEach-Object { $_.id })
            $newSpsToken = $resp.deltaToken
            $spDeltaHit = $true
            Write-Host "  Delta: $($sps.Count) changed + $($removedSpIds.Count) removed" -ForegroundColor Gray
        } catch [System.InvalidOperationException] {
            Write-Host "  SP delta token rejected — falling back to full" -ForegroundColor Yellow
            Remove-FGDeltaToken -SystemId $systemId -Endpoint $spsEndpoint
            $spsToken = $null
            $sps = $null
        } catch {
            Write-Host "  SP delta fetch failed: $($_.Exception.Message) — falling back to full" -ForegroundColor Yellow
            $spsToken = $null
            $sps = $null
        }
    }

    if (-not $spDeltaHit) {
        $sps = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals?`$select=$spSelect&`$top=999"
        try {
            Write-Host "  Priming SP delta token (walks full /servicePrincipals/delta once)..." -ForegroundColor DarkGray
            $primeResp = Invoke-FGGetDeltaRequest -URI "https://graph.microsoft.com/beta/servicePrincipals/delta?`$select=id"
            $newSpsToken = $primeResp.deltaToken
            if ($newSpsToken) { Write-Host "  Primed SP delta token for next run" -ForegroundColor DarkGray }
        } catch {
            Write-Host "  (SP delta token priming skipped: $($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }

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
        # Portal Link + any *_OuPath fields from DN-shaped extension attrs.
        Add-FGEntraCalculatedAttributes -Object $sp -Ext $ext -Type 'ServicePrincipal' | Out-Null
        if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }

        [void]$buckets[$pt].Add($rec)
    }

    Write-Host ("  Classified: {0} ServicePrincipal / {1} ManagedIdentity / {2} AIAgent" -f `
        $buckets.ServicePrincipal.Count, $buckets.ManagedIdentity.Count, $buckets.AIAgent.Count) -ForegroundColor Gray

    # In delta mode, use syncMode='delta' (no scoped delete of unchanged
    # records) and attach the @removed tombstones to the FIRST bucket's
    # call — the /ingest/principals delete is id-scoped and doesn't care
    # which principalType bucket the record originally lived in, so it
    # only needs to run once per phase.
    $spIngestMode = if ($spDeltaHit) { 'delta' } else { 'full' }
    $firstBucket = $true
    foreach ($pt in @('ServicePrincipal','ManagedIdentity','AIAgent')) {
        $bucket = $buckets[$pt]
        if ($bucket.Count -eq 0 -and (-not $firstBucket -or $removedSpIds.Count -eq 0)) { continue }
        Update-CrawlerProgress -Detail "Uploading $($bucket.Count) $pt records..."
        $deletes = @()
        if ($firstBucket -and $spDeltaHit -and $removedSpIds.Count -gt 0) {
            $deletes = $removedSpIds
            $firstBucket = $false
        } elseif ($firstBucket) {
            $firstBucket = $false
        }
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $systemId -SyncMode $spIngestMode `
            -Scope @{ principalType = $pt } -Records @($bucket) -DeletedIds $deletes
    }

    if ($newSpsToken) {
        Set-FGDeltaToken -SystemId $systemId -Endpoint $spsEndpoint -Token $newSpsToken -RecordsLastSeen $sps.Count
    }

    # ─── SP sign-in activity (aggregate per SP) ──────────────────
    # Graph has a dedicated report endpoint that returns per-appId
    # last-activity timestamps. We join it by appId to the SPs we just
    # synced so the PrincipalActivity row is keyed on the SP's object id
    # (the same id used as principalId in ResourceAssignments — not appId).
    try {
        Update-CrawlerProgress -Step 'Fetching SP sign-in activity report' -Pct 20 -Detail '/reports/servicePrincipalSignInActivities'
        $spActivityRows = Invoke-FGGetRequest -URI 'https://graph.microsoft.com/beta/reports/servicePrincipalSignInActivities?$top=999'

        # Build appId → activity map. Graph returns one row per appId with
        # four timestamp "flavours"; we promote the primary last/nonInteractive
        # to first-class columns and stash the two client-variant timestamps
        # in extendedAttributes so downstream queries can still reach them.
        $activityByAppId = @{}
        foreach ($a in $spActivityRows) {
            if (-not $a.appId) { continue }
            $activityByAppId[$a.appId] = $a
        }

        $spActivityRecords = @($sps | ForEach-Object {
            $a = $activityByAppId[$_.appId]
            if (-not $a) { return }
            $rec = @{
                principalId  = $_.id
                resourceId   = $aggResourceId
                activityType = 'ServicePrincipalSignIn'
            }
            if ($a.lastSignInActivity.lastSignInDateTime) {
                $rec['lastSignInDateTime'] = $a.lastSignInActivity.lastSignInDateTime
            }
            if ($a.lastNonInteractiveSignInActivity.lastSignInDateTime) {
                $rec['lastNonInteractiveSignInDateTime'] = $a.lastNonInteractiveSignInActivity.lastSignInDateTime
            }
            # applicationAuthenticationClientSignInActivity + delegatedClientSignInActivity
            # aren't first-class columns — they're SP-specific signals so we keep
            # them in extendedAttributes for risk scoring and detail-page display.
            $ext = @{}
            if ($a.applicationAuthenticationClientSignInActivity.lastSignInDateTime) {
                $ext['lastApplicationAuthSignInDateTime'] = $a.applicationAuthenticationClientSignInActivity.lastSignInDateTime
            }
            if ($a.delegatedClientSignInActivity.lastSignInDateTime) {
                $ext['lastDelegatedClientSignInDateTime'] = $a.delegatedClientSignInActivity.lastSignInDateTime
            }
            if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }
            if ($rec.Count -gt 3) { $rec }
        })

        if ($spActivityRecords.Count -gt 0) {
            Update-CrawlerProgress -Detail "Uploading $($spActivityRecords.Count) SP sign-in activity records..."
            Send-IngestBatch -Endpoint 'ingest/principal-activity' -SystemId $systemId -SyncMode 'delta' `
                -Records $spActivityRecords
        } else {
            Write-Host '  No SP sign-in activity to upload (report empty or no matches)' -ForegroundColor Gray
        }
    } catch {
        # The report endpoint needs AuditLog.Read.All, which should already
        # be granted, but tenants that haven't consented yet will 403 here.
        # Fail soft — SP data itself still lands, activity just stays stale.
        Write-Host "  WARN: SP sign-in activity sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); $phaseTimings['ServicePrincipals'] = $__phaseSW.Elapsed
    Write-Phase -Name 'ServicePrincipals' -Duration $__phaseSW.Elapsed
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
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing sign-in logs (last $SignInLogsDays days)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing sign-in logs' -Pct 22 -Detail 'Building appId index...'

    try {
        # Build appId → sp.id map. Use the $sps array from the SP sync block
        # if present; otherwise fetch a stripped-down list on-demand. Either
        # way it's a single pass of Graph service principals.
        $appIdToSpId = @{}
        if ($sps -and $sps.Count -gt 0) {
            foreach ($sp in $sps) { if ($sp.appId) { $appIdToSpId[$sp.appId] = $sp.id } }
        } else {
            $spIndex = Invoke-FGGetRequest -URI 'https://graph.microsoft.com/beta/servicePrincipals?$select=id,appId&$top=999'
            foreach ($sp in $spIndex) { if ($sp.appId) { $appIdToSpId[$sp.appId] = $sp.id } }
        }
        Write-Host "  Indexed $($appIdToSpId.Count) app ids" -ForegroundColor Gray

        # Day-sliced fetch. Fetching the full 7-day window as a single request
        # has repeatedly failed mid-pagination with a 400 once Graph's
        # skiptoken expires on a slow client. Slicing into 1-day windows means
        # a single bad slice costs one day, not the whole phase. The downside
        # is N round trips' worth of fixed overhead; in practice each slice
        # pages through 20–30k events, so the overhead is negligible.
        $agg = @{}
        $skipped = 0
        $sliceFailures = @()
        $events = [System.Collections.Generic.List[object]]::new()

        $nowUtc = (Get-Date).ToUniversalTime()
        for ($d = 0; $d -lt $SignInLogsDays; $d++) {
            $sliceEnd   = $nowUtc.AddDays(-$d).ToString('yyyy-MM-ddTHH:mm:ssZ')
            $sliceStart = $nowUtc.AddDays(-($d + 1)).ToString('yyyy-MM-ddTHH:mm:ssZ')
            $sliceFilter = [uri]::EscapeDataString("createdDateTime ge $sliceStart and createdDateTime lt $sliceEnd")
            $sliceUri = "https://graph.microsoft.com/beta/auditLogs/signIns?`$filter=$sliceFilter&`$top=999"
            Update-CrawlerProgress -Detail "Fetching day slice $($d + 1)/${SignInLogsDays}: $sliceStart..$sliceEnd"
            try {
                $sliceEvents = Invoke-FGGetRequest -URI $sliceUri
                if ($sliceEvents) {
                    foreach ($ev in $sliceEvents) { $events.Add($ev) }
                }
                Write-Host "  Slice $($d + 1)/$SignInLogsDays ($sliceStart..$sliceEnd): $(@($sliceEvents).Count) events" -ForegroundColor Gray
            } catch {
                # One bad slice (typically an expired skiptoken 400 deep in
                # pagination) doesn't abort the whole phase — we record it
                # and keep going. If *every* slice fails, the outer handler
                # still flags the phase as failed.
                $msg = $_.Exception.Message
                Write-Host "  Slice $($d + 1)/$SignInLogsDays failed: $msg" -ForegroundColor Yellow
                $sliceFailures += "day $($d + 1): $msg"
            }
        }
        Write-Host "  Pulled $($events.Count) events across $SignInLogsDays slices ($(@($sliceFailures).Count) slice failure(s))" -ForegroundColor Gray
        if ($sliceFailures.Count -gt 0 -and $sliceFailures.Count -eq $SignInLogsDays) {
            throw "All $SignInLogsDays sign-in log slices failed: $($sliceFailures -join '; ')"
        }
        if ($sliceFailures.Count -gt 0) {
            $script:phaseErrors.Add("SignInLogs: $($sliceFailures.Count) of $SignInLogsDays day slice(s) failed: $($sliceFailures -join '; ')")
        }

        # Aggregate. Events older than an existing aggregate are skipped;
        # newer ones win via max(date). Success/failure split comes from
        # status.errorCode — 0 is a successful sign-in.
        foreach ($ev in $events) {
            if (-not $ev.userId -or -not $ev.appId) { $skipped++; continue }
            $spId = $appIdToSpId[$ev.appId]
            if (-not $spId) { $skipped++; continue }
            $key = "$($ev.userId)|$spId"
            $entry = $agg[$key]
            if (-not $entry) {
                $entry = @{
                    principalId  = $ev.userId
                    resourceId   = $spId
                    activityType = 'SignInPerApp'
                    lastSignInDateTime = $ev.createdDateTime
                    lastSuccessfulSignInDateTime = $null
                    lastFailedSignInDateTime = $null
                    signInCount = 0
                }
                $agg[$key] = $entry
            }
            if ($ev.createdDateTime -gt $entry.lastSignInDateTime) {
                $entry.lastSignInDateTime = $ev.createdDateTime
            }
            $entry.signInCount++
            $errorCode = $ev.status.errorCode
            if ($null -ne $errorCode -and [int]$errorCode -eq 0) {
                if (-not $entry.lastSuccessfulSignInDateTime -or $ev.createdDateTime -gt $entry.lastSuccessfulSignInDateTime) {
                    $entry.lastSuccessfulSignInDateTime = $ev.createdDateTime
                }
            } else {
                if (-not $entry.lastFailedSignInDateTime -or $ev.createdDateTime -gt $entry.lastFailedSignInDateTime) {
                    $entry.lastFailedSignInDateTime = $ev.createdDateTime
                }
            }
        }

        if ($skipped -gt 0) {
            Write-Host "  Skipped $skipped events (missing userId/appId, or app not synced yet)" -ForegroundColor Gray
        }

        $records = @($agg.Values)
        Write-Host "  Aggregated to $($records.Count) (user, app) pairs" -ForegroundColor Cyan
        if ($records.Count -gt 0) {
            Update-CrawlerProgress -Detail "Uploading $($records.Count) per-app activity rows..."
            Send-IngestBatch -Endpoint 'ingest/principal-activity' -SystemId $systemId -SyncMode 'delta' `
                -Records $records
        }
    } catch {
        # 403 if the tenant hasn't consented AuditLog.Read.All, 429 if the
        # report is rate-limited. Fail soft — user/SP aggregate activity
        # from the cheaper endpoints still landed.
        Write-Host "  ERROR: Sign-in log sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("SignInLogs: $($_.Exception.Message)")
    }
    $__phaseSW.Stop(); $phaseTimings['SignInLogs'] = $__phaseSW.Elapsed
    $__signInErr = $script:phaseErrors | Where-Object { $_.StartsWith('SignInLogs:') } | Select-Object -Last 1
    $__signInErrMsg = if ($__signInErr) { $__signInErr.Substring('SignInLogs:'.Length).Trim() } else { $null }
    Write-Phase -Name 'SignInLogs' -Duration $__phaseSW.Elapsed -ErrorMsg $__signInErrMsg
}

# ─── Sync Resources (Groups) ─────────────────────────────────────
if ($SyncResources) {
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
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
        # Portal Link + *_OuPath for any DN-shaped custom attr (fgGroupDN,
        # onPremisesDistinguishedName via CustomGroupAttributes, etc.).
        Add-FGEntraCalculatedAttributes -Object $_ -Ext $ext -Type 'Group' | Out-Null
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
    $__phaseSW.Stop(); $phaseTimings['Resources'] = $__phaseSW.Elapsed
    Write-Phase -Name 'Resources' -Duration $__phaseSW.Elapsed
}

# ─── Sync Assignments (Group Members) ────────────────────────────
if ($SyncAssignments) {
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
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
    $__phaseSW.Stop(); $phaseTimings['Assignments'] = $__phaseSW.Elapsed
    Write-Phase -Name 'Assignments' -Duration $__phaseSW.Elapsed
}

# ─── Sync PIM (Eligible group memberships) ───────────────────────
# Privileged Identity Management gives users "Eligible" (not active) membership
# in groups. The Graph endpoint requires a `$filter=groupId eq '<id>'` — there
# is no supported "list all" variant (an earlier attempt to drop the filter
# returned 400). On a 9k-group tenant this phase is ~25 min; optimisation is
# a separate problem (Graph $batch or a different endpoint). For now we
# accept the duration in exchange for correctness.
if ($SyncPim) {
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing PIM eligible memberships..." -ForegroundColor Cyan
    try {
        # Filter out dynamic groups (cannot be PIM-enabled)
        $candidateGroups = $groups | Where-Object { $_.groupTypes -notcontains 'DynamicMembership' }
        $pimTotal = $candidateGroups.Count
        Write-Host "  Checking $pimTotal groups for PIM eligibility..." -ForegroundColor Gray
        Update-CrawlerProgress -Step 'Syncing PIM eligibilities' -Pct 61 -Detail "0 of $pimTotal groups"

        # Per-group eligibility check. Parallel runspaces (16 in flight) keep
        # this from being trivially serial. Most groups return zero rows (Graph
        # returns 4xx for some group types) — per-group errors are normal and
        # silently dropped.
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
        Write-Host "  PIM sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("PIM: $($_.Exception.Message)")
    }
    $__phaseSW.Stop(); $phaseTimings['PIM'] = $__phaseSW.Elapsed
    $__pimErr = $script:phaseErrors | Where-Object { $_.StartsWith('PIM:') } | Select-Object -Last 1
    $__pimErrMsg = if ($__pimErr) { $__pimErr.Substring('PIM:'.Length).Trim() } else { $null }
    Write-Phase -Name 'PIM' -Duration $__phaseSW.Elapsed -ErrorMsg $__pimErrMsg
}

# ─── Sync Governance ─────────────────────────────────────────────
if ($SyncGovernance) {
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
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
        $__scopeSW = [Diagnostics.Stopwatch]::StartNew()
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access package resource scopes)..." -ForegroundColor Cyan
        try {
            $relRecords = @()
            foreach ($ap in $accessPackages) {
                try {
                    # Tight retry/timeout budget — this fires once per AP (~500)
                    # and we already skip on failure; a slow/wedged AP must not
                    # stall the whole loop for minutes.
                    $apDetail = Invoke-FGGetRequest -MaxRetries 1 -TimeoutSec 30 -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages/$($ap.id)?`$expand=accessPackageResourceRoleScopes(`$expand=accessPackageResourceRole,accessPackageResourceScope)"
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
            Write-Host "  Resource scope sync failed: $($_.Exception.Message)" -ForegroundColor Red
            $script:phaseErrors.Add("Governance/ResourceScopes: $($_.Exception.Message)")
        }
        $__scopeSW.Stop()
        $__scopeErr = $script:phaseErrors | Where-Object { $_.StartsWith('Governance/ResourceScopes:') } | Select-Object -Last 1
        $__scopeErrMsg = if ($__scopeErr) { $__scopeErr.Substring('Governance/ResourceScopes:'.Length).Trim() } else { $null }
        Write-Phase -Name 'Governance/ResourceScopes' -Duration $__scopeSW.Elapsed -ErrorMsg $__scopeErrMsg

        # ── Access Package Assignments (Governed) ────────────────────
        # Each assignment links a user (target) to an access package
        $__apaSW = [Diagnostics.Stopwatch]::StartNew()
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (access package assignments)..." -ForegroundColor Cyan
        try {
            # $top=500 is a compromise — the upstream entitlement-management
            # service is visibly strained on this endpoint on large tenants
            # and 999 per page consistently produces 504 Gateway Timeout
            # after the first few pages. 500 halves the per-page work and
            # has empirically survived where 999 didn't.
            $assignments = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignments?`$expand=target,accessPackage&`$top=500"

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
            Write-Host "  Access Package assignments sync failed: $($_.Exception.Message)" -ForegroundColor Red
            $script:phaseErrors.Add("Governance/APAssignments: $($_.Exception.Message)")
        }
        $__apaSW.Stop()
        $__apaErr = $script:phaseErrors | Where-Object { $_.StartsWith('Governance/APAssignments:') } | Select-Object -Last 1
        $__apaErrMsg = if ($__apaErr) { $__apaErr.Substring('Governance/APAssignments:'.Length).Trim() } else { $null }
        Write-Phase -Name 'Governance/APAssignments' -Duration $__apaSW.Elapsed -ErrorMsg $__apaErrMsg

        # ── Access Package Assignment Policies ───────────────────────
        # Drives the "Type" column on the Business Roles page (Auto-assigned vs
        # Request-based) and the hasReviewConfigured flag. Without this the page
        # shows blank type/review badges even when policies exist in Graph.
        $__polSW = [Diagnostics.Stopwatch]::StartNew()
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (assignment policies)..." -ForegroundColor Cyan
        try {
            # This is the ONE governance endpoint we call via /v1.0, not
            # /beta. Microsoft removed the `assignmentPolicies` segment from
            # /beta some time before April 2026 (Graph responds with
            # "Resource not found for the segment 'assignmentPolicies'" —
            # HTTP 400); the /v1.0 surface still exposes it.
            # $top isn't supported on this endpoint (returns 400), and the
            # base /v1.0 response doesn't include accessPackageId, so we
            # expand the accessPackage relationship to recover it. The
            # fallback below (`$pol.accessPackage.id`) depends on this.
            $policies = Invoke-FGGetRequest -URI "https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentPolicies?`$expand=accessPackage"
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
            Write-Host "  Assignment policy sync failed: $($_.Exception.Message)" -ForegroundColor Red
            $script:phaseErrors.Add("Governance/AssignmentPolicies: $($_.Exception.Message)")
        }
        $__polSW.Stop()
        $__polErr = $script:phaseErrors | Where-Object { $_.StartsWith('Governance/AssignmentPolicies:') } | Select-Object -Last 1
        $__polErrMsg = if ($__polErr) { $__polErr.Substring('Governance/AssignmentPolicies:'.Length).Trim() } else { $null }
        Write-Phase -Name 'Governance/AssignmentPolicies' -Duration $__polSW.Elapsed -ErrorMsg $__polErrMsg

        # ── Access Reviews → CertificationDecisions ──────────────────
        # Drives the Last Review / Reviewer / Compliance columns on the Business
        # Roles page. Walks all access review definitions whose scope targets an
        # access package, then pulls instance decisions. Best-effort: tenant may
        # not use access reviews at all, in which case this is a no-op.
        $__arvSW = [Diagnostics.Stopwatch]::StartNew()
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
            Write-Host "  Access review sync failed: $($_.Exception.Message)" -ForegroundColor Red
            $script:phaseErrors.Add("Governance/AccessReviews: $($_.Exception.Message)")
            Write-Host "  This tenant may not use access reviews on access packages." -ForegroundColor Yellow
        }
        $__arvSW.Stop()
        $__arvErr = $script:phaseErrors | Where-Object { $_.StartsWith('Governance/AccessReviews:') } | Select-Object -Last 1
        $__arvErrMsg = if ($__arvErr) { $__arvErr.Substring('Governance/AccessReviews:'.Length).Trim() } else { $null }
        Write-Phase -Name 'Governance/AccessReviews' -Duration $__arvSW.Elapsed -ErrorMsg $__arvErrMsg
    }
    catch {
        Write-Host "  Governance sync skipped: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  This tenant may not have Entitlement Management (Access Packages) enabled." -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); $phaseTimings['Governance'] = $__phaseSW.Elapsed
    # Sub-phases already called Write-Phase individually. Don't double-add
    # a top-level 'Governance' entry — the UI breakdown shows them directly.
}

# ─── Sync OAuth2 Delegated Grants ────────────────────────────────
# Per-user consent grants: user authorized client-app X to call target-API Y on
# their behalf with scope Z. Modelled as a child-resource tree:
#
#     Resources(Application)           <-- client SP (the app that got delegated-to)
#       └─ ResourceRelationships(DelegatesScope)
#            └─ Resources(DelegatedPermission)   <-- synthetic per (client, api, scope)
#                 └─ ResourceAssignments(OAuth2Grant)  <-- one row per consenting user
#
# The scope resource ID is deterministic over (clientSpId, targetApiSpId, scope)
# so re-runs idempotently overwrite the same rows. Tenant-wide consents
# (consentType='AllPrincipals', principalId=null) are skipped — they don't
# represent a user-specific decision. A distinct relationshipType (
# 'DelegatesScope' not 'Contains') keeps the scoped full-sync delete from
# wiping out the Access Package 'Contains' relationships produced by the
# governance sync above.
if ($SyncOAuth2Grants) {
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing OAuth2 delegated grants..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing OAuth2 grants' -Pct 72 -Detail 'Fetching from Microsoft Graph...'

    # Deterministic UUID v3-style over MD5 — mirrors normalizeRecords in
    # app/api/src/ingest/normalization.js so the same input always yields the
    # same ID whether generated here or server-side.
    function New-OAuth2ScopeResourceId {
        param([string]$ClientSpId, [string]$TargetApiSpId, [string]$Scope)
        $input = "entraid-oauth2-scope:${ClientSpId}:${TargetApiSpId}:${Scope}"
        $md5 = [System.Security.Cryptography.MD5]::Create()
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($input)
            $hex = ([System.BitConverter]::ToString($md5.ComputeHash($bytes)) -replace '-','').ToLower()
        } finally {
            $md5.Dispose()
        }
        return "$($hex.Substring(0,8))-$($hex.Substring(8,4))-$($hex.Substring(12,4))-$($hex.Substring(16,4))-$($hex.Substring(20,12))"
    }

    try {
        $grants = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/oauth2PermissionGrants?`$top=999"
        $total = @($grants).Count
        Write-Host "  Fetched $total OAuth2 permission grants" -ForegroundColor Gray

        # Keep only per-user consents — AllPrincipals are tenant-wide admin
        # consents that we explicitly skip (they don't reflect an individual
        # user's authorization decision).
        $userGrants = @($grants | Where-Object { $_.consentType -eq 'Principal' -and $_.principalId })
        Write-Host "  $($userGrants.Count) per-user consents (skipping $($total - $userGrants.Count) tenant-wide)" -ForegroundColor Gray

        if ($userGrants.Count -eq 0) {
            Write-Host "  Nothing to ingest" -ForegroundColor Yellow
        }
        else {
            # Collect unique SP IDs referenced as either client or target API so
            # we can attach human-readable displayNames to the Resource rows.
            # We fetch each SP individually — Graph's `$filter id in (...)` on
            # servicePrincipals has a 15-item cap and a tight total URL length
            # limit; one-at-a-time is slower but robust across all tenant sizes.
            $spIds = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($g in $userGrants) {
                if ($g.clientId)   { [void]$spIds.Add($g.clientId) }
                if ($g.resourceId) { [void]$spIds.Add($g.resourceId) }
            }
            Update-CrawlerProgress -Detail "Resolving $($spIds.Count) service principals..."

            $spInfo = @{}
            foreach ($id in $spIds) {
                try {
                    $sp = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals/$id`?`$select=id,displayName,appId,publisherName"
                    if ($sp) {
                        $spInfo[$id] = @{
                            displayName    = $sp.displayName
                            appId          = $sp.appId
                            publisherName  = $sp.publisherName
                        }
                    }
                } catch {
                    # SP deleted / inaccessible — fall back to the raw id so
                    # the grant is still ingestible.
                    $spInfo[$id] = @{ displayName = $id; appId = $null; publisherName = $null }
                }
            }

            # ── Emit client-app Resources (one per distinct client SP) ────
            $clientIds = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($g in $userGrants) { [void]$clientIds.Add($g.clientId) }
            $clientRecords = @($clientIds | ForEach-Object {
                $info = $spInfo[$_]
                $rec = @{
                    id           = $_
                    displayName  = $info.displayName
                    resourceType = 'Application'
                    enabled      = $true
                }
                $ext = @{}
                if ($info.appId)         { $ext['appId']         = $info.appId }
                if ($info.publisherName) { $ext['publisherName'] = $info.publisherName }
                if ($ext.Count -gt 0)    { $rec['extendedAttributes'] = $ext }
                $rec
            })
            Update-CrawlerProgress -Detail "Uploading $($clientRecords.Count) client apps..."
            Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ resourceType = 'Application' } -Records $clientRecords

            # ── Build unique scope resources and relationships ────────────
            # One Resource per (clientSpId, targetApiSpId, scope). The scope
            # string is space-separated — split it so analysts can filter on
            # individual scopes like "Mail.Read".
            $scopeResourceMap = @{}   # scopeResId → record
            $relMap           = @{}   # "parent|child" → record
            $assignments      = [System.Collections.Generic.List[object]]::new()

            foreach ($g in $userGrants) {
                $clientId   = $g.clientId
                $targetId   = $g.resourceId
                $userId     = $g.principalId
                if (-not $clientId -or -not $targetId -or -not $userId) { continue }

                $clientInfo = $spInfo[$clientId]
                $targetInfo = $spInfo[$targetId]
                $clientName = if ($clientInfo) { $clientInfo.displayName } else { $clientId }
                $targetName = if ($targetInfo) { $targetInfo.displayName } else { $targetId }

                $scopeTokens = @()
                if ($g.scope) {
                    $scopeTokens = @($g.scope -split '\s+' | Where-Object { $_ -ne '' })
                }
                if ($scopeTokens.Count -eq 0) { continue }

                foreach ($scope in $scopeTokens) {
                    $scopeResId = New-OAuth2ScopeResourceId -ClientSpId $clientId -TargetApiSpId $targetId -Scope $scope
                    if (-not $scopeResourceMap.ContainsKey($scopeResId)) {
                        $scopeResourceMap[$scopeResId] = @{
                            id           = $scopeResId
                            displayName  = "$scope on $targetName"
                            resourceType = 'DelegatedPermission'
                            enabled      = $true
                            extendedAttributes = @{
                                clientSpId           = $clientId
                                clientDisplayName    = $clientName
                                targetApiSpId        = $targetId
                                targetApiDisplayName = $targetName
                                scope                = $scope
                            }
                        }
                    }
                    $relKey = "$clientId|$scopeResId"
                    if (-not $relMap.ContainsKey($relKey)) {
                        $relMap[$relKey] = @{
                            parentResourceId = $clientId
                            childResourceId  = $scopeResId
                            relationshipType = 'DelegatesScope'
                            roleName         = $scope
                            roleOriginSystem = 'OAuth2'
                        }
                    }
                    $assignments.Add(@{
                        resourceId     = $scopeResId
                        principalId    = $userId
                        principalType  = 'User'
                        assignmentType = 'OAuth2Grant'
                        extendedAttributes = @{
                            grantId              = $g.id
                            clientSpId           = $clientId
                            clientDisplayName    = $clientName
                            targetApiSpId        = $targetId
                            targetApiDisplayName = $targetName
                            scope                = $scope
                        }
                    })
                }
            }

            $scopeRecords = @($scopeResourceMap.Values)
            Update-CrawlerProgress -Detail "Uploading $($scopeRecords.Count) scope resources..."
            Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ resourceType = 'DelegatedPermission' } -Records $scopeRecords

            $relRecords = @($relMap.Values)
            Update-CrawlerProgress -Detail "Uploading $($relRecords.Count) scope relationships..."
            Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ relationshipType = 'DelegatesScope' } -Records $relRecords

            # Dedupe assignments on PK (resourceId, principalId, assignmentType).
            # Graph never returns duplicate per-user grants for the same (client,
            # api) pair, but we split one multi-scope grant into N rows so two
            # different grants referencing the same user/scope via different
            # (client, api) combos could collide at the PK. Unlikely in practice
            # — but a HashSet is cheap insurance.
            $seen = @{}
            $assignRecords = @($assignments | Where-Object {
                $k = "$($_.resourceId)|$($_.principalId)"
                if ($seen.ContainsKey($k)) { $false } else { $seen[$k] = $true; $true }
            })
            Update-CrawlerProgress -Detail "Uploading $($assignRecords.Count) OAuth2 grant assignments..."
            Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $systemId -SyncMode 'full' `
                -Scope @{ assignmentType = 'OAuth2Grant' } -Records $assignRecords
        }
    }
    catch {
        Write-Host "  OAuth2 grant sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("OAuth2Grants: $($_.Exception.Message)")
        Write-Host "  (Requires DelegatedPermissionGrant.Read.All on the app registration.)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); $phaseTimings['OAuth2Grants'] = $__phaseSW.Elapsed
    $__oauthErr = $script:phaseErrors | Where-Object { $_.StartsWith('OAuth2Grants:') } | Select-Object -Last 1
    $__oauthErrMsg = if ($__oauthErr) { $__oauthErr.Substring('OAuth2Grants:'.Length).Trim() } else { $null }
    Write-Phase -Name 'OAuth2Grants' -Duration $__phaseSW.Elapsed -ErrorMsg $__oauthErrMsg
}

# ─── Refresh Views ───────────────────────────────────────────────
if ($RefreshViews) {
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Update-CrawlerProgress -Step 'Refreshing materialized views' -Pct 76 -Detail 'Rebuilding SQL views...'
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Refreshing materialized views..." -ForegroundColor Cyan
    try {
        Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{}
        Write-Host "  Views refreshed" -ForegroundColor Green
    }
    catch {
        Write-Host "  View refresh failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop(); $phaseTimings['RefreshViews'] = $__phaseSW.Elapsed
    Write-Phase -Name 'RefreshViews' -Duration $__phaseSW.Elapsed
}

# ─── Summary ─────────────────────────────────────────────────────
$elapsed = (Get-Date) - $syncStart
Write-Host "`n=== Sync Complete ===" -ForegroundColor Green
Write-Host "Duration: $([Math]::Round($elapsed.TotalSeconds)) seconds" -ForegroundColor Gray

# Per-phase breakdown. The point of the table is to tell an operator
# WHERE the time went so a "this sync takes too long" complaint can be
# investigated without re-running with profiling hacks. Unaccounted time
# (setup, context build invoked by the dispatcher, etc.) is the line
# at the bottom.
if ($phaseTimings.Count -gt 0) {
    Write-Host "`nPer-phase breakdown:" -ForegroundColor Cyan
    $phaseTotal = [TimeSpan]::Zero
    foreach ($kv in $phaseTimings.GetEnumerator()) {
        $secs = [Math]::Round($kv.Value.TotalSeconds, 1)
        $pct  = if ($elapsed.TotalSeconds -gt 0) { [Math]::Round(100 * $kv.Value.TotalSeconds / $elapsed.TotalSeconds, 1) } else { 0 }
        Write-Host ("  {0,-22} {1,8}s  ({2,5}%)" -f $kv.Key, $secs, $pct) -ForegroundColor Gray
        $phaseTotal += $kv.Value
    }
    $other = $elapsed - $phaseTotal
    if ($other.TotalSeconds -gt 1) {
        $otherSecs = [Math]::Round($other.TotalSeconds, 1)
        $otherPct  = [Math]::Round(100 * $other.TotalSeconds / $elapsed.TotalSeconds, 1)
        Write-Host ("  {0,-22} {1,8}s  ({2,5}%)" -f 'Other (setup/etc)', $otherSecs, $otherPct) -ForegroundColor DarkGray
    }
}

# Write a single sync log entry covering the full crawler runtime so the
# Sync Log page reflects the actual end-to-end duration (not just the per-batch
# bulk insert timings written by individual ingest endpoints).
$finalStatus = if ($script:phaseErrors.Count -gt 0) { 'Warning' } else { 'Success' }
$finalError  = if ($script:phaseErrors.Count -gt 0) { ($script:phaseErrors -join ' | ') } else { $null }

# Post the structured per-phase array so the Jobs UI can render a Details
# drawer instead of parsing the single-line errorMessage. Best-effort — if
# this fails we still fall through to the legacy sync-log write.
if ($JobId -and $JobId -gt 0 -and $script:phases.Count -gt 0) {
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $payload = @{ phases = $script:phases } | ConvertTo-Json -Depth 10 -Compress
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/jobs/$JobId/phases" -Method Post `
            -Headers $headers -Body $payload -TimeoutSec 10 | Out-Null
        Write-Host "  Posted $($script:phases.Count) phase record(s) to job API" -ForegroundColor DarkGray
    } catch {
        Write-Host "  (phases write failed: $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}
try {
    Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{
        syncType     = 'EntraID-FullCrawl'
        tableName    = $null
        startTime    = $syncStart.ToString('o')
        endTime      = (Get-Date).ToString('o')
        recordCount  = 0
        status       = $finalStatus
        errorMessage = $finalError
    } | Out-Null
} catch {
    Write-Host "  (sync log write failed: $($_.Exception.Message))" -ForegroundColor DarkGray
}

# If any main-phase failures occurred, throw so the worker scheduler marks
# the job `failed` with a summary message. All successful phases have
# already been ingested and are visible in the UI — this is strictly
# about making the silent-failure case loud. See the $script:phaseErrors
# comment at the top of the script for the motivation.
if ($script:phaseErrors.Count -gt 0) {
    $summary = "Crawl completed with $($script:phaseErrors.Count) phase failure(s):`n  - " + ($script:phaseErrors -join "`n  - ")
    Write-Host "`n$summary" -ForegroundColor Red
    throw $summary
}
