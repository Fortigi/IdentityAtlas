#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/shared/Invoke-CrawlerIngestPipeline.ps1 —
    several ingest batches in flight at once.

.DESCRIPTION
    The network is Start-CrawlerIngestRequest, mocked to hand back finished tasks
    carrying a response of our choosing. The assertions are about what the
    sender DECIDED: when it waits (only when the window is full, and for the
    oldest batch), what it does with each kind of answer (hand a success to its
    callback, retry a transient failure in line with the same body, fail the job
    on anything else), and that a stream using it still reports true totals.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngestStream.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngestPipeline.ps1')

    # A request that already finished with this status and body.
    function New-Answered {
        param([int]$Status, [string]$Body)
        $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$Status)
        $r.Content = [System.Net.Http.StringContent]::new($Body)
        return [System.Threading.Tasks.Task]::FromResult($r)
    }
    # A request that got no answer at all.
    function New-Unanswered {
        param([string]$Message)
        return [System.Threading.Tasks.Task]::FromException([System.Net.Http.HttpRequestException]::new($Message))
    }
}

Describe 'Submit-CrawlerIngestRequest — the window' {
    BeforeEach {
        Mock Write-Host { }
        $script:events = [System.Collections.Generic.List[string]]::new()
        Mock Start-CrawlerIngestRequest {
            $n = ($Json | ConvertFrom-Json).n
            $script:events.Add("start $n")
            New-Answered -Status 200 -Body "{""inserted"":$n}"
        }
        $script:onResponse = { param($Response, $State) $script:events.Add("done $($Response.inserted) for $State") }
    }

    It 'keeps at most MaxInFlight outstanding, collecting the OLDEST before starting another' {
        $s = New-CrawlerIngestSender -MaxInFlight 2
        1..3 | ForEach-Object { Submit-CrawlerIngestRequest -Sender $s -Endpoint 'ingest/x' -Json "{""n"":$_}" -OnResponse $script:onResponse -State "b$_" }
        @($script:events) | Should -Be @('start 1', 'start 2', 'done 1 for b1', 'start 3')
        $s.Pending.Count | Should -Be 2
        Wait-CrawlerIngestSender -Sender $s
        @($script:events) | Should -Be @('start 1', 'start 2', 'done 1 for b1', 'start 3', 'done 2 for b2', 'done 3 for b3')
        $s.Pending.Count | Should -Be 0
        $s.Sent | Should -Be 3
    }

    It 'with a window of one waits for every batch before the next — the old behaviour' {
        $s = New-CrawlerIngestSender -MaxInFlight 1
        1..2 | ForEach-Object { Submit-CrawlerIngestRequest -Sender $s -Endpoint 'ingest/x' -Json "{""n"":$_}" -OnResponse $script:onResponse -State "b$_" }
        @($script:events) | Should -Be @('start 1', 'done 1 for b1', 'start 2')
    }

    It 'treats a window below one as one' {
        (New-CrawlerIngestSender -MaxInFlight 0).MaxInFlight | Should -Be 1
    }
}

