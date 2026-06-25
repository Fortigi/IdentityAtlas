function Invoke-FGGetRequest {
    [alias("Invoke-GetRequest")]
    [cmdletbinding()]
    Param(
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

    # Extract resource name from URI for progress display
    $resourceName = "Graph API data"
    if ($URI -match '/([^/\?]+)(\?|$)') {
        $resourceName = $matches[1]
    }

    $ReturnValue = $null
    $pageCount = 0
    $startTime = Get-Date

    $pageCount++
    $Result = Invoke-FGGetPage -URI $URI -MaxRetries $MaxRetries -TimeoutSec $TimeoutSec -CallerName 'Invoke-FGGetRequest'

    if ($Result.PSobject.Properties.name -match "value") {
        $ReturnValue = $Result.value
    }
    else {
        $ReturnValue = $Result
    }

    $showProgress = $Result.'@odata.nextLink'

    While ($Result.'@odata.nextLink') {
        $pageCount++
        $nextLink = $Result.'@odata.nextLink'

        $Result = Invoke-FGGetPage -URI $nextLink -MaxRetries $MaxRetries -TimeoutSec $TimeoutSec -CallerName "Invoke-FGGetRequest page $pageCount"

        $ReturnValue += $Result.value

        if ($showProgress) {
            $elapsed = (Get-Date) - $startTime
            $rate = if ($elapsed.TotalSeconds -gt 0) { [math]::Round($ReturnValue.Count / $elapsed.TotalSeconds, 1) } else { 0 }
            Write-Progress -Activity "Fetching $resourceName" `
                -Status "Page $pageCount - $($ReturnValue.Count) items ($rate items/sec)" `
                -PercentComplete -1
        }
    }

    if ($showProgress) {
        Write-Progress -Activity "Fetching $resourceName" -Completed
    }

    return $ReturnValue
}
