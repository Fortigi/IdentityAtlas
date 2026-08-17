#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the shared crawler ingest helpers.

.DESCRIPTION
    Tests Invoke-IngestAPI, Update-CrawlerProgress, and ConvertTo-JsonArray
    from tools/crawlers/shared/Invoke-CrawlerIngest.ps1.

    Validates scope-capture (functions read $ApiBaseUrl, $ApiKey, $JobId from
    caller scope), the HTTP 409 abort path, and ConvertTo-JsonArray's guarantee
    that output always serialises as a JSON array regardless of element count.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/CrawlerIngest.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

    # Set the scope variables the helpers depend on — mimics a crawler entry point
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test_key'
    $script:JobId      = 42

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')

    # Build the ETS-shaped exception Invoke-RestMethod raises for an HTTP error, so
    # Get-FGIngestErrorDetail can read .Exception.Response.StatusCode.value__.
    # Must live in BeforeAll, not at file scope: a function declared between
    # Describe blocks only exists during Pester's discovery pass, and would be
    # unresolvable inside a mock body at run time.
    function New-HttpError {
        param([int]$Status, [string]$Message = 'error')
        $resp = [PSCustomObject]@{ StatusCode = [PSCustomObject]@{ value__ = $Status } }
        $ex   = [System.Exception]::new($Message)
        $ex | Add-Member -NotePropertyName 'Response' -NotePropertyValue $resp -Force
        return $ex
    }
}

Describe 'ConvertTo-JsonArray' {

    It 'serialises to [] for null input' {
        $result = ConvertTo-JsonArray -Items $null
        $json = @{ r = $result } | ConvertTo-Json -Compress
        $json | Should -Be '{"r":[]}'
    }

    It 'serialises to [] for empty array' {
        $result = ConvertTo-JsonArray -Items @()
        $json = @{ r = $result } | ConvertTo-Json -Compress
        $json | Should -Be '{"r":[]}'
    }

    It 'serialises single item as array (not bare object)' {
        $result = ConvertTo-JsonArray -Items @(@{ id = 1 })
        $json = @{ r = $result } | ConvertTo-Json -Depth 5 -Compress
        $json | Should -Match '"r":\['
    }

    It 'preserves multiple items' {
        $result = ConvertTo-JsonArray -Items @(@{ id = 1 }, @{ id = 2 })
        $result.Count | Should -Be 2
        $json = @{ r = $result } | ConvertTo-Json -Depth 5 -Compress
        $json | Should -Match '"r":\['
    }

    It 'wraps a scalar in a single-element array' {
        $result = ConvertTo-JsonArray -Items 'hello'
        $result.Count | Should -Be 1
    }

    It 'does not double-wrap a List[object] (param is [object[]])' {
        $list = [System.Collections.Generic.List[object]]::new()
        $list.Add(@{ id = 1 })
        $list.Add(@{ id = 2 })
        $result = ConvertTo-JsonArray -Items $list
        $result.Count | Should -Be 2
        $json = @{ r = $result } | ConvertTo-Json -Depth 5 -Compress
        $json | Should -Match '"r":\['
        $json | Should -Not -Match '"r":\[\['  # must NOT be a double-wrapped array
    }
}

Describe 'Update-CrawlerProgress — scope and no-op' {

    It 'is a no-op when JobId is 0 (no HTTP call)' {
        $script:JobId = 0
        Mock Invoke-RestMethod { throw 'should not be called' }
        { Update-CrawlerProgress -Step 'test' -Pct 10 } | Should -Not -Throw
        Should -Invoke Invoke-RestMethod -Times 0
        $script:JobId = 42
    }

    It 'is a no-op when JobId is negative (no HTTP call)' {
        $script:JobId = -1
        Mock Invoke-RestMethod { throw 'should not be called' }
        { Update-CrawlerProgress -Step 'test' } | Should -Not -Throw
        Should -Invoke Invoke-RestMethod -Times 0
        $script:JobId = 42
    }

    It 'reads JobId from caller scope and calls job-progress endpoint' {
        $script:JobId = 99
        Mock Invoke-RestMethod { return @{} } -Verifiable
        Update-CrawlerProgress -Step 'scoped' -Pct 5
        Should -Invoke Invoke-RestMethod -Times 1
        $script:JobId = 42
    }
}

