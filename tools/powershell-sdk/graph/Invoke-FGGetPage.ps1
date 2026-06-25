function Invoke-FGGetPage {
    # Private helper: fetches one Graph API page with retry/throttle logic.
    # Callers own the pagination loop; this function handles one URI and returns
    # the raw result object. On transient errors it retries with back-off and
    # honours the Retry-After header on 429 responses.
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$URI,
        [int]$MaxRetries = 4,
        [int]$TimeoutSec = 0,
        [string]$CallerName = 'Invoke-FGGetPage',
        [int[]]$RetryDelays = @(3, 10, 30, 60, 120, 180)
    )

    Update-FGAccessTokenIfExpired -DebugFlag 'G'
    $AccessToken = $Global:AccessToken

    $retryCount = 0
    $success = $false
    $result = $null

    while (-not $success -and $retryCount -le $MaxRetries) {
        try {
            $rmParams = @{
                Method  = 'Get'
                Uri     = $URI
                Headers = @{ "Authorization" = "Bearer $AccessToken" }
            }
            if ($TimeoutSec -gt 0) { $rmParams['TimeoutSec'] = $TimeoutSec }
            $result = Invoke-RestMethod @rmParams
            $success = $true
        }
        catch {
            $statusCode = $null
            if ($_.Exception.Response) {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }
            $errorMsg = $_.Exception.Message
            $isTransientError = $statusCode -in @(429, 500, 502, 503, 504) -or $errorMsg -match 'UnknownError|ServiceNotAvailable|GatewayTimeout'

            if ($isTransientError -and $retryCount -lt $MaxRetries) {
                $retryCount++
                $waitTime = $RetryDelays[$retryCount - 1]
                if ($statusCode -eq 429 -and $_.Exception.Response.Headers) {
                    try {
                        $retryAfter = $_.Exception.Response.Headers |
                            Where-Object { $_.Key -eq 'Retry-After' } |
                            Select-Object -ExpandProperty Value -First 1
                        if ($retryAfter -and [int]::TryParse($retryAfter, [ref]$null)) {
                            $waitTime = [math]::Max([int]$retryAfter, $waitTime)
                        }
                    }
                    catch { }
                }
                Write-Warning "[$CallerName] Transient error (Status: $statusCode). Retry $retryCount/$MaxRetries after ${waitTime}s..."
                Start-Sleep -Seconds $waitTime
                Update-FGAccessTokenIfExpired -DebugFlag 'G'
                $AccessToken = $Global:AccessToken
            }
            else {
                if ($retryCount -gt 0) {
                    Write-Warning "[$CallerName] Failed after $retryCount retry attempt(s)"
                }
                throw
            }
        }
    }

    return $result
}
