function Invoke-FGGetRequest {
    [alias("Invoke-GetRequest")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$URI,

        # Per-call overrides so callers can make tight-loop endpoints fail
        # fast without deoptimising the default for long paginated fetches.
        # The governance resource-scopes phase calls this helper once per
        # access package (~500 calls) and wraps each call in its own skip-on-
        # failure catch — so it passes -MaxRetries 1 -TimeoutSec 30 to cap
        # any single AP at ~30s.
        [int]$MaxRetries = 4,
        [int]$TimeoutSec = 0
    )

    If (!($Global:AccessToken)) {
        Throw "No Access Token found. Please run Get-AccessToken or Get-AccessTokenInteractive before running this function."
    }

    If ($Global:DebugMode) {
        If ($Global:DebugMode.Contains('G')) {
            Write-Host "++++++++++++++++++++++++++++++++++++++++++++++++ Debug Message ++++++++++++++++++++++++++++++++++++++++++++++++++++++++" -ForegroundColor Blue
            Write-Host "Invoke-FGGetRequest" -ForegroundColor Blue
            Write-Host $URI -ForegroundColor Blue
        }
    }

    #Check if Access token is expired, if so get new one.
    Update-FGAccessTokenIfExpired -DebugFlag 'G'

    # Get the current (potentially refreshed) access token
    $AccessToken = $Global:AccessToken

    # Extract resource name from URI for progress display
    $resourceName = "Graph API data"
    if ($URI -match '/([^/\?]+)(\?|$)') {
        $resourceName = $matches[1]
    }

    $ReturnValue = $Null
    $pageCount = 0
    $startTime = Get-Date

    # Retry settings for transient Graph API errors. $MaxRetries is now a
    # parameter; tight-loop callers (per-AP scope fetches) pass 1 so one bad
    # call doesn't stall a 500-item loop. Default covers a 504 burst from
    # the entitlement-management upstream (typically recovers in 30–60s).
    $maxRetries  = $MaxRetries
    $retryDelays = @(3, 10, 30, 60, 120, 180)  # used up to $maxRetries

    $pageCount++
    $Result = $null
    $retryCount = 0
    $success = $false

    while (-not $success -and $retryCount -le $maxRetries) {
        try {
            $rmParams = @{
                Method = 'Get'
                Uri    = $URI
                Headers = @{"Authorization" = "Bearer $AccessToken" }
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

            # Also detect transient errors by message content (e.g. "UnknownError" returns vary)
            $errorMsg = $_.Exception.Message
            $isTransientError = $statusCode -in @(429, 500, 502, 503, 504) -or $errorMsg -match 'UnknownError|ServiceNotAvailable|GatewayTimeout'

            if ($isTransientError -and $retryCount -lt $maxRetries) {
                $retryCount++

                # Respect Retry-After header for 429 (throttling)
                $waitTime = $retryDelays[$retryCount - 1]
                if ($statusCode -eq 429 -and $_.Exception.Response.Headers) {
                    try {
                        $retryAfter = $_.Exception.Response.Headers | Where-Object { $_.Key -eq 'Retry-After' } | Select-Object -ExpandProperty Value -First 1
                        if ($retryAfter -and [int]::TryParse($retryAfter, [ref]$null)) {
                            $waitTime = [math]::Max([int]$retryAfter, $waitTime)
                        }
                    } catch { }
                }

                Write-Warning "[Invoke-FGGetRequest] Transient error (Status: $statusCode). Retry $retryCount/$maxRetries after ${waitTime}s..."
                Start-Sleep -Seconds $waitTime

                # Refresh token before retry in case it expired
                Update-FGAccessTokenIfExpired -DebugFlag 'G'
                $AccessToken = $Global:AccessToken
            }
            else {
                # Non-transient error or max retries exhausted
                if ($retryCount -gt 0) {
                    Write-Warning "[Invoke-FGGetRequest] Failed after $retryCount retry attempt(s)"
                }
                Throw $_
            }
        }
    }

    #Most get requests will return results in .value but not all.. grr... watch out.. having the propery .value doesn't mean it has a value
    if ($Result.PSobject.Properties.name -match "value") {
        $ReturnValue = $Result.value
    }
    else {
        $ReturnValue = $Result
    }

    # Show progress if there are multiple pages (nextLink exists)
    $showProgress = $Result.'@odata.nextLink'

    #By default you only get 100 results... its paged
    While ($Result.'@odata.nextLink') {
        # Check token validity before fetching next page (token may expire during long pagination)
        Update-FGAccessTokenIfExpired -DebugFlag 'G'
        $AccessToken = $Global:AccessToken

        $pageCount++
        $nextLink = $Result.'@odata.nextLink'
        $Result = $null
        $retryCount = 0
        $success = $false

        while (-not $success -and $retryCount -le $maxRetries) {
            try {
                $rmParams = @{
                    Method = 'Get'
                    Uri    = $nextLink
                    Headers = @{"Authorization" = "Bearer $AccessToken" }
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

                $errorMsg = $_.Exception.Message
                $isTransientError = $statusCode -in @(429, 500, 502, 503, 504) -or $errorMsg -match 'UnknownError|ServiceNotAvailable|GatewayTimeout'

                if ($isTransientError -and $retryCount -lt $maxRetries) {
                    $retryCount++
                    $waitTime = $retryDelays[$retryCount - 1]
                    if ($statusCode -eq 429 -and $_.Exception.Response.Headers) {
                        try {
                            $retryAfter = $_.Exception.Response.Headers | Where-Object { $_.Key -eq 'Retry-After' } | Select-Object -ExpandProperty Value -First 1
                            if ($retryAfter -and [int]::TryParse($retryAfter, [ref]$null)) {
                                $waitTime = [math]::Max([int]$retryAfter, $waitTime)
                            }
                        } catch { }
                    }

                    Write-Warning "[Invoke-FGGetRequest] Page ${pageCount}: Transient error (Status: $statusCode). Retry $retryCount/$maxRetries after ${waitTime}s..."
                    Start-Sleep -Seconds $waitTime

                    Update-FGAccessTokenIfExpired -DebugFlag 'G'
                    $AccessToken = $Global:AccessToken
                }
                else {
                    if ($retryCount -gt 0) {
                        Write-Warning "[Invoke-FGGetRequest] Page ${pageCount}: Failed after $retryCount retry attempt(s)"
                    }
                    Throw $_
                }
            }
        }

        $ReturnValue += $Result.value

        # Update progress
        if ($showProgress) {
            $elapsed = (Get-Date) - $startTime
            $rate = if ($elapsed.TotalSeconds -gt 0) { [math]::Round($ReturnValue.Count / $elapsed.TotalSeconds, 1) } else { 0 }
            Write-Progress -Activity "Fetching $resourceName" `
                -Status "Page $pageCount - $($ReturnValue.Count) items ($rate items/sec)" `
                -PercentComplete -1
        }
    }

    # Clear progress if it was shown
    if ($showProgress) {
        Write-Progress -Activity "Fetching $resourceName" -Completed
    }

    return $ReturnValue
}