Describe 'Receive-CrawlerIngestResponse — judging an answer' {
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
        $script:got = [System.Collections.Generic.List[object]]::new()
        $script:cb = { param($Response, $State) $script:got.Add($Response) }
    }

    It 'fails the job on an error that is not transient, naming the status and the API''s message, and hands nothing on' {
        Mock Start-CrawlerIngestRequest { New-Answered -Status 400 -Body '{"error":"records must be an array"}' }
        $s = New-CrawlerIngestSender -MaxInFlight 4
        Submit-CrawlerIngestRequest -Sender $s -Endpoint 'ingest/resource-assignments' -Json '{}' -OnResponse $script:cb
        { Wait-CrawlerIngestSender -Sender $s } | Should -Throw '*ingest/resource-assignments returned HTTP 400*records must be an array*'
        $script:got.Count | Should -Be 0
    }

    It 'retries a transient status in line with the SAME body, and hands on the retry''s answer' {
        Mock Start-CrawlerIngestRequest { New-Answered -Status 503 -Body 'busy' }
        Mock Invoke-RestMethod { [pscustomobject]@{ inserted = 5 } }
        $s = New-CrawlerIngestSender -MaxInFlight 4
        Submit-CrawlerIngestRequest -Sender $s -Endpoint 'ingest/resource-assignments' -Json '{"records":[1]}' -OnResponse $script:cb
        Wait-CrawlerIngestSender -Sender $s
        $script:got[0].inserted | Should -Be 5
        $s.Retried | Should -Be 1
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter {
            $Uri -eq 'http://localhost:3001/api/ingest/resource-assignments' -and $Body -eq '{"records":[1]}' -and $Headers.Authorization -eq 'Bearer fgc_test'
        }
    }

    It 'retries a request that got no answer at all' {
        Mock Start-CrawlerIngestRequest { New-Unanswered -Message 'Connection refused' }
        Mock Invoke-RestMethod { [pscustomobject]@{ inserted = 1 } }
        $s = New-CrawlerIngestSender
        Submit-CrawlerIngestRequest -Sender $s -Endpoint 'ingest/x' -Json '{}' -OnResponse $script:cb
        Wait-CrawlerIngestSender -Sender $s
        $script:got[0].inserted | Should -Be 1
        Should -Invoke Invoke-RestMethod -Exactly 1
    }

    It 'fails when the in-line retry keeps failing, after its own attempts' {
        Mock Start-CrawlerIngestRequest { New-Answered -Status 502 -Body 'gateway' }
        Mock Invoke-RestMethod { throw [System.Exception]::new('still down') }
        $s = New-CrawlerIngestSender
        Submit-CrawlerIngestRequest -Sender $s -Endpoint 'ingest/x' -Json '{}' -OnResponse $script:cb
        { Wait-CrawlerIngestSender -Sender $s } | Should -Throw '*still down*'
        Should -Invoke Invoke-RestMethod -Exactly 5
        $script:got.Count | Should -Be 0
    }

    It 'accepts a success with an empty body' {
        Mock Start-CrawlerIngestRequest { New-Answered -Status 204 -Body '' }
        $s = New-CrawlerIngestSender
        $script:called = 0
        Submit-CrawlerIngestRequest -Sender $s -Endpoint 'ingest/x' -Json '{}' -OnResponse { param($Response) $script:called++; if ($null -ne $Response) { throw 'expected no body' } }
        Wait-CrawlerIngestSender -Sender $s
        $script:called | Should -Be 1
    }

    It 'does nothing when nothing is outstanding' {
        $s = New-CrawlerIngestSender
        { Receive-CrawlerIngestResponse -Sender $s } | Should -Not -Throw
    }
}

Describe 'A stream sending through a sender' {
    BeforeEach {
        Mock Write-Host { }
        $script:bodies = [System.Collections.Generic.List[object]]::new()
        Mock Start-CrawlerIngestRequest {
            $b = $Json | ConvertFrom-Json
            $script:bodies.Add($b)
            New-Answered -Status 200 -Body "{""inserted"":$(@($b.records).Count),""updated"":1}"
        }
    }

    It 'sends the same bodies as the direct path, and its totals count every answer once the stream completes' {
        $sender = New-CrawlerIngestSender -MaxInFlight 3
        $s = New-CrawlerIngestStream -Endpoint 'ingest/resource-assignments' -SystemId 12 -IdPrefix 'sql-1' -BatchSize 2 `
            -Scope @{ assignmentType = 'Direct' } -KeyFields @('resourceExternalId', 'principalExternalId') -Sender $sender
        1..5 | ForEach-Object { Add-CrawlerIngestStreamRecord -Stream $s -Record ([ordered]@{ resourceExternalId = "r$_"; principalExternalId = 'p' }) }
        # Two full batches are on their way; none has been waited for yet.
        $sender.Pending.Count | Should -Be 2
        $s.Inserted | Should -Be 0
        $t = Complete-CrawlerIngestStream -Stream $s
        $sender.Pending.Count | Should -Be 0
        $t.batches | Should -Be 3
        $t.inserted | Should -Be 5
        $t.updated | Should -Be 3
        $t.serializeTicks | Should -BeGreaterThan 0
        $b = $script:bodies[0]
        $b.systemId | Should -Be 12
        $b.syncMode | Should -Be 'delta'
        $b.idGeneration | Should -Be 'deterministic'
        $b.idPrefix | Should -Be 'sql-1-resource-assignments'
        $b.scope.assignmentType | Should -Be 'Direct'
        @($script:bodies | ForEach-Object { @($_.records).Count }) | Should -Be @(2, 2, 1)
        @($script:bodies | ForEach-Object { $_.records } | ForEach-Object resourceExternalId) | Should -Be @('r1', 'r2', 'r3', 'r4', 'r5')
    }

    It 'a single-record batch still goes out as a JSON array' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/x' -SystemId 1 -IdPrefix 'sql-1' -Sender (New-CrawlerIngestSender)
        Add-CrawlerIngestStreamRecord -Stream $s -Record @{ externalId = 'only' }
        Complete-CrawlerIngestStream -Stream $s | Out-Null
        @($script:bodies[0].records).Count | Should -Be 1
        $script:bodies[0].records.GetType().IsArray | Should -BeTrue
    }
}
