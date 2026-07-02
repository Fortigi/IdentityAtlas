<#
.SYNOPSIS
    Reusable Entra ID crawler helper functions, extracted from Start-EntraIDCrawler.ps1.

.DESCRIPTION
    These functions are dot-sourced into Start-EntraIDCrawler.ps1's own scope, which
    is equivalent to defining them inline. They read script-scope variables
    ($ApiKey, $ApiBaseUrl, $Global:AccessToken, $script:phases, ...) from the
    calling crawler's scope at call time, exactly as before.

    Extracted into a standalone file so the functions can be unit-tested in
    isolation with Pester (see test/unit/EntraIDCrawlerFunctions.Tests.ps1). The
    function bodies are unchanged from their original inline definitions.

    Send-IngestBatch calls Invoke-IngestAPI / ConvertTo-JsonArray from
    tools/crawlers/shared/Invoke-CrawlerIngest.ps1 — dot-source that file too.
#>

function Send-IngestBatch {
    [CmdletBinding()]
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
            records  = if ($haveRecords) { ConvertTo-JsonArray $Records } else { ConvertTo-JsonArray $null }
        }
        if ($haveDeletes) { $body['deletedIds'] = ConvertTo-JsonArray $DeletedIds }
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
            records    = ConvertTo-JsonArray $null
            deletedIds = ConvertTo-JsonArray $DeletedIds
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
            records     = ConvertTo-JsonArray $batch
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
    [CmdletBinding()]
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
    [CmdletBinding()]
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
    [CmdletBinding()]
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
    [CmdletBinding()]
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
    [CmdletBinding()]
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
# Fetch one group's children (members/owners) with pagination + transient-error
# retry. Returns one [pscustomobject] per child (kind='record') or a single
# kind='error' object if the group fails after maxAttempts. Pulled out of the
# ForEach-Object -Parallel block in Get-FGGroupChildrenParallel so the retry /
# pagination / error logic is unit-testable in the main runspace (code running
# inside -Parallel runspaces cannot be reached by mocks or coverage).
function Invoke-FGGroupChildFetch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Group,
        [Parameter(Mandatory)] [string]$Token,
        [Parameter(Mandatory)] [string]$ChildPath
    )

    $headers = @{ Authorization = "Bearer $Token" }
    $uri     = "https://graph.microsoft.com/beta/groups/$($Group.id)/$ChildPath`?`$select=id&`$top=999"

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
            [pscustomobject]@{ kind = 'error'; resourceId = $Group.id; message = $_.Exception.Message }
            return
        }
    }

    foreach ($child in $items) {
        [pscustomobject]@{
            kind        = 'record'
            resourceId  = $Group.id
            principalId = $child.id
            childType   = $child.'@odata.type'
        }
    }
}

# Run Invoke-FGGroupChildFetch across a batch of groups in parallel runspaces.
# The fetch function is re-established inside each runspace via $using (runspaces
# don't inherit the caller's functions). Isolated behind its own function so the
# batch loop / fold logic in Get-FGGroupChildrenParallel can be tested by mocking
# this (the -Parallel body itself can't be mocked or coverage-instrumented).
function Invoke-FGGroupChildBatchParallel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [array]$Batch,
        [Parameter(Mandatory)] [string]$Token,
        [Parameter(Mandatory)] [string]$ChildPath,
        [int]$ThrottleLimit = 16
    )

    $fetchDef = ${function:Invoke-FGGroupChildFetch}.ToString()
    $Batch | ForEach-Object -Parallel {
        ${function:Invoke-FGGroupChildFetch} = $using:fetchDef
        Invoke-FGGroupChildFetch -Group $_ -Token $using:Token -ChildPath $using:ChildPath
    } -ThrottleLimit $ThrottleLimit
}

function Get-FGGroupChildrenParallel {
    [CmdletBinding()]
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

        # Fetch each group's children in parallel. Each result is a [pscustomobject]
        # with kind='record' (a child) or kind='error' (a group that failed after
        # retries). See Invoke-FGGroupChildBatchParallel / Invoke-FGGroupChildFetch.
        $batchOutput = Invoke-FGGroupChildBatchParallel -Batch $batch -Token $token -ChildPath $ChildPath -ThrottleLimit $ThrottleLimit

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

# Query PIM group-eligibility schedules for a batch of groups in parallel
# runspaces, emitting one raw eligibility row per (group, principal). Pulled out
# of the inline ForEach-Object -Parallel block in the PIM phase so the phase's
# batching / fold / dedup logic is unit-testable by mocking this (the -Parallel
# body itself can't be mocked or coverage-instrumented). Per-group errors are
# normal (most groups aren't PIM-enabled) and silently dropped.
function Invoke-FGGroupPimBatchParallel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [array]$Batch,
        [Parameter(Mandatory)] [string]$Token,
        [int]$ThrottleLimit = 16
    )

    $Batch | ForEach-Object -Parallel {
        $g = $_
        $token = $using:Token
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
    } -ThrottleLimit $ThrottleLimit
}

