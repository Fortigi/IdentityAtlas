#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/scim/ScimCrawler.Functions.ps1 — the SCIM
    REST client, the paging contract, config resolution and the bucketed ingest
    writer.

.DESCRIPTION
    The client half is tested by mocking its one command boundary
    (Invoke-RestMethod / Invoke-ScimRequest); the DECISIONS — which URL a page asks
    for, where the next page starts, which scope a bucket is flushed under — are
    tested directly against the pure functions, because a call-count assertion
    around a mock cannot tell a correct page offset from a wrong one.

.USAGE
    Invoke-Pester -Path test/unit/ScimCrawlerFunctions.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:scimDir  = Join-Path $script:repoRoot 'tools' 'crawlers' 'scim'
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:scimDir 'ScimCrawler.Transform.ps1')
    . (Join-Path $script:scimDir 'ScimCrawler.Functions.ps1')

    # A SCIM ListResponse page.
    function New-ScimPage {
        param([array]$Items, [int]$Total)
        [pscustomobject]@{ totalResults = $Total; itemsPerPage = $Items.Count; Resources = $Items }
    }
    function New-ScimUsers {
        param([int]$From, [int]$Count)
        @(($From..($From + $Count - 1)) | ForEach-Object { [pscustomobject]@{ id = "u-$_" } })
    }
}

Describe 'Get-ScimBaseUrl' {
    It 'strips trailing slashes so <base>/Users never doubles up' {
        Get-ScimBaseUrl -BaseUrl 'https://h/scim/v2/'  | Should -Be 'https://h/scim/v2'
        Get-ScimBaseUrl -BaseUrl 'https://h/scim/v2//' | Should -Be 'https://h/scim/v2'
        Get-ScimBaseUrl -BaseUrl '  https://h/scim/v2 ' | Should -Be 'https://h/scim/v2'
    }

    It 'leaves a base URL without a trailing slash alone (no path is assumed)' {
        Get-ScimBaseUrl -BaseUrl 'https://h/api/scim' | Should -Be 'https://h/api/scim'
    }
}

Describe 'Get-ScimPageUrl' {
    It 'builds the 1-based startIndex/count query SCIM 2.0 defines' {
        Get-ScimPageUrl -BaseUrl 'https://h/scim/v2' -Endpoint 'Users' -StartIndex 1 -Count 100 |
            Should -Be 'https://h/scim/v2/Users?startIndex=1&count=100'
    }

    It 'advances startIndex without changing count' {
        Get-ScimPageUrl -BaseUrl 'https://h/scim/v2' -Endpoint 'Groups' -StartIndex 21 -Count 10 |
            Should -Be 'https://h/scim/v2/Groups?startIndex=21&count=10'
    }
}

Describe 'Get-ScimPageState' {
    It 'advances by the number of items actually returned on a full page' {
        $state = Get-ScimPageState -Response (New-ScimPage -Items (New-ScimUsers 1 10) -Total 25) -StartIndex 1 -PageSize 10
        $state.items.Count    | Should -Be 10
        $state.nextStartIndex | Should -Be 11
    }

    It 'stops on a short page — that is the last page' {
        $state = Get-ScimPageState -Response (New-ScimPage -Items (New-ScimUsers 21 5) -Total 25) -StartIndex 21 -PageSize 10
        $state.items.Count    | Should -Be 5
        $state.nextStartIndex | Should -Be 0
    }

    It 'stops on an empty page' {
        $state = Get-ScimPageState -Response (New-ScimPage -Items @() -Total 0) -StartIndex 1 -PageSize 10
        $state.items.Count    | Should -Be 0
        $state.nextStartIndex | Should -Be 0
    }

    It 'stops once totalResults is reached, so an exact multiple asks for no extra page' {
        # 20 users, page size 10: the second page is full, but the walk is over.
        $state = Get-ScimPageState -Response (New-ScimPage -Items (New-ScimUsers 11 10) -Total 20) -StartIndex 11 -PageSize 10
        $state.nextStartIndex | Should -Be 0
    }

    It 'keeps walking when a full page has not yet reached totalResults' {
        $state = Get-ScimPageState -Response (New-ScimPage -Items (New-ScimUsers 11 10) -Total 25) -StartIndex 11 -PageSize 10
        $state.nextStartIndex | Should -Be 21
    }

    It 'still terminates on a full page from a provider that omits totalResults' {
        $resp = [pscustomobject]@{ Resources = (New-ScimUsers 1 10) }
        (Get-ScimPageState -Response $resp -StartIndex 1 -PageSize 10).nextStartIndex | Should -Be 11
        # ...and the next, empty page ends it.
        (Get-ScimPageState -Response ([pscustomobject]@{ Resources = @() }) -StartIndex 11 -PageSize 10).nextStartIndex | Should -Be 0
    }

    It 'treats a response with no Resources array as empty' {
        (Get-ScimPageState -Response ([pscustomobject]@{ totalResults = 0 }) -StartIndex 1 -PageSize 10).nextStartIndex | Should -Be 0
        (Get-ScimPageState -Response $null -StartIndex 1 -PageSize 10).items.Count | Should -Be 0
    }
}