Describe 'Update-CrawlerProgress — HTTP 409 abort' {

    It 'throws "terminated server-side" when the API returns HTTP 409' {
        $script:JobId = 42
        # Build a fake exception with .Response.StatusCode.value__ = 409
        # using the PowerShell Extended Type System (ETS) — this is how the
        # function reads the status code from a caught WebException.
        Mock Invoke-RestMethod -MockWith {
            $sc   = [PSCustomObject]@{ value__ = 409 }
            $resp = [PSCustomObject]@{ StatusCode = $sc }
            $ex   = [System.Exception]::new('Conflict')
            $ex | Add-Member -NotePropertyName 'Response' -NotePropertyValue $resp -Force
            throw $ex
        }
        { Update-CrawlerProgress -Step 'test' -Pct 50 } | Should -Throw '*terminated server-side*'
    }

    It 'does NOT throw when a transient error (not 409) occurs' {
        $script:JobId = 42
        # A plain exception (no Response property) should be swallowed
        Mock Invoke-RestMethod { throw [System.Exception]::new('Service unavailable') }
        { Update-CrawlerProgress -Step 'test' -Pct 50 } | Should -Not -Throw
    }
}

Describe 'Invoke-IngestAPI — error handling and payload serialisation' {

    It 'throws (does not swallow) on HTTP 400, without retrying — 400 is non-transient' {
        Mock Invoke-RestMethod -MockWith {
            $sc   = [PSCustomObject]@{ value__ = 400 }
            $resp = [PSCustomObject]@{ StatusCode = $sc }
            $ex   = [System.Exception]::new('Bad Request')
            $ex | Add-Member -NotePropertyName 'Response' -NotePropertyValue $resp -Force
            throw $ex
        }
        { Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } } | Should -Throw
        # -Exactly matters: bare -Times is an "at least" assertion, so without it
        # this passes even if a 400 were retried the full five times.
        Should -Invoke Invoke-RestMethod -Exactly 1
    }

    It 'retries a transient 503, then re-throws after exhausting all attempts' {
        # statusCode >= 500 is transient → retried up to maxAttempts (5).
        Mock Start-Sleep { }   # skip the real exponential backoff
        Mock Invoke-RestMethod -MockWith {
            $sc   = [PSCustomObject]@{ value__ = 503 }
            $resp = [PSCustomObject]@{ StatusCode = $sc }
            $ex   = [System.Exception]::new('Service Unavailable')
            $ex | Add-Member -NotePropertyName 'Response' -NotePropertyValue $resp -Force
            throw $ex
        }
        { Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } } | Should -Throw
        Should -Invoke Invoke-RestMethod -Exactly 5
    }

    It 'serialises records with null fields cleanly (null preserved, valid JSON)' {
        $items  = @(@{ id = 1; name = $null; email = $null })
        $result = ConvertTo-JsonArray -Items $items
        $json   = @{ records = $result } | ConvertTo-Json -Depth 5 -Compress
        $json | Should -Match '"name":null'
    }

    It 'preserves duplicate-id records (no client-side dedup; the server upserts)' {
        $items  = @(@{ id = 'dup' }, @{ id = 'dup' }, @{ id = 'other' })
        $result = ConvertTo-JsonArray -Items $items
        $result.Count | Should -Be 3
    }
}

# ── Retry policy ─────────────────────────────────────────────────────────────
# Which HTTP statuses are retried, how many times, and how long we wait between
# attempts is the crawler's whole resilience contract against Graph throttling.
# Line coverage alone can't tell a correct predicate from an inverted one here —
# every attempt count below is asserted with -Exactly for that reason.

