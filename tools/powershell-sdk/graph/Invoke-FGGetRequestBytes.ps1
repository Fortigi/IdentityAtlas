function Invoke-FGGetRequestBytes {
    <#
    .SYNOPSIS
        Binary GET against Graph — returns the raw response bytes.

    .DESCRIPTION
        Every other Invoke-FGGetRequest* helper goes through Invoke-FGGetPage,
        which calls Invoke-RestMethod and therefore parses the body as JSON.
        That is wrong for the handful of Graph endpoints that return a media
        stream rather than a document — `/users/{id}/photos/{size}/$value`
        being the one the crawler needs.

        This helper is the binary sibling: same auth, same token refresh, same
        transient-error/Retry-After back-off as Invoke-FGGetPage (it reuses
        that file's private helpers), but it issues Invoke-WebRequest and hands
        back `byte[]`.

        There is no pagination: a media response is a single body.

    .PARAMETER URI
        The Graph URI to fetch.

    .PARAMETER MaxRetries
        Transient-error retries. Default 4, matching Invoke-FGGetRequest.

    .PARAMETER TimeoutSec
        Per-request timeout. 0 (default) uses the PowerShell default.

    .OUTPUTS
        [byte[]] on success. Throws on a non-transient failure (including 404),
        which callers are expected to catch — "this user has no photo" is a
        404 and is a normal, expected outcome, not an error condition.

    .NOTES
        Returns $null for a 200 with an empty body. Graph does this for some
        unlicensed accounts instead of a clean 404.
    #>
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$URI,
        [int]$MaxRetries = 4,
        [int]$TimeoutSec = 0,
        [int[]]$RetryDelays = @(3, 10, 30, 60, 120, 180)
    )

    Update-FGAccessTokenIfExpired -DebugFlag 'G'
    $AccessToken = $Global:AccessToken

    $retryCount = 0

    while ($true) {
        try {
            $iwrParams = @{
                Method  = 'Get'
                Uri     = $URI
                Headers = @{ "Authorization" = "Bearer $AccessToken" }
                # Without this, PowerShell 5.1 parses the response into an
                # HtmlWebResponseObject and can mangle the byte content.
                UseBasicParsing = $true
            }
            if ($TimeoutSec -gt 0) { $iwrParams['TimeoutSec'] = $TimeoutSec }

            $response = Invoke-WebRequest @iwrParams
            $content = $response.Content
            if ($null -eq $content -or $content.Length -eq 0) { return $null }

            # PS 7 gives byte[] directly; PS 5.1 can hand back a string for
            # content types it believes are text. Normalise to bytes.
            if ($content -is [byte[]]) { return $content }
            return [System.Text.Encoding]::GetEncoding('ISO-8859-1').GetBytes([string]$content)
        }
        catch {
            $statusCode = Get-FGResponseStatusCode -Exception $_.Exception
            $isTransientError = Test-FGTransientError -StatusCode $statusCode -ErrorMessage $_.Exception.Message

            if (-not ($isTransientError -and $retryCount -lt $MaxRetries)) {
                if ($retryCount -gt 0) {
                    Write-Warning "[Invoke-FGGetRequestBytes] Failed after $retryCount retry attempt(s)"
                }
                throw
            }

            $retryCount++
            $waitTime = Get-FGRetryAfterWait -Exception $_.Exception -StatusCode $statusCode -DefaultWait $RetryDelays[$retryCount - 1]
            Write-Warning "[Invoke-FGGetRequestBytes] Transient error (Status: $statusCode). Retry $retryCount/$MaxRetries after ${waitTime}s..."
            Start-Sleep -Seconds $waitTime
            Update-FGAccessTokenIfExpired -DebugFlag 'G'
            $AccessToken = $Global:AccessToken
        }
    }
}
