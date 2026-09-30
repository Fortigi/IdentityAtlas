<#
.SYNOPSIS
    Several ingest batches in flight at once: the crawler keeps reading and
    shaping while Identity Atlas stores what it already sent.

.DESCRIPTION
    A streamed crawler used to be strictly serial: shape a batch, POST it, wait
    for the database, shape the next. The source, the crawler and the database
    each sat idle while another worked — on a multi-core machine, most of it.

    A sender keeps up to -MaxInFlight POSTs outstanding (System.Net.Http, whose
    I/O runs off the PowerShell thread). Submitting a batch when the window is
    full first collects the OLDEST response, so the crawler never runs more than
    that far ahead of the API and memory stays at a few batches.

    Nothing about a batch changes: the same body, to the same endpoint, and a
    response is judged exactly as Invoke-IngestAPI judges one — a transient
    failure (no status, 429, 500/502/503/504) is retried in line through the
    same back-off loop (Invoke-FGIngestPost), anything else fails the job with
    the API's own message. Only the ORDER in which batches commit is no longer
    guaranteed, so a sender is only for batches that do not depend on each other
    — no foreign key between them, deterministic ids on both sides. See
    Get-SqlSlotStream for which ones the SQL crawler pipelines.

        New-CrawlerIngestSender         one per run
        Submit-CrawlerIngestRequest     queue one serialised batch
        Receive-CrawlerIngestResponse   collect the oldest response
        Wait-CrawlerIngestSender        collect every response still outstanding

    Reads $ApiBaseUrl / $ApiKey from the caller's scope, like Invoke-IngestAPI.
#>

#region Functions

function New-CrawlerIngestSender {
    [CmdletBinding()]
    param([int]$MaxInFlight = 3, [int]$TimeoutSec = 300)
    $client = [System.Net.Http.HttpClient]::new()
    # The same ceiling Invoke-IngestAPI gives one POST.
    $client.Timeout = [timespan]::FromSeconds($TimeoutSec)
    return [pscustomobject]@{
        Client      = $client
        MaxInFlight = [Math]::Max(1, $MaxInFlight)
        Pending     = [System.Collections.Generic.Queue[object]]::new()
        Sent        = 0
        Retried     = 0
    }
}

# Start one POST and return its task. The one place the network is touched, so
# the tests replace it.
function Start-CrawlerIngestRequest {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Sender, [Parameter(Mandatory)] [string]$Endpoint, [Parameter(Mandatory)] [string]$Json)
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$ApiBaseUrl/$Endpoint")
    $req.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $ApiKey)
    $req.Content = [System.Net.Http.StringContent]::new($Json, [System.Text.Encoding]::UTF8, 'application/json')
    return $Sender.Client.SendAsync($req)
}

# Queue one serialised batch. When the window is full the oldest response is
# collected first. Whenever THIS batch's response is collected, -OnResponse is
# called with it and -State — state rather than a closure, because a closure
# cannot see the crawler's functions and the callback runs long after the
# caller has returned.
function Submit-CrawlerIngestRequest {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Sender, [Parameter(Mandatory)] [string]$Endpoint, [Parameter(Mandatory)] [string]$Json,
          [scriptblock]$OnResponse, $State)
    while ($Sender.Pending.Count -ge $Sender.MaxInFlight) { Receive-CrawlerIngestResponse -Sender $Sender }
    $task = Start-CrawlerIngestRequest -Sender $Sender -Endpoint $Endpoint -Json $Json
    $Sender.Pending.Enqueue(@{ Task = $task; Endpoint = $Endpoint; Json = $Json; OnResponse = $OnResponse; State = $State })
    $Sender.Sent++
}

# Collect the oldest outstanding response: wait for it, judge it, hand the parsed
# body to its callback. Throws — failing the job — on a failure that is not
# transient, or one that is still failing after the in-line retries.
function Receive-CrawlerIngestResponse {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Sender)
    if ($Sender.Pending.Count -eq 0) { return }
    $p = $Sender.Pending.Dequeue()
    $answer = Get-CrawlerIngestAnswer -Task $p.Task
    if (-not $answer.Ok) {
        if (-not (Test-TransientHttpStatus $answer.Status)) {
            Write-FGIngestFailure -Endpoint $p.Endpoint -StatusCode $answer.Status -Attempt 1 -Json $p.Json -ResponseBody $answer.Body -ErrorRecord $answer.Error
            throw "$($p.Endpoint) returned HTTP $($answer.Status): $($answer.Body)"
        }
        $reason = if ($answer.Status) { "HTTP $($answer.Status)" } else { $answer.Body }
        Write-Host "  Transient failure on $($p.Endpoint) ($reason) — retrying in line" -ForegroundColor Yellow
        $Sender.Retried++
        $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $answer = @{ Ok = $true; Response = (Invoke-FGIngestPost -Endpoint $p.Endpoint -Headers $headers -Json $p.Json) }
    }
    if ($p.OnResponse) { & $p.OnResponse $answer.Response $p.State }
}

# What one finished request came back with, whether it succeeded or not.
# Ok/Response for a 2xx; Status/Body for an HTTP error; no Status and the
# message for a request that got no answer at all (connection refused, timeout).
function Get-CrawlerIngestAnswer {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Task)
    $resp = $null
    try {
        $resp = $Task.GetAwaiter().GetResult()
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $status = [int]$resp.StatusCode
        if ($resp.IsSuccessStatusCode) {
            $parsed = if ($body) { $body | ConvertFrom-Json } else { $null }
            return @{ Ok = $true; Response = $parsed }
        }
        return @{ Ok = $false; Status = $status; Body = $body; Error = $null }
    } catch {
        return @{ Ok = $false; Status = $null; Body = $_.Exception.GetBaseException().Message; Error = $_ }
    } finally {
        if ($resp) { $resp.Dispose() }
    }
}

# Collect every outstanding response. Called before anything that must see
# every batch committed: the end of a statement, the reconcile, the counts.
function Wait-CrawlerIngestSender {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Sender)
    while ($Sender.Pending.Count -gt 0) { Receive-CrawlerIngestResponse -Sender $Sender }
}

#endregion Functions
