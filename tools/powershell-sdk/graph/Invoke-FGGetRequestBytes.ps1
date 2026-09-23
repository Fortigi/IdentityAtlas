function ConvertTo-FGResponseBytes {
    # Private helper: normalise a web response body to byte[], or $null when
    # there is nothing in it.
    #
    # PowerShell 7 hands back byte[] directly; 5.1 can return a string for a
    # content type it believes is text, which would otherwise be stored as the
    # characters of the image rather than the image. ISO-8859-1 is the
    # byte-preserving round trip for that case (every byte maps to one char).
    #
    # Split out of Invoke-FGGetRequestBytes so that function stays under the
    # cognitive-complexity ceiling: its retry loop already nests a try/catch
    # inside a while, and these branches sat two levels deeper again.
    [cmdletbinding()]
    Param($Content)

    if ($null -eq $Content -or $Content.Length -eq 0) { return $null }
    if ($Content -is [byte[]]) { return $Content }
    return [System.Text.Encoding]::GetEncoding('ISO-8859-1').GetBytes([string]$Content)
}

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
            return ConvertTo-FGResponseBytes -Content $response.Content
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