function Write-Phase {
    [CmdletBinding()]
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

# ─── Helper: get attribute value, handling extensionAttributeN ────
# extensionAttribute1-15 live under onPremisesExtensionAttributes
function Get-UserAttrValue {
    [CmdletBinding()]
    param($User, [string]$AttrName)
    if ($AttrName -match '^extensionAttribute\d+$') {
        if ($User.onPremisesExtensionAttributes) {
            return $User.onPremisesExtensionAttributes.$AttrName
        }
        return $null
    }
    return $User.$AttrName
}

# Coerce a configured filter value to the type of the sample attribute value, so a
# JSON-string config ("true", "42") compares correctly against a typed Graph value.
function ConvertTo-FilterValue {
    [CmdletBinding()]
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

# Deterministic UUID for a group's synthetic "Owner @ <group>" GroupOwnership resource.
function New-OwnershipResourceId {
    [CmdletBinding()]
    param([string]$GroupId)
    $seed = "entraid-ownership:${GroupId}"
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($seed)
        $hex = ([System.BitConverter]::ToString($md5.ComputeHash($bytes)) -replace '-','').ToLower()
    } finally {
        $md5.Dispose()
    }
    return "$($hex.Substring(0,8))-$($hex.Substring(8,4))-$($hex.Substring(12,4))-$($hex.Substring(16,4))-$($hex.Substring(20,12))"
}

# Deterministic UUID for a (clientSP, targetApiSP, scope) DelegatedPermission resource.
function New-OAuth2ScopeResourceId {
    [CmdletBinding()]
    param([string]$ClientSpId, [string]$TargetApiSpId, [string]$Scope)
    $hashInput = "entraid-oauth2-scope:${ClientSpId}:${TargetApiSpId}:${Scope}"
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($hashInput)
        $hex = ([System.BitConverter]::ToString($md5.ComputeHash($bytes)) -replace '-','').ToLower()
    } finally {
        $md5.Dispose()
    }
    return "$($hex.Substring(0,8))-$($hex.Substring(8,4))-$($hex.Substring(12,4))-$($hex.Substring(16,4))-$($hex.Substring(20,12))"
}

# Deterministic UUID for a (servicePrincipal, appRole) AppRole resource.
function New-AppRoleResourceId {
    [CmdletBinding()]
    param([string]$SpId, [string]$AppRoleId)
    $seed = "entraid-approle:${SpId}:${AppRoleId}"
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($seed)
        $hex = ([System.BitConverter]::ToString($md5.ComputeHash($bytes)) -replace '-','').ToLower()
    } finally {
        $md5.Dispose()
    }
    return "$($hex.Substring(0,8))-$($hex.Substring(8,4))-$($hex.Substring(12,4))-$($hex.Substring(16,4))-$($hex.Substring(20,12))"
}

# Map a directory-role member's @odata.type to a principalType.
function Resolve-DirectoryRolePrincipalType {
    [CmdletBinding()]
    param($Principal)
    switch -Wildcard ($Principal.'@odata.type') {
        '*servicePrincipal' { 'ServicePrincipal'; break }
        '*group'            { 'Group'; break }
        '*user'             { 'User'; break }
        default             { 'User' }
    }
}

# Build the display name for a DelegatedPermission resource. A DelegatedPermission is one per
# (clientSP, targetApiSP, scope), so the same scope consented by many apps is many distinct
# resources; including the consenting app keeps them apart in the resources grid instead of
# looking like duplicates. Falls back to "<scope> on <target>" when the client name is unknown.
function Format-FGDelegatedPermissionName {
    [CmdletBinding()]
    param(
        [string]$Scope,
        [string]$TargetName,
        [string]$ClientName
    )
    if ($ClientName) { "$Scope on $TargetName (via $ClientName)" }
    else { "$Scope on $TargetName" }
}
