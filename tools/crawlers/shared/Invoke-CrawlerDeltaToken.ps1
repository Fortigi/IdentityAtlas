<#
.SYNOPSIS
    Read, write and clear a crawler's delta token — the one client for the
    /crawlers/delta-tokens endpoints.

.DESCRIPTION
    A delta token is whatever a crawler must hand back to its source next run to
    be given only what changed. For Graph that is the `$deltatoken` from an
    `@odata.deltaLink`; for the SQL connector it is the high-water mark of a
    statement's `modified` column. The API stores one row per
    (systemId, endpoint) in DeltaTokens, so the SHAPE of the request that
    produced it has to be part of the endpoint key: a token paired with a
    different query silently skips the rows the new shape would have returned.

    Reads $ApiBaseUrl / $ApiKey from the caller's scope, like every other shared
    crawler helper.

    Failure is never fatal. A read that fails returns $null, which means "no
    token" — a full fetch, slower but never wrong. A write that fails leaves the
    previous token in place, so the next run re-reads the same window; every
    ingest here is an upsert, so a re-read costs time, not correctness.
#>

#region Functions

# The endpoint key must survive the API's own validation
# (^[a-zA-Z0-9/_\-.:]+$, at most 200 characters) — everything else is a 400.
function Test-CrawlerDeltaTokenEndpoint {
    [CmdletBinding()]
    [OutputType([bool])]
    param([AllowEmptyString()] [string]$Endpoint)
    return [bool]($Endpoint -and $Endpoint.Length -le 200 -and $Endpoint -match '^[a-zA-Z0-9/_\-.:]+$')
}

function Get-CrawlerDeltaTokenUri {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [string]$Endpoint)
    return "$ApiBaseUrl/crawlers/delta-tokens/$([uri]::EscapeDataString($Endpoint))"
}

# The stored row for one (system, endpoint), or $null when there is none.
# Returns the whole row — the token AND its lastSyncAt — because a caller that
# schedules on age (the SQL connector's key sweep) needs the timestamp, and
# asking twice would be a second round trip for a value the first already had.
function Get-CrawlerDeltaTokenRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId, [Parameter(Mandatory)] [string]$Endpoint)
    try {
        $r = Invoke-RestMethod -Uri "$(Get-CrawlerDeltaTokenUri -Endpoint $Endpoint)?systemId=$SystemId" `
            -Method Get -Headers @{ 'Authorization' = "Bearer $ApiKey" } -TimeoutSec 10
        if ($r -and $r.token) { return $r }
    } catch {
        # A first run has no row, which the API answers with token=null rather
        # than an error; anything else is logged and degrades to "no token".
        Write-Host "  (delta token lookup for $Endpoint returned no token)" -ForegroundColor DarkGray
    }
    return $null
}

# Just the token string, for callers that do not care when it was stored.
function Get-CrawlerDeltaToken {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId, [Parameter(Mandatory)] [string]$Endpoint)
    $row = Get-CrawlerDeltaTokenRow -SystemId $SystemId -Endpoint $Endpoint
    if ($row) { return [string]$row.token }
    return $null
}

function Set-CrawlerDeltaToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [Parameter(Mandatory)] [string]$Endpoint,
        [AllowEmptyString()] [string]$Token,
        [int]$RecordsLastSeen = 0
    )
    if (-not $Token) { return }
    try {
        $body = @{ systemId = $SystemId; token = $Token; recordsLastSeen = $RecordsLastSeen } | ConvertTo-Json
        Invoke-RestMethod -Uri (Get-CrawlerDeltaTokenUri -Endpoint $Endpoint) -Method Put `
            -Headers @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' } `
            -Body $body -TimeoutSec 10 | Out-Null
    } catch {
        Write-Host "  (delta token save failed for ${Endpoint}: $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}

function Remove-CrawlerDeltaToken {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId, [Parameter(Mandatory)] [string]$Endpoint)
    try {
        Invoke-RestMethod -Uri "$(Get-CrawlerDeltaTokenUri -Endpoint $Endpoint)?systemId=$SystemId" `
            -Method Delete -Headers @{ 'Authorization' = "Bearer $ApiKey" } -TimeoutSec 10 | Out-Null
    } catch { }
}

#endregion Functions
