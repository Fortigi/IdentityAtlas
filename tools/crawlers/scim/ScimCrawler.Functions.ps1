<#
.SYNOPSIS
    SCIM 2.0 REST client, paging, config resolution and the bucketed ingest writer.

.DESCRIPTION
    Dot-sourced into Start-ScimCrawler.ps1's scope (equivalent to defining these
    inline) so the entry point stays a thin orchestrator and everything worth
    testing is reachable from Pester by mocking a named command boundary
    (Invoke-ScimRequest / Invoke-IngestAPI / Invoke-CrawlerIngestBatch).

    Session state lives in $script:ScimSession, mirroring the midPoint/OData
    clients so the dispatcher can dot-source this file before the entry point runs.

    Requires the shared ingest helpers (tools/crawlers/shared/Invoke-CrawlerIngest.ps1)
    for Invoke-IngestAPI, Invoke-CrawlerIngestBatch, ConvertTo-JsonArray and the one
    canonical transient-retry rule (Test-TransientHttpStatus).
#>

$script:ScimSession = $null

#region Connection

# Normalise the configured base URL: strip trailing slashes so '<base>/Users'
# never doubles up. The SCIM base is whatever the service provider publishes
# (commonly '<host>/scim/v2') — no path is assumed or appended.
function Get-ScimBaseUrl {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$BaseUrl)
    return $BaseUrl.Trim().TrimEnd('/')
}

function Invoke-ScimOAuth2 {
    [CmdletBinding()]
    param()
    $endpoint = $script:ScimSession._TokenEndpoint
    if (-not $endpoint) { throw "SCIM OAuth2: tokenEndpoint is required" }
    $form = @{
        grant_type    = 'client_credentials'
        client_id     = $script:ScimSession._ClientId
        client_secret = $script:ScimSession._ClientSecret
    }
    if ($script:ScimSession._Scope) { $form['scope'] = $script:ScimSession._Scope }

    try {
        $resp = Invoke-RestMethod -Uri $endpoint -Method Post -Body $form -ErrorAction Stop
    } catch {
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
        throw "SCIM OAuth2 client-credentials grant failed (HTTP $status): $($_.Exception.Message)"
    }
    if (-not $resp.access_token) { throw "SCIM OAuth2: token response contained no access_token" }
    $script:ScimSession.AccessToken    = $resp.access_token
    $script:ScimSession.AuthHeader     = "Bearer $($resp.access_token)"
    $expiresIn = if ($resp.expires_in) { [int]$resp.expires_in } else { 3600 }
    $script:ScimSession.TokenExpiresAt = [datetime]::UtcNow.AddSeconds($expiresIn)
}

function Connect-ScimAPI {
    <#
    .SYNOPSIS
        Authenticate to a SCIM 2.0 endpoint and store the session for later calls.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory)] [string]$BaseUrl,
        [Parameter(Mandatory)] [ValidateSet('BasicAuth', 'ApiToken', 'OAuth2CC')] [string]$AuthMethod,
        [string]$Username      = '',
        [string]$Password      = '',
        [string]$ApiToken      = '',
        [string]$ClientId      = '',
        [string]$ClientSecret  = '',
        [string]$TokenEndpoint = '',
        [string]$Scope         = '',
        [int]$TimeoutSec       = 120
    )
    $base = Get-ScimBaseUrl -BaseUrl $BaseUrl
    $script:ScimSession = @{
        AuthMethod     = $AuthMethod
        BaseUrl        = $base
        TimeoutSec     = $TimeoutSec
        AuthHeader     = $null
        AccessToken    = $null
        TokenExpiresAt = $null
        _ClientId      = $ClientId
        _ClientSecret  = $ClientSecret
        _TokenEndpoint = $TokenEndpoint
        _Scope         = $Scope
    }

    switch ($AuthMethod) {
        'BasicAuth' {
            if (-not $Username -or -not $Password) { throw "SCIM BasicAuth: username and password are required" }
            $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("${Username}:${Password}"))
            $script:ScimSession.AuthHeader = "Basic $encoded"
        }
        'ApiToken' {
            if (-not $ApiToken) { throw "SCIM ApiToken: apiToken is required" }
            $script:ScimSession.AuthHeader = "Bearer $ApiToken"
        }
        'OAuth2CC' { Invoke-ScimOAuth2 }
    }
    Write-Host "  SCIM: authenticated via $AuthMethod to $base" -ForegroundColor Green
}

