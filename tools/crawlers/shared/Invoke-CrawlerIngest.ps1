<#
.SYNOPSIS
    Shared ingest helpers used by all Identity Atlas crawlers.
.DESCRIPTION
    Invoke-IngestAPI     — POST to the Ingest API with retry and exponential backoff.
    Update-CrawlerProgress — Report job progress; throws on HTTP 409 (job terminated).
    ConvertTo-JsonArray  — Wrap a collection in List[object] so it always serialises
                           as a JSON array regardless of element count.

    These functions reference $ApiBaseUrl, $ApiKey, and $JobId from the calling
    crawler's script scope. Dot-source this file from the crawler entry point:

        . (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
#>

#region Functions

function Invoke-IngestAPI {
    [CmdletBinding()]
    param(
        [string]$Endpoint,
        [hashtable]$Body
    )

    $headers     = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    $json        = $Body | ConvertTo-Json -Depth 20 -Compress
    $uri         = "$ApiBaseUrl/$Endpoint"
    $maxAttempts = 5
    $attempt     = 0

    while ($true) {
        $attempt++
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $json -TimeoutSec 300
            if ($attempt -gt 1) { Write-Host "  Recovered on attempt $attempt" -ForegroundColor Green }
            return $response
        } catch {
            $statusCode   = $null
            $responseBody = $null
            try {
                $statusCode = $_.Exception.Response.StatusCode.value__
                # PS7 drains the response stream before the exception bubbles up, so the body
                # is in ErrorDetails.Message. Fall back to the stream for older engines.
                if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                    $responseBody = $_.ErrorDetails.Message
                } else {
                    $stream = $_.Exception.Response.GetResponseStream()
                    if ($stream) {
                        $reader       = [System.IO.StreamReader]::new($stream)
                        $responseBody = $reader.ReadToEnd()
                        $reader.Close()
                    }
                }
            } catch {}

            $isTransient = (-not $statusCode) -or ($statusCode -ge 500) -or ($statusCode -eq 429)

            if ($isTransient -and $attempt -lt $maxAttempts) {
                $delay  = [Math]::Pow(2, $attempt)  # 2, 4, 8, 16, 32 seconds
                $reason = if ($statusCode) { "HTTP $statusCode" } else { $_.Exception.Message }
                Write-Host "  Transient failure on $Endpoint ($reason) — retry $attempt/$($maxAttempts - 1) in ${delay}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
                continue
            }

            $payloadMB = [Math]::Round($json.Length / 1MB, 2)
            Write-Host "  ERROR: $Endpoint returned $statusCode after $attempt attempt(s) (payload: ${payloadMB} MB)" -ForegroundColor Red
            if ($responseBody) {
                Write-Host "  Response: $responseBody" -ForegroundColor Yellow
            } else {
                Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
            }
            throw
        }
    }
}

function Update-CrawlerProgress {
    [CmdletBinding()]
    param([string]$Step, [int]$Pct = -1, [string]$Detail = '')
    if (-not $JobId -or $JobId -le 0) { return }
    $body = @{ jobId = $JobId }
    if ($PSBoundParameters.ContainsKey('Step'))   { $body['step']   = $Step }
    if ($Pct -ge 0)                                { $body['pct']    = $Pct }
    if ($PSBoundParameters.ContainsKey('Detail')) { $body['detail'] = $Detail }
    try {
        $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post `
            -Headers $headers -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 10 | Out-Null
    } catch {
        $statusCode = $null
        try { $statusCode = $_.Exception.Response.StatusCode.value__ } catch {}
        if ($statusCode -eq 409) {
            # The job was terminated server-side (container restart, manual cancel). Propagate so
            # the dispatcher breaks out of the crawl and moves on to the next queued job.
            throw "Job $JobId terminated server-side (HTTP 409) — aborting crawl"
        }
        # Transient errors are non-fatal for progress reporting
    }
}

# Force a collection to always serialise as a JSON array — even when it contains
# exactly 0 or 1 items. PowerShell's ConvertTo-Json collapses a single-element
# array stored as a hashtable value into a bare object, which makes single-record
# delta batches fail at the server with "records must be an array". List[object]
# always round-trips as a JSON array regardless of count; the leading unary comma
# stops the pipeline from re-unwrapping the list back into individual items.
function ConvertTo-JsonArray {
    [CmdletBinding()]
    param([object]$Items)
    $list = [System.Collections.Generic.List[object]]::new()
    if ($null -ne $Items) {
        foreach ($it in @($Items)) { [void]$list.Add($it) }
    }
    return ,$list
}

#endregion Functions
