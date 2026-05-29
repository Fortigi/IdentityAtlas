<#
.SYNOPSIS
    Authenticated GET against the Omada REST API with retry and OData pagination.
#>

function Invoke-OmadaGetRequest {
    <#
    .SYNOPSIS
        GET a path relative to the Omada baseUrl.
    .DESCRIPTION
        Handles two cases transparently:
          OData  (Cloud)  — follows @odata.nextLink until exhausted
          Single response — returns as-is when nextLink is absent
        Numeric page-by-page walking is handled by Invoke-OmadaPagedRequest.
        Refreshes the session/token before each attempt.
    .OUTPUTS
        Array of records (from .value or the full response).
    #>
    [OutputType([System.Collections.Generic.List[object]])]
    param(
        [Parameter(Mandatory)] [string]$Path,
        [hashtable]$QueryParams = @{},
        [int]$PageSize  = 100,
        [int]$MaxRetries = 5,
        [string]$OverrideBaseUrl = ''  # use session BaseUrl when empty; pass Builtin URL for CalculatedAssignments
    )

    if ($null -eq $script:OmadaSession) { throw "Omada: not connected. Call Connect-OmadaAPI first." }

    $base = if ($OverrideBaseUrl) { $OverrideBaseUrl.TrimEnd('/') } else { $script:OmadaSession.BaseUrl }
    if (-not $base) { throw "Omada: session BaseUrl is empty — was Connect-OmadaAPI called successfully?" }

    # Build initial URI
    $startUri = "$base$Path"
    if ($QueryParams.Count -gt 0) {
        $qs = ($QueryParams.GetEnumerator() |
               ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString([string]$_.Value))" }) -join '&'
        $startUri = "$startUri?$qs"
    }

    $collected = [System.Collections.Generic.List[object]]::new()
    $nextUri   = $startUri

    while ($nextUri) {
        Update-OmadaSessionIfExpired

        $reqParams = @{ Uri = $nextUri; Method = 'Get'; ErrorAction = 'Stop' }
        switch ($script:OmadaSession.AuthMethod) {
            { $_ -in 'OAuth2CC','OAuth2ROPC','ApiToken' } {
                $reqParams['Headers'] = @{ Authorization = "Bearer $($script:OmadaSession.AccessToken)" }
            }
            { $_ -in 'FormCookie','CookieString' } {
                $reqParams['WebSession'] = $script:OmadaSession.WebSession
            }
            'BasicAuth' {
                $reqParams['Headers'] = @{ Authorization = $script:OmadaSession.BasicAuthHeader }
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

                if ($status -in @(401, 403) -and $script:OmadaSession.AuthMethod -eq 'CookieString') {
                    throw "Omada cookie has expired. Retrieve a new cookie and update the crawler config."
                }

                $retryAfter = 0
                try {
                    $raHeader = $_.Exception.Response.Headers.GetValues('Retry-After')
                    if ($raHeader) { $retryAfter = [int]($raHeader | Select-Object -First 1) }
                } catch {}

                $isTransient = ($null -eq $status) -or ($status -eq 429) -or ($status -ge 500 -and $status -le 504)
                if (-not $isTransient -or $attempt -ge $MaxRetries) {
                    throw "Omada GET $nextUri failed (HTTP $status): $($_.Exception.Message)"
                }

                $wait = if ($retryAfter -gt 0) { $retryAfter } else { $delays[$attempt] }
                Write-Host "  Omada: retrying in ${wait}s (HTTP $status, attempt $($attempt+1)/$MaxRetries)..." -ForegroundColor Yellow
                Start-Sleep -Seconds $wait
                $attempt++
                Update-OmadaSessionIfExpired
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

        # Follow OData nextLink; stop otherwise (numeric paging is Invoke-OmadaPagedRequest's job)
        $nextUri = $resp.'@odata.nextLink'
    }

    return $collected
}