# ── The one shared transient rule ────────────────────────────────────────────
# Five crawlers used to carry five different versions of this predicate. They
# disagreed on 501/505 (retried by four of them, always futilely), on the upper
# 5xx range, and — on the Graph delta path — on whether a transport failure with
# no HTTP status was retryable at all. Test-TransientHttpStatus is now the single
# definition; these cases are the contract every caller inherits.
Describe 'Test-TransientHttpStatus' {

    It 'retries a transport failure that produced no status at all' {
        # DNS failure, connection reset, TLS error — the request never got an
        # answer, so it is always worth another attempt.
        Test-TransientHttpStatus $null | Should -BeTrue
        Test-TransientHttpStatus 0     | Should -BeTrue
        Test-TransientHttpStatus ''    | Should -BeTrue
    }

    It 'retries HTTP <_>' -ForEach @(429, 500, 502, 503, 504) {
        Test-TransientHttpStatus $_ | Should -BeTrue
    }

    It 'does not retry HTTP <_>' -ForEach @(400, 401, 403, 404, 409, 410, 428, 430, 499) {
        Test-TransientHttpStatus $_ | Should -BeFalse
    }

    It 'does not retry HTTP <_> — permanent by definition, retrying only adds delay' -ForEach @(501, 505, 506) {
        Test-TransientHttpStatus $_ | Should -BeFalse
    }

    It 'does not blanket-retry the rest of the 5xx range' -ForEach @(507, 508, 520, 599) {
        # Deliberate: no endpoint this product talks to emits these. Revisit if a
        # crawler is ever pointed at something behind a CDN that does.
        Test-TransientHttpStatus $_ | Should -BeFalse
    }
}

Describe 'Invoke-IngestAPI — retry policy' {

    BeforeEach {
        Mock Start-Sleep { }   # skip the real exponential backoff
    }

    It 'retries HTTP 429 (throttled) for the full attempt budget' {
        Mock Invoke-RestMethod { throw (New-HttpError -Status 429 -Message 'Too Many Requests') }
        { Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } } | Should -Throw
        Should -Invoke Invoke-RestMethod -Exactly 5
    }

    It 'retries HTTP 500 — the bottom of the transient range' {
        Mock Invoke-RestMethod { throw (New-HttpError -Status 500 -Message 'Server Error') }
        { Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } } | Should -Throw
        Should -Invoke Invoke-RestMethod -Exactly 5
    }

    It 'retries a transport failure that carries no status code at all' {
        Mock Invoke-RestMethod { throw [System.Exception]::new('The remote name could not be resolved') }
        { Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } } | Should -Throw
        Should -Invoke Invoke-RestMethod -Exactly 5
    }

    It 'does not retry HTTP 404 — a client error is not transient' {
        Mock Invoke-RestMethod { throw (New-HttpError -Status 404 -Message 'Not Found') }
        { Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } } | Should -Throw
        Should -Invoke Invoke-RestMethod -Exactly 1
    }

    It 'does not retry HTTP 401 — re-authenticating is the caller''s job' {
        Mock Invoke-RestMethod { throw (New-HttpError -Status 401 -Message 'Unauthorized') }
        { Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } } | Should -Throw
        Should -Invoke Invoke-RestMethod -Exactly 1
    }

    It 'stops retrying as soon as an attempt succeeds' {
        $script:calls = 0
        Mock Invoke-RestMethod {
            $script:calls++
            if ($script:calls -lt 3) { throw (New-HttpError -Status 503) }
            return @{ inserted = 1 }
        }
        $result = Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() }
        $result.inserted | Should -Be 1
        Should -Invoke Invoke-RestMethod -Exactly 3
    }

    It 'backs off exponentially — 2, 4, 8, 16 seconds between the five attempts' {
        Mock Invoke-RestMethod { throw (New-HttpError -Status 503) }
        { Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } } | Should -Throw
        # Four sleeps for five attempts, doubling each time. Asserted one at a
        # time rather than in a loop: PowerShell is case-insensitive, so a loop
        # variable named $seconds would shadow the mock's own $Seconds parameter
        # and the filter would compare it to itself — matching everything.
        Should -Invoke Start-Sleep -Exactly 4
        Should -Invoke Start-Sleep -Exactly 1 -ParameterFilter { $Seconds -eq 2 }
        Should -Invoke Start-Sleep -Exactly 1 -ParameterFilter { $Seconds -eq 4 }
        Should -Invoke Start-Sleep -Exactly 1 -ParameterFilter { $Seconds -eq 8 }
        Should -Invoke Start-Sleep -Exactly 1 -ParameterFilter { $Seconds -eq 16 }
    }

    It 'gives the ingest POST a 300-second timeout' {
        Mock Invoke-RestMethod { return @{ inserted = 0 } }
        Invoke-IngestAPI -Endpoint 'ingest/test' -Body @{ records = @() } | Out-Null
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $TimeoutSec -eq 300 }
    }
}

