#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the shared OData protocol library (tools/crawlers/odata/).

.DESCRIPTION
    The OData base is a SHARED library, not a crawler. Its manifest declares no
    entry point worth running — `Start-ODataCrawler.ps1` throws by design — and it
    exists to be pulled in via `dependsOn` by any crawler speaking OData. Omada is
    currently its only consumer; it will not be the last.

    These tests used to live inside test/unit/Omada.Tests.ps1, because Omada was
    the crawler that happened to need them first. That filing was an accident of
    history with two real costs:

      * Ownership. A second OData consumer would have had to either duplicate the
        coverage or reach into Omada's test file for it.
      * Traceability. The library is loaded there by a folder glob
        (`Get-ChildItem .../odata | ForEach-Object { . $_.FullName }`), so no test
        file ever names an OData source file. Any tooling that maps source files to
        their tests by name — including the first pass of the mutation-scope work —
        concludes the library is untested. It was not; it was just unfindable.

    Covered here: the auth methods that need no HTTP (ApiToken / BasicAuth /
    CookieString, including the bare-token auto-prefix), Get-ODataAuthRoot's URL
    trimming, and the library's public surface.

    NOT covered here, and worth knowing: the retry/transient helpers in
    Invoke-ODataGetRequest.ps1 — Test-ODataTransientStatus, Get-ODataRetryWait,
    Get-ODataRetryAfter, Resolve-ODataAuthFailure, Invoke-ODataRequestWithRetry —
    have no dedicated assertions. That is the same shape of code that measured
    39.7% and 40.4% under mutation testing elsewhere in this repo, so treat its
    line coverage with suspicion until it is measured.

    The end-to-end behaviour (all six auth methods, pagination, token refresh)
    against a real mock server lives in tools/crawlers/odata/Test-ODataCrawler.ps1,
    which CI runs separately — it is an integration test, not a Pester suite.

.USAGE
    Invoke-Pester -Path test/unit/ODataLibrary.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:odataRoot = Join-Path $script:repoRoot 'tools' 'crawlers' 'odata'

    # Load the library. Two exclusions, both load-bearing:
    #   Start-*  the entry point, which throws by design (dependsOn-only base).
    #   Test-*   Test-ODataCrawler.ps1 is a SCRIPT, not a function library — dot-
    #            sourcing it RUNS the whole integration suite, mock HTTP server and
    #            all. Omitting this filter makes a 19-test unit file take ~52s and
    #            bind a TCP port. Omada.Tests.ps1 globbed this folder without the
    #            filter and paid exactly that cost on every unit run.
    Get-ChildItem $script:odataRoot -Filter '*.ps1' |
        Where-Object { $_.Name -notlike 'Start-*' -and $_.Name -notlike 'Test-*' } |
        ForEach-Object { . $_.FullName }
}

