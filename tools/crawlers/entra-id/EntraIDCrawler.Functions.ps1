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

# Thin adapter over the shared Invoke-CrawlerIngestBatch (tools/crawlers/shared/
# Invoke-CrawlerIngest.ps1), which now owns the one canonical ingest protocol
# (single batch, chunked start/continue/end sessions, in-band delta tombstones).
# Entra keeps the same call surface; -SkipWhenEmpty preserves the crawler's
# original "no records and no deletes → no call" behaviour.
function Send-IngestBatch {
    [CmdletBinding()]
    param(
        [string]$Endpoint,
        [int]$SystemId,
        [string]$SyncMode = 'full',
        [hashtable]$Scope = @{},
        [array]$Records,
        [string[]]$DeletedIds = @(),
        [int]$BatchSize = 5000
    )
    Invoke-CrawlerIngestBatch -Endpoint $Endpoint -SystemId $SystemId -SyncMode $SyncMode -Scope $Scope `
        -Records $Records -DeletedIds $DeletedIds -BatchSize $BatchSize -SkipWhenEmpty
}

# HTTP status code off a caught error's response, or $null if unavailable.
function Get-FGHttpStatus {
    [CmdletBinding()]
    param($ErrorRecord)
    if (-not $ErrorRecord.Exception.Response) { return $null }
    try { return [int]$ErrorRecord.Exception.Response.StatusCode } catch { return $null }
}

# Distinct items by a caller-supplied key (a `{ $_ ... }` scriptblock), preserving
# first-seen order. Replaces the `$seen=@{}; Where-Object { ... if contains ... }`
# dedup idiom the phases repeat. The key is run via ForEach-Object so `$_` binds to
# the current item (ScriptBlock.Invoke() does NOT set `$_`).
function Select-FGDistinct {
    [CmdletBinding()]
    param($Items, [scriptblock]$Key)
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $out  = [System.Collections.Generic.List[object]]::new()
    foreach ($it in $Items) {
        if ($seen.Add([string]($it | ForEach-Object $Key))) { $out.Add($it) }
    }
    return @($out)
}

# Human-readable detail for a caught Graph error. PS7 drains the response stream
# before the exception bubbles, so the real Graph error JSON is in ErrorDetails.Message
# (truncated to 300 chars); fall back to the plain exception message.
function Get-FGGraphErrorDetail {
    [CmdletBinding()]
    param($ErrorRecord)
    $body = $null
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        $body = $ErrorRecord.ErrorDetails.Message
        if ($body.Length -gt 300) { $body = $body.Substring(0, 300) + '...' }
    }
    if ($body) { return "$($ErrorRecord.Exception.Message) | $body" }
    return $ErrorRecord.Exception.Message
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

    $collected = [System.Collections.Generic.List[object]]::new()
    $nextUri = $URI
    $deltaLink = $null
    $pageCount = 0

    while ($nextUri) {
        $pageCount++
        $Result = Invoke-FGGraphDeltaPage -Uri $nextUri -MaxRetries $MaxRetries -TimeoutSec $TimeoutSec -PageCount $pageCount
        if ($Result.value) { foreach ($v in $Result.value) { $collected.Add($v) } }
        $nextUri = $Result.'@odata.nextLink'
        if (-not $nextUri) { $deltaLink = $Result.'@odata.deltaLink' }
    }

    $token = Get-FGDeltaTokenFromLink -DeltaLink $deltaLink
    return @{
        value      = $collected
        deltaLink  = $deltaLink
        deltaToken = $token
    }
}

# Fetch one delta page, retrying transient errors (429/5xx) with backoff and
# refreshing the token between attempts. A 400/410 (Graph's "token no longer usable"
# signal) is re-thrown as InvalidOperationException so the caller can fall back to a
# full fetch. Reads/refreshes $Global:AccessToken each attempt.
function Invoke-FGGraphDeltaPage {
    [CmdletBinding()]
    param([string]$Uri, [int]$MaxRetries, [int]$TimeoutSec, [int]$PageCount)
    $retryDelays = @(3, 10, 30, 60, 120, 180)
    $retryCount = 0
    while ($true) {
        try {
            $rmParams = @{ Method = 'Get'; Uri = $Uri; Headers = @{ 'Authorization' = "Bearer $($Global:AccessToken)" } }
            if ($TimeoutSec -gt 0) { $rmParams['TimeoutSec'] = $TimeoutSec }
            return Invoke-RestMethod @rmParams
        }
        catch {
            $statusCode = Get-FGHttpStatus $_
            # Shared rule, plus a Graph-specific term: Graph sometimes reports a
            # transient fault in the message body rather than the status line.
            $isTransient = (Test-TransientHttpStatus $statusCode) -or
                           ($_.Exception.Message -match 'UnknownError|ServiceNotAvailable|GatewayTimeout')
            if (-not ($isTransient -and $retryCount -lt $MaxRetries)) {
                if ($statusCode -in @(400, 410)) {
                    throw [System.InvalidOperationException]::new("Delta token rejected by Graph (HTTP $statusCode): $($_.Exception.Message)")
                }
                throw
            }
            $retryCount++
            Write-Warning "[Invoke-FGGetDeltaRequest] Page ${PageCount}: Transient error (Status: $statusCode). Retry $retryCount/$MaxRetries after $($retryDelays[$retryCount - 1])s..."
            Start-Sleep -Seconds $retryDelays[$retryCount - 1]
            Update-FGAccessTokenIfExpired -DebugFlag 'G'
        }
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
        [Parameter(Mandatory)] [string]$ChildPath,
        [string]$EntityType = 'groups',   # 'groups' | 'servicePrincipals' | 'applications'
        [string]$Select     = 'id'        # $select fields; the raw child object is returned as .raw for richer shapes
    )

    $headers = @{ Authorization = "Bearer $Token" }
    $uri     = "https://graph.microsoft.com/beta/$EntityType/$($Group.id)/$ChildPath`?`$select=$Select&`$top=999"

    $items = [System.Collections.Generic.List[object]]::new()
    $attempt = 0
    $maxAttempts = 4

    while ($uri) {
        $attempt++
        try {
            $resp = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -TimeoutSec 60 -ErrorAction Stop
            if ($resp.value) { $items.AddRange([object[]]@($resp.value)) }
            $uri = $resp.'@odata.nextLink'
            $attempt = 0  # reset on success for nextLink retries
        }
        catch {
            $status = Get-FGHttpStatus $_
            # Retry transient errors with backoff; skip the group after maxAttempts.
            $isTransient = Test-TransientHttpStatus $status
            if ($isTransient -and $attempt -lt $maxAttempts) {
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
            raw         = $child
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
        [string]$EntityType = 'groups',
        [string]$Select     = 'id',
        [int]$ThrottleLimit = 16
    )

    $fetchDef = ${function:Invoke-FGGroupChildFetch}.ToString()
    $Batch | ForEach-Object -Parallel {
        ${function:Invoke-FGGroupChildFetch} = $using:fetchDef
        Invoke-FGGroupChildFetch -Group $_ -Token $using:Token -ChildPath $using:ChildPath -EntityType $using:EntityType -Select $using:Select
    } -ThrottleLimit $ThrottleLimit
}

function Get-FGGroupChildrenParallel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [array]$Groups,
        [Parameter(Mandatory)] [string]$ChildPath,    # 'members' or 'owners'
        [Parameter(Mandatory)] [scriptblock]$RecordBuilder,  # builds a record from $args=@($groupId,$child)
        [string]$EntityType = 'groups',   # 'groups' | 'servicePrincipals' | 'applications'
        [string]$Select     = 'id',       # $select fields for the child fetch
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
        $batchOutput = Invoke-FGGroupChildBatchParallel -Batch $batch -Token $token -ChildPath $ChildPath -EntityType $EntityType -Select $Select -ThrottleLimit $ThrottleLimit
        $totalErrors += Add-FGGroupChildResults -BatchOutput $batchOutput -RecordBuilder $RecordBuilder -AllRecords $allRecords

        $checked = [Math]::Min($i + $BatchSize, $totalGroups)
        Write-FGGroupChildProgress -ProgressStep $ProgressStep -StartPct $ProgressStartPct -EndPct $ProgressEndPct `
            -Checked $checked -Total $totalGroups -ResultCount $allRecords.Count -ErrorCount $totalErrors
    }

    return @{ records = $allRecords; errorCount = $totalErrors }
}

# Fold one parallel batch's output into $AllRecords (mutated in place); returns the
# number of failed groups (kind='error') in the batch. A record is built by invoking
# $RecordBuilder — via .Invoke() into a temp, because PowerShell's parser rejects
# `$list.Add(& $sb $arg)` (ambiguous call-operator inside a method call).
function Add-FGGroupChildResults {
    [CmdletBinding()]
    param($BatchOutput, [scriptblock]$RecordBuilder, $AllRecords)
    $errors = 0
    foreach ($o in $BatchOutput) {
        if ($o.kind -eq 'error') { $errors++; continue }
        $AllRecords.Add($RecordBuilder.Invoke($o)[0])
    }
    return $errors
}

# Emit the per-batch progress line for Get-FGGroupChildrenParallel (no-op without a step).
function Write-FGGroupChildProgress {
    [CmdletBinding()]
    param([string]$ProgressStep, [int]$StartPct, [int]$EndPct, [int]$Checked, [int]$Total, [int]$ResultCount, [int]$ErrorCount)
    if (-not $ProgressStep) { return }
    $subPct   = $StartPct + [int](([double]$Checked / $Total) * ($EndPct - $StartPct))
    $errorTag = if ($ErrorCount -gt 0) { " · $ErrorCount errors" } else { '' }
    Update-CrawlerProgress -Step $ProgressStep -Pct $subPct -Detail "$Checked of $Total groups · $ResultCount results$errorTag"
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

# Deterministic UUID (v3-style, MD5 over a seed string) for synthetic resource ids.
# Mirrors the API's normalizeRecords formatting. Shared by every synthetic-resource
# id helper below so the md5→uuid formatting lives in exactly one place.
function ConvertTo-FGDeterministicUuid {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Seed)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Seed)
        $hex = ([System.BitConverter]::ToString($md5.ComputeHash($bytes)) -replace '-','').ToLower()
    } finally {
        $md5.Dispose()
    }
    return "$($hex.Substring(0,8))-$($hex.Substring(8,4))-$($hex.Substring(12,4))-$($hex.Substring(16,4))-$($hex.Substring(20,12))"
}

# Deterministic UUID for a group's synthetic GroupOwnership resource (named after the group).
function New-OwnershipResourceId {
    [CmdletBinding()]
    param([string]$GroupId)
    return ConvertTo-FGDeterministicUuid -Seed "entraid-ownership:${GroupId}"
}

# Deterministic UUID for a (clientSP, targetApiSP, scope) DelegatedPermission resource.
function New-OAuth2ScopeResourceId {
    [CmdletBinding()]
    param([string]$ClientSpId, [string]$TargetApiSpId, [string]$Scope)
    return ConvertTo-FGDeterministicUuid -Seed "entraid-oauth2-scope:${ClientSpId}:${TargetApiSpId}:${Scope}"
}

# Deterministic UUID for a (servicePrincipal, appRole) AppRole resource.
function New-AppRoleResourceId {
    [CmdletBinding()]
    param([string]$SpId, [string]$AppRoleId)
    return ConvertTo-FGDeterministicUuid -Seed "entraid-approle:${SpId}:${AppRoleId}"
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

# Split a Graph /delta response into the live records and the @removed tombstone
# ids. Shared by the users and service-principal delta fetches, which did this
# identical split inline. Returns @{ items; removedIds }.
function Split-FGDeltaResponse {
    [CmdletBinding()]
    param($Response)
    $items   = @($Response.value | Where-Object { -not $_.'@removed' })
    $removed = @($Response.value | Where-Object { $_.'@removed' } | ForEach-Object { $_.id })
    return @{ items = $items; removedIds = $removed }
}

# Fold one PIM eligibility batch into $RecordsList (by reference) and return the
# count of distinct source groups the batch touched. Extracted from Sync-EntraPim's
# per-batch loop so the phase stays under the complexity ceiling.
function Add-EntraPimBatchRecords {
    [CmdletBinding()]
    param($BatchOutput, $RecordsList)
    $groupSet = @{}
    foreach ($r in $BatchOutput) {
        $RecordsList.Add((ConvertTo-EntraPimRecord -EligibilityRow $r))
        $groupSet[$r.resourceId] = $true
    }
    return $groupSet.Count
}

# Stream one sign-in-log day slice into $Aggregate (by reference), folding each
# event via Add-EntraSignInEventToAggregate. Returns @{ count; skipped }. The
# counters live in a hashtable so the increments survive the streaming pipeline
# block (a plain local wouldn't propagate out of ForEach-Object).
function Invoke-EntraSignInSlice {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$SliceUri,
        [Parameter(Mandatory)] [hashtable]$Aggregate,
        [Parameter(Mandatory)] [hashtable]$AppIdToSpId
    )
    $counters = @{ count = 0; skipped = 0 }
    Invoke-FGGetRequestStream -URI $SliceUri | ForEach-Object {
        if (-not (Add-EntraSignInEventToAggregate -SignInEvent $_ -Aggregate $Aggregate -AppIdToSpId $AppIdToSpId)) {
            $counters.skipped++
        }
        $counters.count++
    }
    return $counters
}
