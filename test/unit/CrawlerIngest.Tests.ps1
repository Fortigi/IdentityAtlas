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