Describe 'Invoke-ScimSearchStream' {
    BeforeEach {
        $script:ScimSession = @{ BaseUrl = 'https://h/scim/v2'; TimeoutSec = 30; AuthHeader = 'Bearer x'; AuthMethod = 'ApiToken' }
        $script:requested = [System.Collections.Generic.List[string]]::new()
    }

    It 'walks every page, invoking the callback once per page with advancing startIndex' {
        Mock -CommandName Invoke-ScimRequest -MockWith {
            $script:requested.Add($Uri)
            if ($Uri -match 'startIndex=1&')  { return (New-ScimPage -Items (New-ScimUsers 1 10)  -Total 25) }
            if ($Uri -match 'startIndex=11&') { return (New-ScimPage -Items (New-ScimUsers 11 10) -Total 25) }
            return (New-ScimPage -Items (New-ScimUsers 21 5) -Total 25)
        }
        $seen = [System.Collections.Generic.List[string]]::new()
        $total = Invoke-ScimSearchStream -Endpoint 'Users' -PageSize 10 -OnPage { param($page) foreach ($u in $page) { $seen.Add($u.id) } }

        $total       | Should -Be 25
        $seen.Count  | Should -Be 25
        $seen[0]     | Should -Be 'u-1'
        $seen[24]    | Should -Be 'u-25'
        $script:requested.Count | Should -Be 3
        $script:requested[0] | Should -Be 'https://h/scim/v2/Users?startIndex=1&count=10'
        $script:requested[1] | Should -Be 'https://h/scim/v2/Users?startIndex=11&count=10'
        $script:requested[2] | Should -Be 'https://h/scim/v2/Users?startIndex=21&count=10'
    }

    It 'makes exactly one request and never calls back for an empty collection' {
        Mock -CommandName Invoke-ScimRequest -MockWith { $script:requested.Add($Uri); New-ScimPage -Items @() -Total 0 }
        $calls = 0
        $total = Invoke-ScimSearchStream -Endpoint 'Groups' -PageSize 100 -OnPage { param($page) $script:calls++ }
        $total | Should -Be 0
        $script:requested.Count | Should -Be 1
    }
}

