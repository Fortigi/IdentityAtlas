<#
.SYNOPSIS
    Authenticated GET against an OData REST API with retry and nextLink pagination.
#>

#region Functions

function Resolve-ODataStartUri {
    <#
    .SYNOPSIS
        Build the initial request URI from base, path and query params.
    #>
    [CmdletBinding()]
    param(
        [string]$Base,
        [string]$Path,
        [hashtable]$QueryParams = @{}
    )

    # Use concatenation (not double-quoted interpolation) because PowerShell 7
    # parses "$var?$other" as ${var?} (null variable named "var?"), dropping the
    # URL. Using + avoids the ambiguity.
    $startUri = $Base + $Path
    if ($QueryParams.Count -gt 0) {
        $qs = ($QueryParams.GetEnumerator() |
               ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString([string]$_.Value))" }) -join '&'
        $startUri = $startUri + '?' + $qs
    }

    return $startUri
}

function Add-ODataAuthParam {
    <#
    .SYNOPSIS
        Add the auth headers / web session for the connected auth method to a
        request-parameter hashtable (mutated in place).
    #>
    [CmdletBinding()]
    param(
        [hashtable]$ReqParams,
        $Session
    )

    switch ($Session.AuthMethod) {
        { $_ -in 'OAuth2CC','OAuth2ROPC','ApiToken' } {
            $ReqParams['Headers'] = @{ Authorization = "Bearer $($Session.AccessToken)"
                                       Accept = 'application/json' }
        }
        'CookieString' {
            # Cloud deployments require an explicit Cookie header — WebSession domain
            # matching is unreliable for cloud/HTTPS and the cookie would not be sent.
            $ReqParams['Headers'] = @{
                Cookie         = $Session.CookieHeader
                Accept         = 'application/json'
                'Content-Type' = 'application/json'
            }
        }
        'FormCookie' {
            $ReqParams['WebSession'] = $Session.WebSession
            $ReqParams['Headers']    = @{ Accept = 'application/json' }
        }
        'BasicAuth' {
            $ReqParams['Headers'] = @{ Authorization = $Session.BasicAuthHeader
                                       Accept = 'application/json' }
        }
    }
}

function Get-ODataResponseStatus {
    <#
    .SYNOPSIS
        Extract the HTTP status code from a failed request's error record.
    #>
    [CmdletBinding()]
    param($ErrorRecord)

    $status = $null
    try { $status = $ErrorRecord.Exception.Response.StatusCode.value__ } catch {}
    return $status
}

function Get-ODataRetryAfter {
    <#
    .SYNOPSIS
        Read a Retry-After header (seconds) from a failed request; 0 when absent.
    #>
    [CmdletBinding()]
    param($ErrorRecord)

    $retryAfter = 0
    try {
        $raHeader = $ErrorRecord.Exception.Response.Headers.GetValues('Retry-After')
        if ($raHeader) { $retryAfter = [int]($raHeader | Select-Object -First 1) }
    } catch {}
    return $retryAfter
}

function Test-ODataTransientStatus {
    <#
    .SYNOPSIS
        True when the status is retryable (network error, 429, or 5xx).
    #>
    [CmdletBinding()]
    param($Status)

    return ($null -eq $Status) -or ($Status -eq 429) -or ($Status -ge 500 -and $Status -le 504)
}

function Get-ODataRetryWait {
    <#
    .SYNOPSIS
        Seconds to wait before the next attempt — Retry-After when present, else
        the backoff delay for this attempt.
    #>
    [CmdletBinding()]
    param(
        [int]$Attempt,
        [int]$RetryAfter,
        [int[]]$Delays
    )

    if ($RetryAfter -gt 0) { return $RetryAfter }
    $delayIdx = [Math]::Min($Attempt, $Delays.Count - 1)
    return $Delays[$delayIdx]
}

function Resolve-ODataAuthFailure {
    <#
    .SYNOPSIS
        Handle a 401/403. Throws for a rejected cookie; re-authenticates and
        returns $true (retry) for an expired form session; $false otherwise.
    #>
    [CmdletBinding()]
    param(
        $Status,
        [int]$Attempt,
        [int]$MaxRetries,
        [hashtable]$ReqParams
    )

    if ($Status -notin @(401, 403)) { return $false }

    if ($script:ODataSession.AuthMethod -eq 'CookieString') {
        throw "OData authentication failed (HTTP $Status). The cookie may have expired or been rejected by the server. Retrieve a fresh session cookie from your browser and update the crawler config."
    }

    if ($script:ODataSession.AuthMethod -eq 'FormCookie' -and $Attempt -lt $MaxRetries) {
        # Server-side session expired — re-authenticate and retry with the new cookie.
        Write-Host "  OData: session expired (HTTP $Status) — re-authenticating..." -ForegroundColor Yellow
        try { Invoke-ODataFormAuth } catch {
            throw "OData session expired and re-authentication failed: $($_.Exception.Message)"
        }
        $ReqParams['WebSession'] = $script:ODataSession.WebSession
        return $true
    }

    return $false
}

