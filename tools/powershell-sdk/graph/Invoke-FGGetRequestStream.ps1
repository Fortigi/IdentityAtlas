function Invoke-FGGetRequestStream {
    <#
    .SYNOPSIS
        Streaming version of Invoke-FGGetRequest. Emits each Graph result item
        to the PowerShell pipeline as pages are fetched, instead of
        accumulating the whole paginated result set into one array.

    .DESCRIPTION
        The default Invoke-FGGetRequest builds the entire result array before
        returning (line ~181 in that file: `$ReturnValue += $Result.value`).
        On real tenants that's the dominant memory cost of the crawler — a
        busy /auditLogs/signIns slice can be 30k+ events with deeply nested
        properties, and 7 daily slices multiply that by 7. We've seen this
        OOM the worker on the 2-CPU/4-GiB ACA cap.

        This streaming variant emits each page's items via the pipeline
        (`Write-Output`) so callers can process-and-discard one page at a
        time. Peak memory bound becomes max(one page, aggregated state)
        instead of (all pages × all slices).

        IMPORTANT: only works as a memory optimisation when the caller
        consumes the result through the pipeline:

            Invoke-FGGetRequestStream -URI ... | ForEach-Object { ... }    # streams

        Assigning to a variable buffers everything and you're back where you
        started:

            $all = Invoke-FGGetRequestStream -URI ...                       # buffers

        Retry/auth/throttling behaviour matches Invoke-FGGetRequest — same
        Update-FGAccessTokenIfExpired call, same retryDelays array, same
        Retry-After honouring on 429.

    .PARAMETER URI
        The Graph URI to fetch. Standard Graph $top, $filter, $expand all work.

    .PARAMETER MaxRetries
        Transient-error retries per page. Default 4, matching Invoke-FGGetRequest.

    .PARAMETER TimeoutSec
        Per-request HTTP timeout. 0 = no override. Matches Invoke-FGGetRequest.
    #>
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$URI,

        [int]$MaxRetries = 4,
        [int]$TimeoutSec = 0
    )

    if (!($Global:AccessToken)) {
        throw "No Access Token found. Please run Get-AccessToken or Get-AccessTokenInteractive before running this function."
    }

    Update-FGAccessTokenIfExpired -DebugFlag 'G'
    $accessToken = $Global:AccessToken

    # Retry config — kept in sync with Invoke-FGGetRequest.
    $retryDelays = @(3, 10, 30, 60, 120, 180)

    $nextLink = $URI
    $pageCount = 0
    while ($nextLink) {
        $pageCount++

        # Token may have expired between pages on long crawls.
        Update-FGAccessTokenIfExpired -DebugFlag 'G'
        $accessToken = $Global:AccessToken

        $result = $null
        $retryCount = 0
        $success = $false

        while (-not $success -and $retryCount -le $MaxRetries) {
            try {
                $rmParams = @{
                    Method  = 'Get'
                    Uri     = $nextLink
                    Headers = @{ "Authorization" = "Bearer $accessToken" }
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
                    $waitTime = $retryDelays[$retryCount - 1]
                    if ($statusCode -eq 429 -and $_.Exception.Response.Headers) {
                        try {
                            $retryAfter = $_.Exception.Response.Headers | Where-Object { $_.Key -eq 'Retry-After' } | Select-Object -ExpandProperty Value -First 1
                            if ($retryAfter -and [int]::TryParse($retryAfter, [ref]$null)) {
                                $waitTime = [math]::Max([int]$retryAfter, $waitTime)
                            }
                        } catch { }
                    }
                    Write-Warning "[Invoke-FGGetRequestStream] Page ${pageCount}: Transient error (Status: $statusCode). Retry $retryCount/$MaxRetries after ${waitTime}s..."
                    Start-Sleep -Seconds $waitTime
                    Update-FGAccessTokenIfExpired -DebugFlag 'G'
                    $accessToken = $Global:AccessToken
                }
                else {
                    if ($retryCount -gt 0) {
                        Write-Warning "[Invoke-FGGetRequestStream] Page ${pageCount}: Failed after $retryCount retry attempt(s)"
                    }
                    throw
                }
            }
        }

        # Emit this page's items individually so the pipeline can process
        # them before we fetch the next page. Graph endpoints that wrap
        # their results in `.value` are the common case; a few return the
        # object directly without a `.value` wrapper.
        if ($result.PSObject.Properties.Name -contains 'value' -and $null -ne $result.value) {
            foreach ($item in $result.value) { Write-Output $item }
        } else {
            Write-Output $result
        }

        $nextLink = $result.'@odata.nextLink'

        # Drop the page object so the GC can collect it before the next page
        # arrives. (PowerShell's variable tracker holds the previous value
        # until the next assignment otherwise.)
        $result = $null
    }
}