Describe 'Invoke-ScimRequest' {
    BeforeEach {
        $script:ScimSession = @{ BaseUrl = 'https://h/scim/v2'; TimeoutSec = 30; AuthHeader = 'Bearer x'; AuthMethod = 'ApiToken' }
    }

    It 'returns the response on success' {
        Mock -CommandName Invoke-RestMethod -MockWith { [pscustomobject]@{ ok = $true } }
        (Invoke-ScimRequest -Uri 'https://h/scim/v2/Users').ok | Should -BeTrue
    }

    It 'gives up immediately on a non-transient status — a wrong credential is still wrong in four seconds' {
        # Test-TransientHttpStatus (shared, already unit-tested) owns the decision;
        # what is asserted here is that Invoke-ScimRequest OBEYS it — a 401 must
        # cost exactly one request, not five.
        Mock -CommandName Test-TransientHttpStatus -MockWith { $false }
        Mock -CommandName Start-Sleep -MockWith {}
        Mock -CommandName Invoke-RestMethod -MockWith { throw 'HTTP 401' }
        { Invoke-ScimRequest -Uri 'https://h/scim/v2/Users' -MaxRetries 4 } | Should -Throw '*SCIM request failed*'
        Should -Invoke Invoke-RestMethod -Times 1 -Exactly
        Should -Invoke Start-Sleep -Times 0 -Exactly
    }

    It 'retries a transient status up to MaxRetries, then re-throws' {
        Mock -CommandName Test-TransientHttpStatus -MockWith { $true }
        Mock -CommandName Start-Sleep -MockWith {}
        Mock -CommandName Invoke-RestMethod -MockWith { throw 'HTTP 503' }
        { Invoke-ScimRequest -Uri 'https://h/scim/v2/Users' -MaxRetries 2 } | Should -Throw '*SCIM request failed*'
        # 1 initial attempt + 2 retries.
        Should -Invoke Invoke-RestMethod -Times 3 -Exactly
        Should -Invoke Start-Sleep -Times 2 -Exactly
    }

    It 'returns the response as soon as a retry succeeds' {
        Mock -CommandName Test-TransientHttpStatus -MockWith { $true }
        Mock -CommandName Start-Sleep -MockWith {}
        $script:attempts = 0
        Mock -CommandName Invoke-RestMethod -MockWith {
            $script:attempts++
            if ($script:attempts -lt 3) { throw 'HTTP 503' }
            [pscustomobject]@{ ok = $true }
        }
        (Invoke-ScimRequest -Uri 'https://h/scim/v2/Users' -MaxRetries 4).ok | Should -BeTrue
        Should -Invoke Invoke-RestMethod -Times 3 -Exactly
    }

    It 'never puts the bearer token in the thrown message' {
        Mock -CommandName Invoke-RestMethod -MockWith { throw 'boom' }
        $script:ScimSession.AuthHeader = 'Bearer super-secret-token'
        $err = $null
        try { Invoke-ScimRequest -Uri 'https://h/scim/v2/Users' -MaxRetries 0 } catch { $err = $_.Exception.Message }
        $err | Should -Not -BeNullOrEmpty
        $err | Should -Not -Match 'super-secret-token'
    }
}

Describe 'Connect-ScimAPI' {
    It 'builds a Basic header from username:password' {
        Connect-ScimAPI -BaseUrl 'https://h/scim/v2' -AuthMethod 'BasicAuth' -Username 'alice' -Password 'pw'
        $expected = 'Basic ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('alice:pw'))
        $script:ScimSession.AuthHeader | Should -Be $expected
        $script:ScimSession.BaseUrl    | Should -Be 'https://h/scim/v2'
    }

    It 'builds a Bearer header from a static API token' {
        Connect-ScimAPI -BaseUrl 'https://h/scim/v2/' -AuthMethod 'ApiToken' -ApiToken 'tok'
        $script:ScimSession.AuthHeader | Should -Be 'Bearer tok'
    }

    It 'exchanges client credentials for a bearer token and records its expiry' {
        Mock -CommandName Invoke-RestMethod -MockWith { [pscustomobject]@{ access_token = 'oauth-tok'; expires_in = 60 } }
        Connect-ScimAPI -BaseUrl 'https://h/scim/v2' -AuthMethod 'OAuth2CC' -TokenEndpoint 'https://idp/token' -ClientId 'c' -ClientSecret 's'
        $script:ScimSession.AuthHeader     | Should -Be 'Bearer oauth-tok'
        $script:ScimSession.TokenExpiresAt | Should -BeGreaterThan ([datetime]::UtcNow)
    }

    It 'rejects an incomplete credential set per auth method' {
        { Connect-ScimAPI -BaseUrl 'https://h' -AuthMethod 'BasicAuth' -Username 'u' } | Should -Throw '*username and password are required*'
        { Connect-ScimAPI -BaseUrl 'https://h' -AuthMethod 'ApiToken' }                | Should -Throw '*apiToken is required*'
        { Connect-ScimAPI -BaseUrl 'https://h' -AuthMethod 'OAuth2CC' -ClientId 'c' }  | Should -Throw '*tokenEndpoint is required*'
    }

    It 'rejects an auth method this crawler does not implement' {
        { Connect-ScimAPI -BaseUrl 'https://h' -AuthMethod 'ClientCert' } | Should -Throw
    }
}

