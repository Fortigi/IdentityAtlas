#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/shared/Invoke-CrawlerDeltaToken.ps1 —
    the one client for /crawlers/delta-tokens.

.DESCRIPTION
    Graph's `$deltatoken` and the SQL connector's per-statement watermark are
    stored in the same table, so they go through the same client. Only
    Invoke-RestMethod is mocked; what these pin is the protocol:

      * the endpoint key is escaped into the path, and the systemId is a query
        parameter on read and delete but part of the BODY on write;
      * a read that fails is "no token", never a thrown error — a full fetch is
        slower and always correct, and the alternative is a crawler that cannot
        start;
      * a write of an empty token is not sent at all, so a run that learned
        nothing cannot erase what the last one learned;
      * a write that fails does not fail the run: the previous token stays and
        the next run re-reads the same window, which upserts absorb.

.USAGE
    Invoke-Pester -Path test/unit/CrawlerDeltaToken.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerDeltaToken.ps1')
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'

    function Reset-TokenTest { $script:calls = [System.Collections.Generic.List[object]]::new() }
    # Records every request and answers with a stored row.
    $script:RestMock = {
        $script:calls.Add(@{ Uri = $Uri; Method = $Method; Headers = $Headers; Body = $Body })
        [pscustomobject]@{ token = 'stored-tok'; lastSyncAt = '2026-09-25T09:00:00Z'; recordsLastSeen = 12 }
    }
    function Get-Call { param([int]$Index = 0) @($script:calls)[$Index] }
}

Describe 'Test-CrawlerDeltaTokenEndpoint' {
    # The API validates the endpoint as ^[a-zA-Z0-9/_\-.:]+$, at most 200 chars.
    # Anything else is a 400, which is why callers fold their keys before use.
    It 'accepts the shapes both callers produce' {
        foreach ($e in @('users/delta', 'servicePrincipals/delta', 'sql:Grants:0123456789abcdef', 'sql:sweep:Entitlement-grants:abc123')) {
            Test-CrawlerDeltaTokenEndpoint -Endpoint $e | Should -BeTrue
        }
    }

    It 'rejects what the API would reject' {
        foreach ($e in @('', 'has space', "new`nline", 'quote"d', 'percent%20', ('x' * 201))) {
            Test-CrawlerDeltaTokenEndpoint -Endpoint $e | Should -BeFalse
        }
        # Exactly 200 is still allowed — the bound is inclusive, as the API's is.
        Test-CrawlerDeltaTokenEndpoint -Endpoint ('x' * 200) | Should -BeTrue
    }
}

Describe 'Get-CrawlerDeltaTokenRow / Get-CrawlerDeltaToken' {
    BeforeEach { Reset-TokenTest; Mock Invoke-RestMethod $script:RestMock }

    It 'reads the row for one (system, endpoint), escaping the key into the path' {
        $row = Get-CrawlerDeltaTokenRow -SystemId 7 -Endpoint 'sql:Grants:abc'
        $row.token | Should -Be 'stored-tok'
        # The key carries colons; they must reach the API as the key, not as path
        # structure, and the systemId is a query parameter on a read.
        (Get-Call).Uri | Should -Be 'http://localhost:3001/api/crawlers/delta-tokens/sql%3AGrants%3Aabc?systemId=7'
        (Get-Call).Method | Should -Be 'Get'
        (Get-Call).Headers.Authorization | Should -Be 'Bearer fgc_test'
    }

    It 'returns the WHOLE row, because a caller that schedules on age needs the timestamp' {
        (Get-CrawlerDeltaTokenRow -SystemId 7 -Endpoint 'x').lastSyncAt | Should -Be '2026-09-25T09:00:00Z'
    }

    It 'answers $null when there is no token, and does not throw' {
        Mock Invoke-RestMethod { [pscustomobject]@{ token = $null; lastSyncAt = $null } }
        Get-CrawlerDeltaTokenRow -SystemId 7 -Endpoint 'x' | Should -BeNullOrEmpty
    }

    It 'answers $null when the request fails — a full read is slow, never wrong' {
        Mock Invoke-RestMethod { throw 'HTTP 500' }
        { Get-CrawlerDeltaTokenRow -SystemId 7 -Endpoint 'x' } | Should -Not -Throw
        Get-CrawlerDeltaTokenRow -SystemId 7 -Endpoint 'x' | Should -BeNullOrEmpty
    }

    It 'the string form gives just the token, and $null when there is none' {
        Get-CrawlerDeltaToken -SystemId 7 -Endpoint 'x' | Should -Be 'stored-tok'
        Mock Invoke-RestMethod { throw 'HTTP 500' }
        Get-CrawlerDeltaToken -SystemId 7 -Endpoint 'x' | Should -BeNullOrEmpty
    }
}

Describe 'Set-CrawlerDeltaToken' {
    BeforeEach { Reset-TokenTest; Mock Invoke-RestMethod $script:RestMock }

    It 'PUTs the token with the systemId in the BODY, not the query' {
        Set-CrawlerDeltaToken -SystemId 7 -Endpoint 'sql:Grants:abc' -Token '1758899100000' -RecordsLastSeen 4321
        (Get-Call).Method | Should -Be 'Put'
        (Get-Call).Uri | Should -Be 'http://localhost:3001/api/crawlers/delta-tokens/sql%3AGrants%3Aabc'
        $body = (Get-Call).Body | ConvertFrom-Json
        $body.systemId | Should -Be 7
        $body.token | Should -Be '1758899100000'
        $body.recordsLastSeen | Should -Be 4321
    }

    It 'sends NOTHING for an empty token' {
        # A run that learned nothing must not erase what the last one learned.
        Set-CrawlerDeltaToken -SystemId 7 -Endpoint 'x' -Token ''
        Should -Invoke Invoke-RestMethod -Exactly 0
    }

    It 'does not fail the run when the write fails' {
        # The previous token stays, so the next run re-reads the same window.
        Mock Invoke-RestMethod { throw 'HTTP 500' }
        { Set-CrawlerDeltaToken -SystemId 7 -Endpoint 'x' -Token 'tok' } | Should -Not -Throw
    }
}

Describe 'Remove-CrawlerDeltaToken' {
    BeforeEach { Reset-TokenTest; Mock Invoke-RestMethod $script:RestMock }

    It 'DELETEs the row for one (system, endpoint)' {
        Remove-CrawlerDeltaToken -SystemId 7 -Endpoint 'sql:sweep:Grants:abc'
        (Get-Call).Method | Should -Be 'Delete'
        (Get-Call).Uri | Should -Be 'http://localhost:3001/api/crawlers/delta-tokens/sql%3Asweep%3AGrants%3Aabc?systemId=7'
    }

    It 'never throws — the caller is already falling back to a full read' {
        Mock Invoke-RestMethod { throw 'HTTP 500' }
        { Remove-CrawlerDeltaToken -SystemId 7 -Endpoint 'x' } | Should -Not -Throw
    }
}