function Update-ScimSessionIfExpired {
    [CmdletBinding()]
    param()
    if ($null -eq $script:ScimSession) { throw "SCIM: not connected. Call Connect-ScimAPI first." }
    if ($script:ScimSession.AuthMethod -ne 'OAuth2CC') { return }
    $margin = [timespan]::FromMinutes(2)
    if ($script:ScimSession.TokenExpiresAt -and [datetime]::UtcNow -ge ($script:ScimSession.TokenExpiresAt - $margin)) {
        Invoke-ScimOAuth2
    }
}

function Get-ScimHeaders {
    [CmdletBinding()]
    param()
    if ($null -eq $script:ScimSession) { throw "SCIM: not connected. Call Connect-ScimAPI first." }
    Update-ScimSessionIfExpired
    return @{
        Authorization = $script:ScimSession.AuthHeader
        Accept        = 'application/scim+json'
    }
}

#endregion Connection

#region Requests

# Low-level GET with the shared transient-retry rule. A non-transient failure
# (401/403/404) is re-thrown with the status and endpoint but never the credential.
function Invoke-ScimRequest {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Uri, [int]$MaxRetries = 4)
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            return Invoke-RestMethod -Uri $Uri -Method Get -Headers (Get-ScimHeaders) `
                -TimeoutSec $script:ScimSession.TimeoutSec -ErrorAction Stop
        } catch {
            $status = $null
            try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
            if ((Test-TransientHttpStatus $status) -and $attempt -le $MaxRetries) {
                $delay = [Math]::Pow(2, $attempt)
                Write-Host "  SCIM transient failure (HTTP $status) on $Uri — retry $attempt/$MaxRetries in ${delay}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
                continue
            }
            throw "SCIM request failed (HTTP $status) for $Uri"
        }
    }
}

# Build one paged collection URL. SCIM 2.0 paging (RFC 7644 §3.4.2.4) is
# 1-based: startIndex is the index of the FIRST result, count is the page size.
function Get-ScimPageUrl {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$BaseUrl, [Parameter(Mandatory)][string]$Endpoint, [int]$StartIndex, [int]$Count)
    return "$BaseUrl/$Endpoint" + '?startIndex=' + $StartIndex + '&count=' + $Count
}

# Decide what to do after one page: which items it carried and where the next
# request starts (0 = stop). Pure, so the paging contract is unit-testable without
# a server. A short page ends the walk; so does reaching totalResults, which keeps
# a compliant provider from being asked for one pointless empty page.
function Get-ScimPageState {
    [CmdletBinding()]
    param($Response, [int]$StartIndex, [int]$PageSize)
    $items = @()
    if ($Response -and $null -ne $Response.Resources) { $items = @($Response.Resources) }

    if ($items.Count -eq 0)          { return @{ items = @(); nextStartIndex = 0 } }
    if ($items.Count -lt $PageSize)  { return @{ items = $items; nextStartIndex = 0 } }

    $next = $StartIndex + $items.Count
    if ($Response.totalResults -and $next -gt [int]$Response.totalResults) { $next = 0 }
    return @{ items = $items; nextStartIndex = $next }
}

# Walk a SCIM collection, invoking -OnPage with each page's Resources array and
# discarding the raw page afterwards. Returns the total number of objects seen.
function Invoke-ScimSearchStream {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [Parameter(Mandatory)] [scriptblock]$OnPage,
        [int]$PageSize = 100
    )
    $base       = $script:ScimSession.BaseUrl
    $startIndex = 1
    $total      = 0
    while ($startIndex -gt 0) {
        $resp  = Invoke-ScimRequest -Uri (Get-ScimPageUrl -BaseUrl $base -Endpoint $Endpoint -StartIndex $startIndex -Count $PageSize)
        $state = Get-ScimPageState -Response $resp -StartIndex $startIndex -PageSize $PageSize
        if ($state.items.Count -gt 0) {
            & $OnPage $state.items
            $total += $state.items.Count
        }
        $startIndex = $state.nextStartIndex
    }
    return $total
}

#endregion Requests

#region Configuration

# Resolve the dispatcher's job config into the settings the phases read.
# _syncMode is the only reserved key the dispatcher injects; SCIM 2.0 has no
# standard change feed, so a delta request runs as a full sync (D15/S3) — the
# caller logs that it did.
function Resolve-ScimConfig {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ConfigPath)
    $raw = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
    return (ConvertFrom-ScimConfigMap -Raw $raw)
}

# Phase toggles: every object type is on unless the config explicitly turns it off.
function Get-ScimSyncToggles {
    [CmdletBinding()]
    param($Raw)
    $defaults = @{ users = $true; groups = $true; groupMembers = $true }
    $selected = $Raw['selectedObjects']
    $sync     = @{}
    foreach ($k in $defaults.Keys) {
        $sync[$k] = if ($selected -and $null -ne $selected[$k]) { [bool]$selected[$k] } else { $defaults[$k] }
    }
    return $sync
}

# One opt-in attribute list. @($null) is a ONE-element array holding $null, so an
# absent key has to be filtered out explicitly or "nothing selected" would read as
# one blank attribute name.
function Get-ScimAttributeList {
    [CmdletBinding()]
    param($SelectedAttributes, [string]$Key)
    # Leading comma on every return: a one-element array unwraps back into the bare
    # element on the way out of a function, and callers read .Count on the result.
    if (-not $SelectedAttributes) { return ,@() }
    return ,@(@($SelectedAttributes[$Key]) | Where-Object { $_ })
}

# The userType → principalType rules, falling back to the catch-all default. Same
# @($null) trap as above: without the filter, "no mapping configured" looks like one
# empty rule and the default is never applied.
function Get-ScimUserTypeMapping {
    [CmdletBinding()]
    param($Raw)
    $mapping = @(@($Raw['userTypeMapping']) | Where-Object { $null -ne $_ })
    if ($mapping.Count -eq 0) { return ,@(@{ userType = ''; principalType = 'User' }) }
    return ,$mapping
}

# The pure half of Resolve-ScimConfig: raw config hashtable → resolved settings.
# Split out so the defaults are unit-testable without touching the filesystem.
function ConvertFrom-ScimConfigMap {
    [CmdletBinding()]
    param($Raw)
    $raw = if ($Raw) { $Raw } else { @{} }

    $mapping  = Get-ScimUserTypeMapping -Raw $raw
    $selected = $raw['selectedAttributes']

    $pageSize = if ($raw['pageSize']) { [int]$raw['pageSize'] } else { 100 }
    if ($pageSize -lt 1) { $pageSize = 100 }

    return @{
        cfg              = $raw
        sync             = Get-ScimSyncToggles -Raw $raw
        requestedMode    = if ($raw['_syncMode']) { [string]$raw['_syncMode'] } else { 'full' }
        pageSize         = $pageSize
        systemName       = if ($raw['systemName']) { [string]$raw['systemName'] } else { 'SCIM' }
        userAttributes   = Get-ScimAttributeList -SelectedAttributes $selected -Key 'user'
        groupAttributes  = Get-ScimAttributeList -SelectedAttributes $selected -Key 'group'
        userTypeMapping  = $mapping
        principalBuckets = Get-ScimPrincipalTypeBuckets -Mapping $mapping
    }
}

#endregion Configuration

#region Ingest

# Deterministic-id namespace for this run. The raw SCIM id is an arbitrary string,
# so ingest derives the UUID primary key from "<idPrefix>-<entity>:<externalId>"
# (see app/api/src/ingest/normalization.js). Keying the prefix on the systemId keeps
# two SCIM endpoints that happen to share an id from colliding, and makes every
# re-run land on the same rows.
function Get-ScimIdPrefix {
    [CmdletBinding()]
    param([int]$SystemId)
    return "scim-sys$SystemId"
}

# ── Bucketed streaming ingest writer ─────────────────────────────────────────
# A full-sync scoped delete keys on systemId PLUS the scope columns, so records
# that differ in a scope column (principalType for principals) must be sent as
# separate batches or each batch's reconcile would delete the other's rows.
# This writer owns one buffer per scope value, flushes a buffer as soon as it
# exceeds -BatchSize (within ONE sync session, so the closing delete still sees
# the complete set), and — on completion — sends an empty full-sync batch for
# every declared bucket that produced nothing, which is what lets a type that
# lost its last account actually have its stale rows removed.
function New-ScimIngestWriter {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$ScopeKey = '',
        [hashtable]$FixedScope = @{},
        [int]$BatchSize = 2000
    )
    [pscustomobject]@{
        Endpoint   = $Endpoint
        SystemId   = $SystemId
        ScopeKey   = $ScopeKey
        FixedScope = $FixedScope
        BatchSize  = $BatchSize
        IdPrefix   = (Get-ScimIdPrefix -SystemId $SystemId)
        Buckets    = @{}
        Records    = 0
    }
}

# The scope hashtable for one bucket: the writer's fixed scope plus, when the
# endpoint partitions on a column, that bucket's value for it.
function Get-ScimBucketScope {
    [CmdletBinding()]
    param($Writer, [string]$Bucket)
    $scope = @{}
    foreach ($kv in $Writer.FixedScope.GetEnumerator()) { $scope[$kv.Key] = $kv.Value }
    if ($Writer.ScopeKey) { $scope[$Writer.ScopeKey] = $Bucket }
    return $scope
}

function Get-ScimWriterBucket {
    [CmdletBinding()]
    param($Writer, [string]$Bucket)
    if (-not $Writer.Buckets.ContainsKey($Bucket)) {
        $Writer.Buckets[$Bucket] = @{
            Buffer  = [System.Collections.Generic.List[object]]::new()
            SyncId  = $null
            Started = $false
        }
    }
    return $Writer.Buckets[$Bucket]
}

# Send one chunk of a bucket inside its sync session. $Session is 'start',
# 'continue' or 'end'; the server fires the scoped delete on 'end'.
function Send-ScimIngestChunk {
    [CmdletBinding()]
    param($Writer, [string]$Bucket, [string]$Session)
    $state = Get-ScimWriterBucket -Writer $Writer -Bucket $Bucket
    $body  = @{
        systemId     = $Writer.SystemId
        syncMode     = 'full'
        scope        = (Get-ScimBucketScope -Writer $Writer -Bucket $Bucket)
        records      = ConvertTo-JsonArray @($state.Buffer)
        idGeneration = 'deterministic'
        idPrefix     = "$($Writer.IdPrefix)-$($Writer.Endpoint -replace '^ingest/', '')"
        syncSession  = $Session
    }
    if ($state.SyncId) { $body['syncId'] = $state.SyncId }
    $result = Invoke-IngestAPI -Endpoint $Writer.Endpoint -Body $body
    if ($Session -eq 'start' -and $result.syncId) { $state.SyncId = $result.syncId }
    $state.Started = $true
    $state.Buffer.Clear()
}

function Add-ScimIngestRecord {
    [CmdletBinding()]
    param($Writer, [string]$Bucket, $Record)
    if (-not $Record) { return }
    $state = Get-ScimWriterBucket -Writer $Writer -Bucket $Bucket
    $state.Buffer.Add($Record)
    $Writer.Records++
    # Flush only once the buffer holds MORE than a full batch, so a non-empty
    # remainder is always left for the closing 'end' (ingest rejects an empty
    # records array mid-session, and the scoped delete fires on 'end').
    if ($state.Buffer.Count -gt $Writer.BatchSize) {
        $keep = [System.Collections.Generic.List[object]]::new()
        for ($i = $Writer.BatchSize; $i -lt $state.Buffer.Count; $i++) { $keep.Add($state.Buffer[$i]) }
        while ($state.Buffer.Count -gt $Writer.BatchSize) { $state.Buffer.RemoveAt($state.Buffer.Count - 1) }
        Send-ScimIngestChunk -Writer $Writer -Bucket $Bucket -Session ($(if ($state.Started) { 'continue' } else { 'start' }))
        $Writer.Buckets[$Bucket].Buffer = $keep
    }
}

# Close every bucket. Buckets that streamed at least one chunk get their final
# 'end' chunk; buckets that fit in one batch go through the shared batch helper;
# declared-but-empty buckets get an empty full-sync batch so their stale rows are
# reconciled away.
function Complete-ScimIngestWriter {
    [CmdletBinding()]
    param($Writer, [string[]]$DeclaredBuckets = @())
    $all = [System.Collections.Generic.List[string]]::new()
    foreach ($b in $Writer.Buckets.Keys) { [void]$all.Add($b) }
    foreach ($b in $DeclaredBuckets) { if (-not $all.Contains($b)) { [void]$all.Add($b) } }

    foreach ($bucket in $all) {
        $state = Get-ScimWriterBucket -Writer $Writer -Bucket $bucket
        if ($state.Started) {
            Send-ScimIngestChunk -Writer $Writer -Bucket $bucket -Session 'end'
            continue
        }
        Invoke-CrawlerIngestBatch -Endpoint $Writer.Endpoint -SystemId $Writer.SystemId -SyncMode 'full' `
            -Scope (Get-ScimBucketScope -Writer $Writer -Bucket $bucket) -Records @($state.Buffer) `
            -IdGeneration 'deterministic' -IdPrefix $Writer.IdPrefix -BatchSize $Writer.BatchSize | Out-Null
        $state.Buffer.Clear()
    }
}

#endregion Ingest