Describe 'Get-ScimHeaders / Update-ScimSessionIfExpired' {
    It 'throws when nothing has connected yet' {
        $script:ScimSession = $null
        { Get-ScimHeaders } | Should -Throw '*not connected*'
    }

    It 'asks for scim+json and carries the session auth header' {
        $script:ScimSession = @{ AuthMethod = 'ApiToken'; AuthHeader = 'Bearer t' }
        $h = Get-ScimHeaders
        $h.Authorization | Should -Be 'Bearer t'
        $h.Accept        | Should -Be 'application/scim+json'
    }

    It 'refreshes an OAuth2 token that is inside the two-minute expiry margin' {
        Mock -CommandName Invoke-RestMethod -MockWith { [pscustomobject]@{ access_token = 'fresh'; expires_in = 3600 } }
        $script:ScimSession = @{ AuthMethod = 'OAuth2CC'; AuthHeader = 'Bearer stale'
                                 TokenExpiresAt = [datetime]::UtcNow.AddSeconds(30)
                                 _TokenEndpoint = 'https://idp/token'; _ClientId = 'c'; _ClientSecret = 's' }
        (Get-ScimHeaders).Authorization | Should -Be 'Bearer fresh'
    }

    It 'leaves a token that is comfortably valid alone' {
        Mock -CommandName Invoke-RestMethod -MockWith { throw 'must not be called' }
        $script:ScimSession = @{ AuthMethod = 'OAuth2CC'; AuthHeader = 'Bearer good'
                                 TokenExpiresAt = [datetime]::UtcNow.AddHours(1)
                                 _TokenEndpoint = 'https://idp/token' }
        (Get-ScimHeaders).Authorization | Should -Be 'Bearer good'
    }

    It 'never refreshes for a non-OAuth2 method' {
        Mock -CommandName Invoke-RestMethod -MockWith { throw 'must not be called' }
        $script:ScimSession = @{ AuthMethod = 'BasicAuth'; AuthHeader = 'Basic abc'; TokenExpiresAt = [datetime]::UtcNow.AddSeconds(-10) }
        (Get-ScimHeaders).Authorization | Should -Be 'Basic abc'
    }
}

