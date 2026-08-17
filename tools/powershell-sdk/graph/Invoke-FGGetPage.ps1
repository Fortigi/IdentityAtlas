function Get-FGResponseStatusCode {
    # Private helper: pulls the numeric HTTP status code off a caught exception,
    # or $null when the exception carries no HTTP response.
    [cmdletbinding()]
    Param([Parameter(Mandatory = $true)]$Exception)

    if ($Exception.Response) { return [int]$Exception.Response.StatusCode }
    return $null
}

function Test-FGTransientError {
    # Private helper: decides whether a failed request should be retried, based on
    # the HTTP status code and/or a well-known transient error message.
    #
    # The first clause used to be the whole rule, which meant a request that never
    # got an answer at all — DNS failure, connection reset, TLS error — was retried
    # only if its message happened to contain one of the three Graph fault strings
    # below. Otherwise it was treated as permanent. The crawler layer carried the
    # identical defect on its Graph delta path.
    #
    # This mirrors Test-TransientHttpStatus in tools/crawlers/shared/, but does not
    # call it: the SDK is a separate root loaded by setup/IdentityAtlas.psm1 and its
    # unit tests load SDK files alone, so a cross-root dependency would resolve at
    # runtime and fail under test. Keep the two in step by hand — the shared one is
    # the reference.
    [cmdletbinding()]
    Param(
        $StatusCode,
        [string]$ErrorMessage
    )

    if (-not $StatusCode) { return $true }
    return ($StatusCode -in @(429, 500, 502, 503, 504)) -or
    ($ErrorMessage -match 'UnknownError|ServiceNotAvailable|GatewayTimeout')
}

function Get-FGRetryAfterWait {
    # Private helper: returns the back-off wait in seconds, honouring a Retry-After
    # header on 429 responses. Falls back to $DefaultWait when the header is absent
    # or unparseable.
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]$Exception,
        $StatusCode,
        [int]$DefaultWait
    )

    if ($StatusCode -ne 429 -or -not $Exception.Response.Headers) { return $DefaultWait }

    try {
        $retryAfter = $Exception.Response.Headers |
            Where-Object { $_.Key -eq 'Retry-After' } |
            Select-Object -ExpandProperty Value -First 1
        if ($retryAfter -and [int]::TryParse($retryAfter, [ref]$null)) {
            return [math]::Max([int]$retryAfter, $DefaultWait)
        }
    }
    catch { }

    return $DefaultWait
}

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

    while ($true) {
        try {
            $rmParams = @{
                Method  = 'Get'
                Uri     = $URI
                Headers = @{ "Authorization" = "Bearer $AccessToken" }
            }
            if ($TimeoutSec -gt 0) { $rmParams['TimeoutSec'] = $TimeoutSec }
            return Invoke-RestMethod @rmParams
        }
        catch {
            $statusCode = Get-FGResponseStatusCode -Exception $_.Exception
            $isTransientError = Test-FGTransientError -StatusCode $statusCode -ErrorMessage $_.Exception.Message

            if (-not ($isTransientError -and $retryCount -lt $MaxRetries)) {
                if ($retryCount -gt 0) {
                    Write-Warning "[$CallerName] Failed after $retryCount retry attempt(s)"
                }
                throw
            }

            $retryCount++
            $waitTime = Get-FGRetryAfterWait -Exception $_.Exception -StatusCode $statusCode -DefaultWait $RetryDelays[$retryCount - 1]
            Write-Warning "[$CallerName] Transient error (Status: $statusCode). Retry $retryCount/$MaxRetries after ${waitTime}s..."
            Start-Sleep -Seconds $waitTime
            Update-FGAccessTokenIfExpired -DebugFlag 'G'
            $AccessToken = $Global:AccessToken
        }
    }
}
