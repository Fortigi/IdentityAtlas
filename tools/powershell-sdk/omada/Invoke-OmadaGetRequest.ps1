<#
.SYNOPSIS
    Authenticated GET against the Omada REST API with retry and auto-pagination.
#>

function Invoke-OmadaGetRequest {
    <#
    .SYNOPSIS
        GET a path relative to the Omada baseUrl, following pagination automatically.
    .DESCRIPTION
        Handles three pagination styles transparently:
          OData  (Cloud)  — follows @odata.nextLink
          Numeric (on-prem) — walks ?page=N&pageSize=<PageSize> until count < PageSize
          Single response — returns as-is when neither pattern is present
        Refreshes the session/token before each attempt.
    .OUTPUTS
        Array of records (from .value or the full response).
    #>
    [OutputType([System.Collections.Generic.List[object]])]
    param(
        [Parameter(Mandatory)] [string]$Path,
        [hashtable]$QueryParams = @{},
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )

    if ($null -eq $script:OmadaSession) { throw "Omada: not connected. Call Connect-OmadaAPI first." }

    $base    = $script:OmadaSession.BaseUrl
    $fullUri = "$base$Path"
    if ($QueryParams.Count -gt 0) {
        $qs = ($QueryParams.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString([string]$_.Value))" }) -join '&'
        $fullUri = "$fullUri?$qs"
    }

    $collected = [System.Collections.Generic.List[object]]::new()
    $uri       = $fullUri

    # Detect pagination style on first page, then follow through
    $paginationDetected = $false
    $useNumericPaging   = $false
    $page               = 1

    while ($uri) {
        Update-OmadaSessionIfExpired

        # Build common params
        $reqParams = @{
            Uri         = $uri
            Method      = 'Get'
            ErrorAction = 'Stop'
        }
        switch ($script:OmadaSession.AuthMethod) {
            { $_ -in 'OAuth2CC','OAuth2ROPC','ApiToken' } {
                $reqParams['Headers'] = @{ Authorization = "Bearer $($script:OmadaSession.AccessToken)" }
            }
            { $_ -in 'FormCookie','CookieString' } {
                $reqParams['WebSession'] = $script:OmadaSession.WebSession
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

                # 401/403 on CookieString — no recovery possible
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
                    throw "Omada GET $uri failed (HTTP $status): $($_.Exception.Message)"
                }

                $wait = if ($retryAfter -gt 0) { $retryAfter } else { $delays[$attempt] }
                Write-Host "  Omada: retrying in ${wait}s (HTTP $status, attempt $($attempt+1)/$MaxRetries)..." -ForegroundColor Yellow
                Start-Sleep -Seconds $wait
                $attempt++
                Update-OmadaSessionIfExpired
            }
        }
        if ($null -eq $resp) { break }

        # Detect pagination style on first response
        if (-not $paginationDetected) {
            $paginationDetected = $true
            if ($resp.PSObject.Properties.Name -contains '@odata.nextLink') {
                $useNumericPaging = $false
            } elseif ($null -ne $resp.totalCount -or $null -ne $resp.total) {
                $useNumericPaging = $true
            }
            # else: single response, no pagination
        }

        # Collect records
        if ($resp.PSObject.Properties.Name -contains 'value') {
            foreach ($r in $resp.value) { $collected.Add($r) }
        } elseif ($resp -is [array]) {
            foreach ($r in $resp) { $collected.Add($r) }
        } else {
            $collected.Add($resp)
        }

        # Advance to next page
        if (-not $useNumericPaging) {
            # OData: follow nextLink or stop
            $uri = $resp.'@odata.nextLink'
        } else {
            # Numeric: check if we got a full page; if so fetch next
            $count = if ($resp.PSObject.Properties.Name -contains 'value') { @($resp.value).Count }
                     elseif ($resp -is [array]) { $resp.Count }
                     else { 1 }
            if ($count -lt $PageSize) {
                $uri = $null  # last page
            } else {
                $page++
                # Rebuild URI with incremented page (preserve other query params)
                $baseQuery = $fullUri -replace '[?&]page=\d+', ''
                $sep = if ($baseQuery -contains '?') { '&' } else { '?' }
                $uri = "${baseQuery}${sep}page=${page}&pageSize=${PageSize}"
            }
        }
    }

    return $collected
}