Describe 'ConvertFrom-ScimConfigMap' {
    It 'defaults every object toggle to on' {
        $c = ConvertFrom-ScimConfigMap -Raw @{}
        $c.sync.users        | Should -BeTrue
        $c.sync.groups       | Should -BeTrue
        $c.sync.groupMembers | Should -BeTrue
    }

    It 'honours an explicit false toggle without turning the others off' {
        $c = ConvertFrom-ScimConfigMap -Raw @{ selectedObjects = @{ groupMembers = $false } }
        $c.sync.users        | Should -BeTrue
        $c.sync.groupMembers | Should -BeFalse
    }

    It 'defaults pageSize to 100 and rejects a nonsense value' {
        (ConvertFrom-ScimConfigMap -Raw @{}).pageSize                  | Should -Be 100
        (ConvertFrom-ScimConfigMap -Raw @{ pageSize = 25 }).pageSize   | Should -Be 25
        (ConvertFrom-ScimConfigMap -Raw @{ pageSize = 0 }).pageSize    | Should -Be 100
        (ConvertFrom-ScimConfigMap -Raw @{ pageSize = -5 }).pageSize   | Should -Be 100
    }

    It 'defaults the system name and keeps a configured one' {
        (ConvertFrom-ScimConfigMap -Raw @{}).systemName                        | Should -Be 'SCIM'
        (ConvertFrom-ScimConfigMap -Raw @{ systemName = 'SAP CIS' }).systemName | Should -Be 'SAP CIS'
    }

    It 'starts the attribute selections empty (opt-in) and passes a saved selection through' {
        (ConvertFrom-ScimConfigMap -Raw @{}).userAttributes.Count | Should -Be 0
        # selectedAttributes present but with no 'user' key must still mean "none",
        # not one empty attribute name.
        (ConvertFrom-ScimConfigMap -Raw @{ selectedAttributes = @{ group = @('description') } }).userAttributes.Count | Should -Be 0
        $c = ConvertFrom-ScimConfigMap -Raw @{ selectedAttributes = @{ user = @('department'); group = @('description') } }
        $c.userAttributes  | Should -Be @('department')
        $c.groupAttributes | Should -Be @('description')
    }

    It 'supplies the catch-all user-type mapping when none is configured' {
        $c = ConvertFrom-ScimConfigMap -Raw @{}
        $c.userTypeMapping.Count            | Should -Be 1
        $c.userTypeMapping[0].principalType | Should -Be 'User'
        $c.principalBuckets                 | Should -Be @('User')
    }

    It 'derives the reconcile buckets from the configured mapping' {
        $c = ConvertFrom-ScimConfigMap -Raw @{ userTypeMapping = @(
            @{ userType = 'service'; principalType = 'ServicePrincipal' }
            @{ userType = '';        principalType = 'User' }) }
        $c.principalBuckets | Should -Be @('User', 'ServicePrincipal')
    }

    It 'reports the requested sync mode so a delta request can be logged as a full run' {
        (ConvertFrom-ScimConfigMap -Raw @{}).requestedMode                     | Should -Be 'full'
        (ConvertFrom-ScimConfigMap -Raw @{ _syncMode = 'delta' }).requestedMode | Should -Be 'delta'
    }
}

Describe 'Get-ScimIdPrefix' {
    It 'namespaces deterministic ids per system so two endpoints cannot collide' {
        Get-ScimIdPrefix -SystemId 3  | Should -Be 'scim-sys3'
        Get-ScimIdPrefix -SystemId 42 | Should -Be 'scim-sys42'
    }
}

Describe 'Get-ScimBucketScope' {
    It 'adds the bucket value under the writer scope key' {
        $w = New-ScimIngestWriter -Endpoint 'ingest/principals' -SystemId 3 -ScopeKey 'principalType'
        (Get-ScimBucketScope -Writer $w -Bucket 'ServicePrincipal').principalType | Should -Be 'ServicePrincipal'
    }

    It 'keeps the fixed scope and adds nothing when the writer has no scope key' {
        $w = New-ScimIngestWriter -Endpoint 'ingest/resources' -SystemId 3 -FixedScope @{ resourceType = 'Group' }
        $scope = Get-ScimBucketScope -Writer $w -Bucket 'Group'
        $scope.resourceType | Should -Be 'Group'
        $scope.Count        | Should -Be 1
    }
}