Describe 'OData library — public surface' {
    It 'exports <_>' -ForEach @(
        'Connect-ODataAPI',
        'Invoke-ODataPagedRequest',
        'Invoke-ODataGetRequest',
        'Get-ODataEntitySets',
        'Get-ODataAuthRoot',
        'Update-ODataSessionIfExpired'
    ) {
        Get-Command $_ -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

Describe 'Connect-ODataAPI — ApiToken auth' {
    It 'succeeds without making any HTTP call' {
        { Connect-ODataAPI -BaseUrl 'https://odata.example.com' -AuthMethod 'ApiToken' -ApiToken 'test-static-token' } |
            Should -Not -Throw
    }
}

Describe 'Connect-ODataAPI — BasicAuth auth' {
    It 'succeeds without making any HTTP call' {
        { Connect-ODataAPI -BaseUrl 'https://odata.example.com' -AuthMethod 'BasicAuth' -Username 'admin' -Password 'pass' } |
            Should -Not -Throw
    }
    It 'throws when username is missing' {
        { Connect-ODataAPI -BaseUrl 'https://odata.example.com' -AuthMethod 'BasicAuth' -Password 'pass' } |
            Should -Throw
    }
}

Describe 'Connect-ODataAPI — CookieString auth' {
    # The /odata/dataobjects paths below are Omada-shaped because that is the
    # deployment these rules were written against, but nothing in the library is
    # Omada-specific — the segment trimming is generic to any OData service root.
    It 'succeeds with an explicit name=value cookie string' {
        { Connect-ODataAPI -BaseUrl 'https://tenant.example.com/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'oisauthtoken=MHXp1OG0seFfKwNYzQkZwA==' } |
            Should -Not -Throw
    }
    It 'succeeds with a bare token — auto-prefix oisauthtoken= is applied' {
        { Connect-ODataAPI -BaseUrl 'https://tenant.example.com/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'MHXp1OG0seFfKwNYzQkZwA==' } |
            Should -Not -Throw
    }
    It 'throws when CookieString is empty' {
        { Connect-ODataAPI -BaseUrl 'https://tenant.example.com/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString '' } |
            Should -Throw
    }
    It 'passes an ASP.NET multi-cookie string as-is (already name=value)' {
        { Connect-ODataAPI -BaseUrl 'https://server/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'ASP.NET_SessionId=abc123; Auth=xyz' } |
            Should -Not -Throw
    }
}

Describe 'Get-ODataAuthRoot' {
    BeforeEach {
        # Seed the session so Get-ODataAuthRoot can read BaseUrl.
        Connect-ODataAPI -BaseUrl 'https://tenant.example.com/odata/dataobjects' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
    }

    It 'strips /odata/dataobjects from a cloud URL' {
        Get-ODataAuthRoot | Should -Be 'https://tenant.example.com'
    }

    It 'strips /odata/dataobjects from an on-prem URL' {
        Connect-ODataAPI -BaseUrl 'http://server/odata/dataobjects' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
        Get-ODataAuthRoot | Should -Be 'http://server'
    }

    It 'returns the base URL unchanged when no /odata/ segment is present' {
        Connect-ODataAPI -BaseUrl 'http://server/api' `
            -AuthMethod 'ApiToken' -ApiToken 'tok'
        Get-ODataAuthRoot | Should -Be 'http://server/api'
    }
}

# ─── Request-building and retry policy ───────────────────────────────────────
# These are the small pure decision functions extracted out of the request loop.
# Until now they had NO unit assertions: their line coverage came entirely from
# Test-ODataCrawler.ps1 being dot-sourced by accident during the unit run, which
# executed the whole mock-server integration suite as a side effect of loading.
# With that removed the honest unit coverage was zero, and PSMutant generated no
# mutants at all for Invoke-ODataGetRequest.ps1 (coveredLinesOnly finds nothing
# to mutate on lines nothing exercises).

Describe 'Resolve-ODataStartUri' {
    It 'concatenates base and path when there are no query params' {
        Resolve-ODataStartUri -Base 'https://h/odata' -Path '/Users' |
            Should -Be 'https://h/odata/Users'
    }

    It 'appends a single query parameter after a ?' {
        Resolve-ODataStartUri -Base 'https://h/odata' -Path '/Users' -QueryParams @{ '$top' = 10 } |
            Should -Be 'https://h/odata/Users?$top=10'
    }

    It 'url-escapes parameter values' {
        Resolve-ODataStartUri -Base 'https://h' -Path '/E' -QueryParams @{ '$filter' = "name eq 'a b'" } |
            Should -Be 'https://h/E?$filter=name%20eq%20%27a%20b%27'
    }

    It 'joins multiple parameters with &' {
        $uri = Resolve-ODataStartUri -Base 'https://h' -Path '/E' -QueryParams @{ a = 1; b = 2 }
        $uri | Should -Match '^https://h/E\?'
        # Hashtable order is not guaranteed — assert on content, not sequence.
        ($uri -split '\?')[1].Split('&') | Sort-Object | Should -Be @('a=1', 'b=2')
    }
}

Describe 'Get-ODataResponseStatus' {
    # NB this reads .StatusCode.value__, whereas the Entra crawler's
    # Get-FGHttpStatus casts [int] on .StatusCode. Two readers, two fixture
    # shapes; a fixture built for one returns $null under the other.
    It 'reads the status from the value__ member' {
        $err = [PSCustomObject]@{ Exception = [PSCustomObject]@{
            Response = [PSCustomObject]@{ StatusCode = [PSCustomObject]@{ value__ = 503 } } } }
        Get-ODataResponseStatus -ErrorRecord $err | Should -Be 503
    }

    It 'returns null rather than throwing when there is no response' {
        $err = [PSCustomObject]@{ Exception = [PSCustomObject]@{} }
        Get-ODataResponseStatus -ErrorRecord $err | Should -BeNullOrEmpty
    }
}

Describe 'Get-ODataRetryAfter' {
    It 'reads Retry-After as an integer number of seconds' {
        $resp = [PSCustomObject]@{}
        $resp | Add-Member -MemberType NoteProperty -Name Headers -Value ([PSCustomObject]@{})
        $resp.Headers | Add-Member -MemberType ScriptMethod -Name GetValues -Value { param($n) @('42') }
        $err = [PSCustomObject]@{ Exception = [PSCustomObject]@{ Response = $resp } }
        Get-ODataRetryAfter -ErrorRecord $err | Should -Be 42
    }

    It 'returns 0 when the header is absent' {
        $err = [PSCustomObject]@{ Exception = [PSCustomObject]@{} }
        Get-ODataRetryAfter -ErrorRecord $err | Should -Be 0
    }
}

Describe 'Test-ODataTransientStatus' {
    # The rule is: no status (network error), 429, or 500..504 inclusive.
    # Note this differs from the Entra crawler's equivalent, which treats the
    # whole 5xx range as transient — 505 is retryable there and is NOT here.
    It 'treats a missing status (network-level failure) as transient' {
        # Kept out of the -ForEach below: Pester coerces a $null element into a
        # hashtable binding, so the case would not be exercised as written.
        Test-ODataTransientStatus -Status $null | Should -BeTrue
    }

    It 'treats <_> as transient' -ForEach @(429, 500, 501, 502, 503, 504) {
        Test-ODataTransientStatus -Status $_ | Should -BeTrue
    }

    It 'treats <_> as permanent' -ForEach @(400, 401, 403, 404, 428, 430, 499, 505, 599) {
        Test-ODataTransientStatus -Status $_ | Should -BeFalse
    }
}

Describe 'Get-ODataRetryWait' {
    It 'honours a server-supplied Retry-After over the backoff ladder' {
        Get-ODataRetryWait -Attempt 0 -RetryAfter 30 -Delays @(1, 2, 4) | Should -Be 30
    }

    It 'honours a Retry-After of 1 second — the guard is > 0, not > 1' {
        # A server asking for a 1s pause must not be silently upgraded to the
        # ladder's delay for that attempt.
        Get-ODataRetryWait -Attempt 2 -RetryAfter 1 -Delays @(10, 20, 40) | Should -Be 1
    }

    It 'walks the ladder by attempt when there is no Retry-After' {
        Get-ODataRetryWait -Attempt 0 -RetryAfter 0 -Delays @(1, 2, 4) | Should -Be 1
        Get-ODataRetryWait -Attempt 1 -RetryAfter 0 -Delays @(1, 2, 4) | Should -Be 2
        Get-ODataRetryWait -Attempt 2 -RetryAfter 0 -Delays @(1, 2, 4) | Should -Be 4
    }

    It 'clamps to the last delay instead of running off the end of the ladder' {
        Get-ODataRetryWait -Attempt 9 -RetryAfter 0 -Delays @(1, 2, 4) | Should -Be 4
    }
}

Describe 'Add-ODataAuthParam' {
    It 'sends a bearer token for <_>' -ForEach @('OAuth2CC', 'OAuth2ROPC', 'ApiToken') {
        $req = @{}
        Add-ODataAuthParam -ReqParams $req -Session ([PSCustomObject]@{ AuthMethod = $_; AccessToken = 'tok' })
        $req['Headers'].Authorization | Should -Be 'Bearer tok'
        $req['Headers'].Accept | Should -Be 'application/json'
    }

    It 'sends an explicit Cookie header for CookieString (WebSession is unreliable over HTTPS)' {
        $req = @{}
        Add-ODataAuthParam -ReqParams $req -Session ([PSCustomObject]@{ AuthMethod = 'CookieString'; CookieHeader = 'k=v' })
        $req['Headers'].Cookie | Should -Be 'k=v'
        $req.ContainsKey('WebSession') | Should -BeFalse
    }

    It 'attaches the WebSession for FormCookie' {
        $req = @{}
        Add-ODataAuthParam -ReqParams $req -Session ([PSCustomObject]@{ AuthMethod = 'FormCookie'; WebSession = 'SESSION' })
        $req['WebSession'] | Should -Be 'SESSION'
        $req['Headers'].Accept | Should -Be 'application/json'
    }

    It 'sends the prebuilt Basic header for BasicAuth' {
        $req = @{}
        Add-ODataAuthParam -ReqParams $req -Session ([PSCustomObject]@{ AuthMethod = 'BasicAuth'; BasicAuthHeader = 'Basic abc' })
        $req['Headers'].Authorization | Should -Be 'Basic abc'
    }

    It 'leaves the request untouched for an unknown auth method' {
        $req = @{}
        Add-ODataAuthParam -ReqParams $req -Session ([PSCustomObject]@{ AuthMethod = 'Nonsense' })
        $req.Count | Should -Be 0
    }
}

Describe 'Invoke-ODataPagedRequest' {
    # The $skip pager, for servers that honour $top/$skip but return no
    # @odata.nextLink. Its only previous coverage came from the integration
    # suite running by accident during the unit run.
    BeforeEach {
        Connect-ODataAPI -BaseUrl 'https://h/odata' -AuthMethod 'ApiToken' -ApiToken 'tok'
        $script:calls = [System.Collections.Generic.List[object]]::new()
    }

    It 'refuses to run before Connect-ODataAPI' {
        $saved = $script:ODataSession
        try {
            Set-Variable -Name ODataSession -Scope Script -Value $null
            { Invoke-ODataPagedRequest -Path '/Items' } | Should -Throw '*not connected*'
        } finally {
            Set-Variable -Name ODataSession -Scope Script -Value $saved
        }
    }

    It 'walks $skip until a page comes back empty, and flattens the pages' {
        Mock Invoke-ODataGetRequest {
            $script:calls.Add($QueryParams['$skip'])
            switch ($script:calls.Count) {
                1 { @([pscustomobject]@{ id = 1 }, [pscustomobject]@{ id = 2 }) }
                2 { @([pscustomobject]@{ id = 3 }) }
                default { @() }
            }
        }
        $out = Invoke-ODataPagedRequest -Path '/Items' -PageSize 2
        $out.Count | Should -Be 3
        $out.id | Should -Be @(1, 2, 3)
        # Advance by records RECEIVED, not by PageSize — pages can be short.
        $script:calls | Should -Be @(0, 2, 3)
    }

    It 'stops after one empty page rather than looping forever' {
        Mock Invoke-ODataGetRequest { @() }
        (Invoke-ODataPagedRequest -Path '/Items').Count | Should -Be 0
        Should -Invoke Invoke-ODataGetRequest -Exactly 1
    }

    It 'passes the caller query params through alongside $top/$skip' {
        Mock Invoke-ODataGetRequest {
            $script:calls.Add($QueryParams)
            @()
        }
        Invoke-ODataPagedRequest -Path '/Items' -PageSize 50 -QueryParams @{ '$filter' = "a eq 1" } | Out-Null
        $script:calls[0]['$top']     | Should -Be 50
        $script:calls[0]['$skip']    | Should -Be 0
        $script:calls[0]['$filter']  | Should -Be 'a eq 1'
    }
}

Describe 'OData library — file structure' {
    It 'the odata folder holds the protocol files' {
        Get-ChildItem $script:odataRoot -Filter '*.ps1' | Should -Not -BeNullOrEmpty
    }

    It 'has at least 3 PS1 files (auth, request, paging)' {
        (Get-ChildItem $script:odataRoot -Filter '*.ps1').Count | Should -BeGreaterOrEqual 3
    }

    It 'is a dependsOn-only base — its entry point is not meant to be run' {
        # crawler.json declares an entryPoint for manifest uniformity, but the
        # library is consumed via dependsOn; running it directly throws by design.
        $manifest = Get-Content (Join-Path $script:odataRoot 'crawler.json') -Raw | ConvertFrom-Json
        $manifest.type | Should -Be 'odata'
        $manifest.dependsOn | Should -BeNullOrEmpty
    }
}
