function Invoke-FGGetRequestStream {
    <#
    .SYNOPSIS
        Streaming version of Invoke-FGGetRequest. Emits each Graph result item
        to the PowerShell pipeline as pages are fetched, instead of
        accumulating the whole paginated result set into one array.

    .DESCRIPTION
        The default Invoke-FGGetRequest builds the entire result array before
        returning. On real tenants that's the dominant memory cost of the
        crawler — a busy /auditLogs/signIns slice can be 30k+ events with
        deeply nested properties, and 7 daily slices multiply that by 7. We've
        seen this OOM the worker on the 2-CPU/4-GiB ACA cap.

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

        Retry/auth/throttling behaviour is delegated to Invoke-FGGetPage —
        same Update-FGAccessTokenIfExpired call, same retryDelays array, same
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

    $nextLink = $URI
    $pageCount = 0

    while ($nextLink) {
        $pageCount++

        $result = Invoke-FGGetPage -URI $nextLink -MaxRetries $MaxRetries -TimeoutSec $TimeoutSec `
            -CallerName "Invoke-FGGetRequestStream page $pageCount"

        # Emit this page's items individually so the pipeline can process
        # them before we fetch the next page.
        if ($result.PSObject.Properties.Name -contains 'value' -and $null -ne $result.value) {
            foreach ($item in $result.value) { Write-Output $item }
        }
        else {
            Write-Output $result
        }

        $nextLink = $result.'@odata.nextLink'
        $result = $null
    }
}