function Invoke-ODataRequestWithRetry {
    <#
    .SYNOPSIS
        Issue a single GET with transient-error retry + backoff; returns the
        response object (or $null when retries are exhausted without success).
    #>
    [CmdletBinding()]
    param(
        [hashtable]$ReqParams,
        [int]$MaxRetries
    )

    $attempt = 0
    $delays  = @(2, 4, 8, 16, 32)
    $resp    = $null
    while ($attempt -le $MaxRetries) {
        try {
            $resp = Invoke-RestMethod @ReqParams
            break
        } catch {
            $status = Get-ODataResponseStatus -ErrorRecord $_

            if (Resolve-ODataAuthFailure -Status $status -Attempt $attempt -MaxRetries $MaxRetries -ReqParams $ReqParams) {
                $attempt++
                continue
            }

            $retryAfter = Get-ODataRetryAfter -ErrorRecord $_
            if (-not (Test-ODataTransientStatus -Status $status) -or $attempt -ge $MaxRetries) {
                throw "OData GET $($ReqParams.Uri) failed (HTTP $status): $($_.Exception.Message)"
            }

            $wait = Get-ODataRetryWait -Attempt $attempt -RetryAfter $retryAfter -Delays $delays
            Write-Host "  OData: retrying in ${wait}s (HTTP $status, attempt $($attempt+1)/$MaxRetries)..." -ForegroundColor Yellow
            Start-Sleep -Seconds $wait
            $attempt++
            Update-ODataSessionIfExpired
        }
    }

    return $resp
}

function Add-ODataRecord {
    <#
    .SYNOPSIS
        Append a response's records to the accumulator list (mutated in place).
    #>
    [CmdletBinding()]
    param(
        $Response,
        [System.Collections.Generic.List[object]]$Collected
    )

    if ($Response.PSObject.Properties.Name -contains 'value') {
        foreach ($r in $Response.value) { $Collected.Add($r) }
    } elseif ($Response -is [array]) {
        foreach ($r in $Response) { $Collected.Add($r) }
    } else {
        $Collected.Add($Response)
    }
}

function Invoke-ODataGetRequest {
    <#
    .SYNOPSIS
        GET a path relative to the OData baseUrl.
    .DESCRIPTION
        Handles two cases transparently:
          OData  (Cloud)  — follows @odata.nextLink until exhausted
          Single response — returns as-is when nextLink is absent
        Numeric page-by-page walking is handled by Invoke-ODataPagedRequest.
        Refreshes the session/token before each attempt.
    .OUTPUTS
        Array of records (from .value or the full response).
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Generic.List[object]])]
    param(
        [Parameter(Mandatory)] [string]$Path,
        [hashtable]$QueryParams = @{},
        [int]$MaxRetries = 5,
        [string]$OverrideBaseUrl = ''  # use session BaseUrl when empty
    )

    if ($null -eq $script:ODataSession) { throw "OData: not connected. Call Connect-ODataAPI first." }

    $base = if ($OverrideBaseUrl) { $OverrideBaseUrl.TrimEnd('/') } else { $script:ODataSession.BaseUrl }
    if (-not $base) { throw "OData: session BaseUrl is empty — was Connect-ODataAPI called successfully?" }

    $collected = [System.Collections.Generic.List[object]]::new()
    $nextUri   = Resolve-ODataStartUri -Base $base -Path $Path -QueryParams $QueryParams

    while ($nextUri) {
        Update-ODataSessionIfExpired

        $reqParams = @{ Uri = $nextUri; Method = 'Get'; ErrorAction = 'Stop' }
        Add-ODataAuthParam -ReqParams $reqParams -Session $script:ODataSession

        $resp = Invoke-ODataRequestWithRetry -ReqParams $reqParams -MaxRetries $MaxRetries
        if ($null -eq $resp) { break }

        Add-ODataRecord -Response $resp -Collected $collected

        # Follow OData nextLink; stop otherwise (numeric paging is Invoke-ODataPagedRequest's job)
        $nextUri = $resp.'@odata.nextLink'
    }

    # Return as a typed array wrapped in the comma operator so PowerShell does
    # not enumerate an empty collection into $null in the caller's scope.
    return , [object[]]$collected
}

#endregion Functions