Describe 'Get-FGIngestErrorDetail — response-body extraction' {

    It 'prefers ErrorDetails.Message (the PS7 path, where the stream is already drained)' {
        $err = [PSCustomObject]@{
            Exception    = [PSCustomObject]@{ Response = $null }
            ErrorDetails = [PSCustomObject]@{ Message = '{"error":"bad request"}' }
        }
        (Get-FGIngestErrorDetail -ErrorRecord $err).ResponseBody | Should -Be '{"error":"bad request"}'
    }

    It 'falls back to the response stream when ErrorDetails carries no message' {
        # ErrorDetails exists but is empty — the guard has to check BOTH, or this
        # returns '' instead of the body the server actually sent.
        $bytes  = [System.Text.Encoding]::UTF8.GetBytes('stream body')
        $resp   = [PSCustomObject]@{ StatusCode = [PSCustomObject]@{ value__ = 500 } }
        $resp | Add-Member -MemberType ScriptMethod -Name 'GetResponseStream' -Value {
            [System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes('stream body'))
        } -Force
        $err = [PSCustomObject]@{
            Exception    = [PSCustomObject]@{ Response = $resp }
            ErrorDetails = [PSCustomObject]@{ Message = '' }
        }
        $detail = Get-FGIngestErrorDetail -ErrorRecord $err
        $detail.ResponseBody | Should -Be 'stream body'
        $detail.StatusCode   | Should -Be 500
        $bytes.Length        | Should -BeGreaterThan 0
    }

    It 'returns nulls rather than throwing when the error has no response at all' {
        $err    = [PSCustomObject]@{ Exception = [PSCustomObject]@{}; ErrorDetails = $null }
        $detail = Get-FGIngestErrorDetail -ErrorRecord $err
        $detail.StatusCode   | Should -BeNullOrEmpty
        $detail.ResponseBody | Should -BeNullOrEmpty
    }
}

Describe 'Update-CrawlerProgress — field gating' {

    It 'reports progress for job id 1 (the guard is <= 0, not <= 1)' {
        $script:JobId = 1
        Mock Invoke-RestMethod { }
        Update-CrawlerProgress -Step 'phase' -Pct 10
        Should -Invoke Invoke-RestMethod -Exactly 1
    }

    It 'includes pct when it is 0 — 0% is a real value, not "unset"' {
        $script:JobId = 42
        $script:body  = $null
        Mock Invoke-RestMethod { $script:body = $Body | ConvertFrom-Json }
        Update-CrawlerProgress -Step 'phase' -Pct 0
        $script:body.pct | Should -Be 0
    }

    It 'omits pct when it is left at the -1 sentinel' {
        $script:JobId = 42
        $script:body  = $null
        Mock Invoke-RestMethod { $script:body = $Body | ConvertFrom-Json }
        Update-CrawlerProgress -Step 'phase'
        $script:body.PSObject.Properties.Name | Should -Not -Contain 'pct'
        $script:body.step | Should -Be 'phase'
    }

    It 'gives the progress ping a short 10-second timeout' {
        $script:JobId = 42
        Mock Invoke-RestMethod { }
        Update-CrawlerProgress -Step 'phase' -Pct 5
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $TimeoutSec -eq 10 }
    }
}