Describe 'ScimIngestWriter — bucketed full-sync flush' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock -CommandName Invoke-IngestAPI -MockWith {
            $script:sent.Add([pscustomobject]@{ endpoint = $Endpoint; body = $Body })
            [pscustomobject]@{ syncId = 'sync-1'; inserted = 0; updated = 0; deleted = 0 }
        }
        Mock -CommandName Invoke-CrawlerIngestBatch -MockWith {
            $script:sent.Add([pscustomobject]@{ endpoint = $Endpoint; single = $true; scope = $Scope; records = $Records; idPrefix = $IdPrefix; idGeneration = $IdGeneration })
            @{ inserted = 0; updated = 0; deleted = 0 }
        }
    }

    It 'sends one full-sync batch per bucket, each scoped to its own principalType' {
        $w = New-ScimIngestWriter -Endpoint 'ingest/principals' -SystemId 7 -ScopeKey 'principalType'
        Add-ScimIngestRecord -Writer $w -Bucket 'User'             -Record @{ externalId = 'u-1' }
        Add-ScimIngestRecord -Writer $w -Bucket 'ServicePrincipal' -Record @{ externalId = 'sp-1' }
        Complete-ScimIngestWriter -Writer $w -DeclaredBuckets @('User', 'ServicePrincipal')

        $script:sent.Count | Should -Be 2
        $userBatch = @($script:sent | Where-Object { $_.scope.principalType -eq 'User' })
        $spBatch   = @($script:sent | Where-Object { $_.scope.principalType -eq 'ServicePrincipal' })
        $userBatch.Count | Should -Be 1
        $spBatch.Count   | Should -Be 1
        @($userBatch[0].records).Count | Should -Be 1
        $userBatch[0].records[0].externalId | Should -Be 'u-1'
        $userBatch[0].idGeneration | Should -Be 'deterministic'
        $userBatch[0].idPrefix     | Should -Be 'scim-sys7'
    }

    It 'flushes an EMPTY full-sync batch for a declared bucket that produced nothing' {
        # This is what lets a principalType that lost its last account have its stale
        # rows reconciled away instead of lingering forever.
        $w = New-ScimIngestWriter -Endpoint 'ingest/principals' -SystemId 7 -ScopeKey 'principalType'
        Add-ScimIngestRecord -Writer $w -Bucket 'User' -Record @{ externalId = 'u-1' }
        Complete-ScimIngestWriter -Writer $w -DeclaredBuckets @('User', 'ExternalUser')

        $empty = @($script:sent | Where-Object { $_.scope.principalType -eq 'ExternalUser' })
        $empty.Count | Should -Be 1
        @($empty[0].records).Count | Should -Be 0
    }

    It 'still reconciles when the whole run produced no records at all' {
        $w = New-ScimIngestWriter -Endpoint 'ingest/principals' -SystemId 7 -ScopeKey 'principalType'
        Complete-ScimIngestWriter -Writer $w -DeclaredBuckets @('User')
        $script:sent.Count | Should -Be 1
        @($script:sent[0].records).Count | Should -Be 0
    }

    It 'chunks a bucket larger than the batch size into ONE start→end sync session' {
        $w = New-ScimIngestWriter -Endpoint 'ingest/principals' -SystemId 7 -ScopeKey 'principalType' -BatchSize 2
        1..5 | ForEach-Object { Add-ScimIngestRecord -Writer $w -Bucket 'User' -Record @{ externalId = "u-$_" } }
        Complete-ScimIngestWriter -Writer $w -DeclaredBuckets @('User')

        $sessions = @($script:sent | ForEach-Object { $_.body.syncSession })
        $sessions[0]  | Should -Be 'start'
        $sessions[-1] | Should -Be 'end'
        # Every chunk after the first must carry the syncId the server handed back,
        # or the server would open a new session and the closing delete would only
        # see the last chunk.
        @($script:sent | Select-Object -Skip 1 | Where-Object { $_.body.syncId -ne 'sync-1' }).Count | Should -Be 0
        # All five records land exactly once.
        $total = 0
        foreach ($s in $script:sent) { $total += @($s.body.records).Count }
        $total | Should -Be 5
    }

    It 'sends the deterministic-id envelope on every chunk' {
        $w = New-ScimIngestWriter -Endpoint 'ingest/principals' -SystemId 7 -ScopeKey 'principalType' -BatchSize 2
        1..5 | ForEach-Object { Add-ScimIngestRecord -Writer $w -Bucket 'User' -Record @{ externalId = "u-$_" } }
        Complete-ScimIngestWriter -Writer $w -DeclaredBuckets @('User')
        foreach ($s in $script:sent) {
            $s.body.idGeneration | Should -Be 'deterministic'
            $s.body.idPrefix     | Should -Be 'scim-sys7-principals'
            $s.body.syncMode     | Should -Be 'full'
            $s.body.systemId     | Should -Be 7
        }
    }

    It 'ignores a $null record instead of sending a hole in the batch' {
        $w = New-ScimIngestWriter -Endpoint 'ingest/principals' -SystemId 7 -ScopeKey 'principalType'
        Add-ScimIngestRecord -Writer $w -Bucket 'User' -Record $null
        Complete-ScimIngestWriter -Writer $w -DeclaredBuckets @('User')
        $w.Records | Should -Be 0
        @($script:sent[0].records).Count | Should -Be 0
    }
}
