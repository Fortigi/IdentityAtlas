<#
.SYNOPSIS
    Authenticated GET against an OData REST API with retry and nextLink pagination.
#>

#region Functions

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

    # Build initial URI — use concatenation (not double-quoted interpolation) because
    # PowerShell 7 parses "$var?$other" as ${var?} (null variable named "var?"), dropping
    # the URL. Using + avoids the ambiguity.
    $startUri = $base + $Path
    if ($QueryParams.Count -gt 0) {
        $qs = ($QueryParams.GetEnumerator() |
               ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString([string]$_.Value))" }) -join '&'
        $startUri = $startUri + '?' + $qs
    }

    $collected = [System.Collections.Generic.List[object]]::new()
    $nextUri   = $startUri

    while ($nextUri) {
        Update-ODataSessionIfExpired

        $reqParams = @{ Uri = $nextUri; Method = 'Get'; ErrorAction = 'Stop' }
        switch ($script:ODataSession.AuthMethod) {
            { $_ -in 'OAuth2CC','OAuth2ROPC','ApiToken' } {
                $reqParams['Headers'] = @{ Authorization = "Bearer $($script:ODataSession.AccessToken)"
                                           Accept = 'application/json' }
            }
            'CookieString' {
                # Cloud deployments require an explicit Cookie header — WebSession domain
                # matching is unreliable for cloud/HTTPS and the cookie would not be sent.
                $reqParams['Headers'] = @{
                    Cookie         = $script:ODataSession.CookieHeader
                    Accept         = 'application/json'
                    'Content-Type' = 'application/json'
                }
            }
            'FormCookie' {
                $reqParams['WebSession'] = $script:ODataSession.WebSession
                $reqParams['Headers']    = @{ Accept = 'application/json' }
            }
            'BasicAuth' {
                $reqParams['Headers'] = @{ Authorization = $script:ODataSession.BasicAuthHeader
                                           Accept = 'application/json' }
            }
        }

        # Retry loop
        $attempt = 0
        $delays  = @(2, 4, 8, 16, 32)
        $resp    = $null
        while ($attempt -le $MaxRetries) {
            try {
                $resp = Invoke-RestMethod @reqParams
                break
            } catch {
                $status = $null
                try { $status = $_.Exception.Response.StatusCode.value__ } catch {}

                if ($status -in @(401, 403)) {
                    if ($script:ODataSession.AuthMethod -eq 'CookieString') {
                        throw "OData authentication failed (HTTP $status). The cookie may have expired or been rejected by the server. Retrieve a fresh session cookie from your browser and update the crawler config."
                    }
                    if ($script:ODataSession.AuthMethod -eq 'FormCookie' -and $attempt -lt $MaxRetries) {
                        # Server-side session expired — re-authenticate and retry with the new cookie.
                        Write-Host "  OData: session expired (HTTP $status) — re-authenticating..." -ForegroundColor Yellow
                        try { Invoke-ODataFormAuth } catch {
                            throw "OData session expired and re-authentication failed: $($_.Exception.Message)"
                        }
                        $reqParams['WebSession'] = $script:ODataSession.WebSession
                        $attempt++
                        continue
                    }
                }

                $retryAfter = 0
                try {
                    $raHeader = $_.Exception.Response.Headers.GetValues('Retry-After')
                    if ($raHeader) { $retryAfter = [int]($raHeader | Select-Object -First 1) }
                } catch {}

                $isTransient = ($null -eq $status) -or ($status -eq 429) -or ($status -ge 500 -and $status -le 504)
                if (-not $isTransient -or $attempt -ge $MaxRetries) {
                    throw "OData GET $nextUri failed (HTTP $status): $($_.Exception.Message)"
                }

                $delayIdx = [Math]::Min($attempt, $delays.Count - 1)
                $wait = if ($retryAfter -gt 0) { $retryAfter } else { $delays[$delayIdx] }
                Write-Host "  OData: retrying in ${wait}s (HTTP $status, attempt $($attempt+1)/$MaxRetries)..." -ForegroundColor Yellow
                Start-Sleep -Seconds $wait
                $attempt++
                Update-ODataSessionIfExpired
            }
        }
        if ($null -eq $resp) { break }

        # Collect records
        if ($resp.PSObject.Properties.Name -contains 'value') {
            foreach ($r in $resp.value) { $collected.Add($r) }
        } elseif ($resp -is [array]) {
            foreach ($r in $resp) { $collected.Add($r) }
        } else {
            $collected.Add($resp)
        }

        # Follow OData nextLink; stop otherwise (numeric paging is Invoke-ODataPagedRequest's job)
        $nextUri = $resp.'@odata.nextLink'
    }

    # Return as a typed array wrapped in the comma operator so PowerShell does
    # not enumerate an empty collection into $null in the caller's scope.
    return , [object[]]$collected
}

#endregion Functions
