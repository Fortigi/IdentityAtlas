#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester 5 unit tests for the crawler helper libraries (midPoint REST client,
    Azure Resource Graph + ARM REST helpers, and OData GET/paged request layer).

.DESCRIPTION
    These files are DOT-SOURCED standalone scripts (not modules), so Invoke-RestMethod /
    Invoke-WebRequest are mocked in the current scope (NO -ModuleName). The Az module and
    the Graph SDK's Get-FGAccessToken are not installed in this environment, so stub
    functions are defined before dot-sourcing the Azure helpers.

    No live network calls are made.

.USAGE
    See the run recipe in the task; coverage is collected over the five helper files.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

    # Shared crawler helpers: Invoke-MidpointApi's retry loop calls
    # Test-TransientHttpStatus from here. Crawler entry points dot-source this
    # before their dependencies, so loading it first mirrors the real composition.
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')

    # ── Az / Graph SDK stubs (not installed) — defined before dot-sourcing so the
    #    Azure helpers resolve them; individual tests Mock them to assert/transform.
    function Get-FGAccessToken {
        [CmdletBinding()]
        param($ClientId, $ClientSecret, $TenantId, $Resource)
        $Global:AccessToken = 'stub-token'
    }

    # midPoint REST client
    . (Join-Path $script:repoRoot 'tools/crawlers/midpoint/Invoke-MidpointApi.ps1')

    # Azure RM (auth + paged GET) then Azure RG (ARG) — RG depends on RM's token refresh
    . (Join-Path $script:repoRoot 'tools/crawlers/azure-rm/Get-AzureRMHelpers.ps1')
    . (Join-Path $script:repoRoot 'tools/crawlers/azure-rm/Get-AzureRGHelpers.ps1')

    # OData base layer (auth + pagination) — load the whole odata dir except the
    # Start-* entry point (mandatory params) and Test-* (runs its own integration suite on dot-source).
    Get-ChildItem (Join-Path $script:repoRoot 'tools/crawlers/odata') -Filter '*.ps1' |
        Where-Object { $_.Name -notlike 'Start-*' -and $_.Name -notlike 'Test-*' } |
        ForEach-Object { . $_.FullName }
}

# ════════════════════════════════════════════════════════════════════════════════
#  midPoint — connection / auth
# ════════════════════════════════════════════════════════════════════════════════
Describe 'Get-MidpointRestRoot' {
    It 'leaves an already-rooted /ws/rest URL unchanged' {
        Get-MidpointRestRoot -BaseUrl 'https://h/midpoint/ws/rest' | Should -Be 'https://h/midpoint/ws/rest'
    }
    It 'appends /ws/rest to a /midpoint URL' {
        Get-MidpointRestRoot -BaseUrl 'https://h/midpoint' | Should -Be 'https://h/midpoint/ws/rest'
    }
    It 'trims a trailing slash before matching' {
        Get-MidpointRestRoot -BaseUrl 'https://h/midpoint/' | Should -Be 'https://h/midpoint/ws/rest'
    }
    It 'normalises a deeper /midpoint/ path back to the rest root' {
        Get-MidpointRestRoot -BaseUrl 'https://h/midpoint/admin/foo' | Should -Be 'https://h/midpoint/ws/rest'
    }
    It 'assumes /midpoint/ws/rest for a bare host' {
        Get-MidpointRestRoot -BaseUrl 'https://h' | Should -Be 'https://h/midpoint/ws/rest'
    }
}

Describe 'Connect-MidpointAPI — auth header construction' {
    It 'BasicAuth builds a Basic <base64> header' {
        Connect-MidpointAPI -BaseUrl 'https://h/midpoint' -AuthMethod 'BasicAuth' -Username 'admin' -Password 'pw'
        $expected = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('admin:pw'))
        $script:MidpointSession.AuthHeader | Should -Be "Basic $expected"
        $script:MidpointSession.RestRoot   | Should -Be 'https://h/midpoint/ws/rest'
    }
    It 'BasicAuth throws when username or password is missing' {
        { Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'BasicAuth' -Username 'admin' } | Should -Throw
    }
    It 'ApiToken builds a Bearer header' {
        Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'ApiToken' -ApiToken 'tok123'
        $script:MidpointSession.AuthHeader | Should -Be 'Bearer tok123'
    }
    It 'ApiToken throws when token is missing' {
        { Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'ApiToken' } | Should -Throw
    }
    It 'OAuth2CC acquires a token and stores expiry' {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = 'oauth-tok'; expires_in = 1800 } }
        Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'OAuth2CC' `
            -ClientId 'cid' -ClientSecret 'sec' -TokenEndpoint 'https://h/token'
        $script:MidpointSession.AuthHeader     | Should -Be 'Bearer oauth-tok'
        $script:MidpointSession.AccessToken    | Should -Be 'oauth-tok'
        $script:MidpointSession.TokenExpiresAt | Should -BeOfType ([datetime])
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Uri -eq 'https://h/token' }
    }
    It 'OAuth2ROPC sends username/password in the form body' {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = 'ropc-tok' } }
        Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'OAuth2ROPC' `
            -ClientId 'cid' -ClientSecret 'sec' -TokenEndpoint 'https://h/token' `
            -Username 'u' -Password 'p'
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Body.grant_type -eq 'password' -and $Body.username -eq 'u' -and $Body.password -eq 'p'
        }
    }
    It 'OAuth2 defaults expiry to 3600s when expires_in is absent' {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = 'x' } }
        Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'OAuth2CC' `
            -ClientId 'c' -ClientSecret 's' -TokenEndpoint 'https://h/token'
        $delta = $script:MidpointSession.TokenExpiresAt - [datetime]::UtcNow
        $delta.TotalSeconds | Should -BeGreaterThan 3000
    }
    It 'OAuth2 throws when tokenEndpoint is missing' {
        { Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'OAuth2CC' -ClientId 'c' -ClientSecret 's' } |
            Should -Throw
    }
    It 'OAuth2 wraps an HTTP failure into a descriptive throw' {
        Mock Invoke-RestMethod { throw 'boom' }
        { Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'OAuth2CC' `
            -ClientId 'c' -ClientSecret 's' -TokenEndpoint 'https://h/token' } |
            Should -Throw '*OAuth2*'
    }
}

Describe 'Get-MidpointHeaders / session guards' {
    It 'throws when not connected' {
        $script:MidpointSession = $null
        { Get-MidpointHeaders } | Should -Throw '*not connected*'
    }
    It 'returns Authorization + content/accept headers when connected' {
        Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'ApiToken' -ApiToken 'tok'
        $h = Get-MidpointHeaders
        $h.Authorization  | Should -Be 'Bearer tok'
        $h.'Content-Type' | Should -Be 'application/json'
        $h.Accept         | Should -Be 'application/json'
    }
    It 'Update-MidpointSessionIfExpired refreshes an expired OAuth2CC token' {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = 'fresh'; expires_in = 3600 } }
        Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'OAuth2CC' `
            -ClientId 'c' -ClientSecret 's' -TokenEndpoint 'https://h/token'
        # Force expiry into the past so the refresh fires
        $script:MidpointSession.TokenExpiresAt = [datetime]::UtcNow.AddMinutes(-10)
        Update-MidpointSessionIfExpired
        $script:MidpointSession.AccessToken | Should -Be 'fresh'
        Should -Invoke Invoke-RestMethod -Times 2   # initial connect + refresh
    }
    It 'Update-MidpointSessionIfExpired does nothing for a still-valid token' {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = 'tok1'; expires_in = 3600 } }
        Connect-MidpointAPI -BaseUrl 'https://h' -AuthMethod 'OAuth2CC' `
            -ClientId 'c' -ClientSecret 's' -TokenEndpoint 'https://h/token'
        Update-MidpointSessionIfExpired
        Should -Invoke Invoke-RestMethod -Times 1   # only the initial connect
    }
}

# ════════════════════════════════════════════════════════════════════════════════
#  midPoint — requests (GET / search / retry)
# ════════════════════════════════════════════════════════════════════════════════
Describe 'Invoke-MidpointGet' {
    BeforeEach {
        Connect-MidpointAPI -BaseUrl 'https://h/midpoint' -AuthMethod 'ApiToken' -ApiToken 'tok'
    }
    It 'GETs by OID and unwraps the single-key envelope' {
        Mock Invoke-RestMethod { [pscustomobject]@{ user = [pscustomobject]@{ oid = '1'; name = 'alice' } } }
        $obj = Invoke-MidpointGet -Type 'users' -Oid '1'
        $obj.oid  | Should -Be '1'
        $obj.name | Should -Be 'alice'
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://h/midpoint/ws/rest/users/1' -and $Method -eq 'Get'
        }
    }
    It 'sends the Bearer auth header' {
        Mock Invoke-RestMethod { [pscustomobject]@{ user = [pscustomobject]@{ oid = '1' } } }
        Invoke-MidpointGet -Type 'users' -Oid '1' | Out-Null
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Headers.Authorization -eq 'Bearer tok'
        }
    }
    It 'returns $null on a 404' {
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 404 } }
            $ex = [System.Exception]::new('not found')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
            throw $ex
        }
        Invoke-MidpointGet -Type 'users' -Oid 'missing' | Should -Be $null
    }
    It 'rethrows a non-404 error' {
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 403 } }
            $ex = [System.Exception]::new('forbidden')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
            throw $ex
        }
        { Invoke-MidpointGet -Type 'users' -Oid 'x' } | Should -Throw
    }
}

Describe 'Invoke-MidpointRequest — retry/backoff' {
    BeforeEach {
        Connect-MidpointAPI -BaseUrl 'https://h/midpoint' -AuthMethod 'ApiToken' -ApiToken 'tok'
        Mock Start-Sleep { }
    }
    It 'returns the parsed body on first success' {
        Mock Invoke-RestMethod { [pscustomobject]@{ ok = $true } }
        (Invoke-MidpointRequest -Method Get -Uri 'https://h/x').ok | Should -BeTrue
        Should -Invoke Invoke-RestMethod -Times 1
    }
    It 'retries a transient 500 then succeeds' {
        $script:calls = 0
        Mock Invoke-RestMethod {
            $script:calls++
            if ($script:calls -lt 2) {
                $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 500 } }
                $ex = [System.Exception]::new('err')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
                throw $ex
            }
            [pscustomobject]@{ ok = $true }
        }
        (Invoke-MidpointRequest -Method Get -Uri 'https://h/x' -MaxRetries 4).ok | Should -BeTrue
        Should -Invoke Invoke-RestMethod -Times 2
        Should -Invoke Start-Sleep -Times 1
    }
    It 'retries on 429' {
        $script:calls429 = 0
        Mock Invoke-RestMethod {
            $script:calls429++
            if ($script:calls429 -lt 2) {
                $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 429 } }
                $ex = [System.Exception]::new('throttled')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
                throw $ex
            }
            [pscustomobject]@{ ok = $true }
        }
        Invoke-MidpointRequest -Method Get -Uri 'https://h/x' -MaxRetries 4 | Out-Null
        Should -Invoke Invoke-RestMethod -Times 2
    }
    It 'does not retry a non-transient 400 — throws immediately' {
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 400 } }
            $ex = [System.Exception]::new('bad request')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
            throw $ex
        }
        { Invoke-MidpointRequest -Method Get -Uri 'https://h/x' -MaxRetries 4 } | Should -Throw
        Should -Invoke Invoke-RestMethod -Times 1
    }
    It 'gives up after MaxRetries on persistent 500' {
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 500 } }
            $ex = [System.Exception]::new('err')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
            throw $ex
        }
        { Invoke-MidpointRequest -Method Get -Uri 'https://h/x' -MaxRetries 2 } | Should -Throw
        Should -Invoke Invoke-RestMethod -Times 3   # initial + 2 retries
    }
}

Describe 'Invoke-MidpointSearch — paging' {
    BeforeEach {
        Connect-MidpointAPI -BaseUrl 'https://h/midpoint' -AuthMethod 'ApiToken' -ApiToken 'tok'
    }
    It 'POSTs to /{type}/search and returns a flat array' {
        Mock Invoke-RestMethod {
            [pscustomobject]@{ object = [pscustomobject]@{ object = @(
                [pscustomobject]@{ oid = 'a' }, [pscustomobject]@{ oid = 'b' }) } }
        }
        $r = Invoke-MidpointSearch -Type 'users' -PageSize 100
        @($r).Count | Should -Be 2
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://h/midpoint/ws/rest/users/search' -and $Method -eq 'Post'
        }
    }
    It 'walks multiple pages until a short page ends it' {
        $script:page = 0
        Mock Invoke-RestMethod {
            $script:page++
            if ($script:page -eq 1) {
                [pscustomobject]@{ object = [pscustomobject]@{ object = @(
                    [pscustomobject]@{ oid = '1' }, [pscustomobject]@{ oid = '2' }) } }
            } else {
                [pscustomobject]@{ object = [pscustomobject]@{ object = @([pscustomobject]@{ oid = '3' }) } }
            }
        }
        $r = Invoke-MidpointSearch -Type 'users' -PageSize 2
        @($r).Count | Should -Be 3
        Should -Invoke Invoke-RestMethod -Times 2
    }
    It 'honours MaxItems as a hard cap' {
        Mock Invoke-RestMethod {
            [pscustomobject]@{ object = [pscustomobject]@{ object = @(
                [pscustomobject]@{ oid = '1' }, [pscustomobject]@{ oid = '2' },
                [pscustomobject]@{ oid = '3' }) } }
        }
        $r = Invoke-MidpointSearch -Type 'users' -PageSize 100 -MaxItems 2
        @($r).Count | Should -Be 2
    }
    It 'appends options and include as query string' {
        Mock Invoke-RestMethod { [pscustomobject]@{ object = [pscustomobject]@{ object = @() } } }
        Invoke-MidpointSearch -Type 'shadows' -Options 'raw' -Include 'association' | Out-Null
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://h/midpoint/ws/rest/shadows/search?options=raw&include=association'
        }
    }
    It 'returns an empty array when the envelope is empty' {
        Mock Invoke-RestMethod { [pscustomobject]@{ object = $null } }
        @(Invoke-MidpointSearch -Type 'users').Count | Should -Be 0
    }
}

Describe 'Invoke-MidpointSearchStream — per-page callback' {
    BeforeEach {
        Connect-MidpointAPI -BaseUrl 'https://h/midpoint' -AuthMethod 'ApiToken' -ApiToken 'tok'
    }
    It 'invokes OnPage for each page and returns the total count' {
        $script:spage = 0
        Mock Invoke-RestMethod {
            $script:spage++
            if ($script:spage -eq 1) {
                [pscustomobject]@{ object = [pscustomobject]@{ object = @(
                    [pscustomobject]@{ oid = '1' }, [pscustomobject]@{ oid = '2' }) } }
            } else {
                [pscustomobject]@{ object = [pscustomobject]@{ object = @([pscustomobject]@{ oid = '3' }) } }
            }
        }
        $seen = [System.Collections.Generic.List[object]]::new()
        $total = Invoke-MidpointSearchStream -Type 'shadows' -PageSize 2 -OnPage { param($p) foreach ($o in $p) { $seen.Add($o) } }
        $total      | Should -Be 3
        $seen.Count | Should -Be 3
    }
}

Describe 'ConvertTo-MidpointObjectArray' {
    It 'returns empty array when outer object is null' {
        @(ConvertTo-MidpointObjectArray -SearchResponse ([pscustomobject]@{ object = $null })).Count | Should -Be 0
    }
    It 'returns empty array when inner object is null' {
        $resp = [pscustomobject]@{ object = [pscustomobject]@{ object = $null } }
        @(ConvertTo-MidpointObjectArray -SearchResponse $resp).Count | Should -Be 0
    }
    It 'wraps a single (non-array) inner object into a one-element array' {
        $resp = [pscustomobject]@{ object = [pscustomobject]@{ object = [pscustomobject]@{ oid = 'solo' } } }
        $r = ConvertTo-MidpointObjectArray -SearchResponse $resp
        @($r).Count | Should -Be 1
        $r[0].oid   | Should -Be 'solo'
    }
    It 'returns a multi-element array as-is' {
        $resp = [pscustomobject]@{ object = [pscustomobject]@{ object = @(
            [pscustomobject]@{ oid = '1' }, [pscustomobject]@{ oid = '2' }) } }
        @(ConvertTo-MidpointObjectArray -SearchResponse $resp).Count | Should -Be 2
    }
}

# ════════════════════════════════════════════════════════════════════════════════
#  midPoint — ref / value helpers
# ════════════════════════════════════════════════════════════════════════════════
Describe 'Get-MidpointRefOid' {
    It 'returns Fallback for null' { Get-MidpointRefOid $null 'fb' | Should -Be 'fb' }
    It 'returns Fallback for empty array' { Get-MidpointRefOid @() 'fb' | Should -Be 'fb' }
    It 'takes the first of an array' {
        Get-MidpointRefOid @([pscustomobject]@{ oid = 'first' }, [pscustomobject]@{ oid = 'second' }) | Should -Be 'first'
    }
    It 'returns a plain string ref as-is' { Get-MidpointRefOid 'oid-str' | Should -Be 'oid-str' }
    It 'extracts .oid from a ref object' {
        Get-MidpointRefOid ([pscustomobject]@{ oid = 'abc' }) | Should -Be 'abc'
    }
    It 'returns Fallback when no oid present' {
        Get-MidpointRefOid ([pscustomobject]@{ name = 'x' }) 'none' | Should -Be 'none'
    }
}

Describe 'Get-MidpointRefType' {
    It 'returns Fallback for null' { Get-MidpointRefType $null 'fb' | Should -Be 'fb' }
    It 'strips a namespace prefix' {
        Get-MidpointRefType ([pscustomobject]@{ type = 'c:RoleType' }) | Should -Be 'RoleType'
    }
    It 'returns the type unchanged when unprefixed' {
        Get-MidpointRefType ([pscustomobject]@{ type = 'OrgType' }) | Should -Be 'OrgType'
    }
    It 'returns Fallback when type absent' {
        Get-MidpointRefType ([pscustomobject]@{ oid = 'x' }) 'fb' | Should -Be 'fb'
    }
    It 'takes the first of an array' {
        Get-MidpointRefType @([pscustomobject]@{ type = 'c:UserType' }) | Should -Be 'UserType'
    }
}

Describe 'Get-MidpointRefRelation / Test-MidpointDefaultRelation' {
    It 'extracts the relation' {
        Get-MidpointRefRelation ([pscustomobject]@{ relation = 'org:manager' }) | Should -Be 'org:manager'
    }
    It 'returns Fallback when relation absent' {
        Get-MidpointRefRelation ([pscustomobject]@{ oid = 'x' }) 'fb' | Should -Be 'fb'
    }
    It 'empty/absent relation is the default relation' {
        Test-MidpointDefaultRelation '' | Should -BeTrue
    }
    It 'bare "default" is the default relation' {
        Test-MidpointDefaultRelation 'default' | Should -BeTrue
    }
    It 'a namespaced :default is the default relation' {
        Test-MidpointDefaultRelation 'org:default' | Should -BeTrue
    }
    It 'manager is NOT the default relation' {
        Test-MidpointDefaultRelation 'org:manager' | Should -BeFalse
    }
}

Describe 'ConvertTo-MidpointDnKey' {
    It 'returns empty for whitespace' { ConvertTo-MidpointDnKey '   ' | Should -Be '' }
    It 'trims and lowercases' {
        ConvertTo-MidpointDnKey '  CN=Foo,OU=Bar  ' | Should -Be 'cn=foo,ou=bar'
    }
}

Describe 'Get-MidpointConstructionTargets' {
    It 'returns empty list for null construction' {
        (Get-MidpointConstructionTargets $null).Count | Should -Be 0
    }
    It 'returns empty when no associations' {
        (Get-MidpointConstructionTargets ([pscustomobject]@{ association = $null })).Count | Should -Be 0
    }
    It 'resolves a literal shadowRef' {
        $c = [pscustomobject]@{ association = @([pscustomobject]@{ shadowRef = [pscustomobject]@{ oid = 'shadow-1' } }) }
        $out = @(Get-MidpointConstructionTargets $c)
        $out.Count          | Should -Be 1
        $out[0].shadowOid   | Should -Be 'shadow-1'
        $out[0].searchKey   | Should -Be ''
    }
    It 'resolves an associationTargetSearch equal-filter into a normalised searchKey' {
        $c = [pscustomobject]@{ association = @([pscustomobject]@{
            outbound = [pscustomobject]@{ expression = [pscustomobject]@{
                associationTargetSearch = @([pscustomobject]@{
                    filter = @([pscustomobject]@{ equal = [pscustomobject]@{ value = 'CN=Group,OU=X' } }) }) } } }) }
        $out = @(Get-MidpointConstructionTargets $c)
        $out.Count        | Should -Be 1
        $out[0].shadowOid | Should -Be ''
        $out[0].searchKey | Should -Be 'cn=group,ou=x'
    }
}

Describe 'Resolve-MidpointDepartment' {
    It 'returns empty for null user or null map' {
        Resolve-MidpointDepartment $null @{} | Should -Be ''
        Resolve-MidpointDepartment ([pscustomobject]@{}) $null | Should -Be ''
    }
    It 'returns empty when user has no org refs' {
        Resolve-MidpointDepartment ([pscustomobject]@{ parentOrgRef = @() }) @{ 'o1' = 'Sales' } | Should -Be ''
    }
    It 'picks the default-relation org and resolves its name' {
        $user = [pscustomobject]@{ parentOrgRef = @(
            [pscustomobject]@{ oid = 'mgr'; relation = 'org:manager' },
            [pscustomobject]@{ oid = 'dep'; relation = 'org:default' }) }
        Resolve-MidpointDepartment $user @{ 'dep' = 'Engineering'; 'mgr' = 'Management' } | Should -Be 'Engineering'
    }
    It 'falls back to the first ref when none is the default relation' {
        $user = [pscustomobject]@{ parentOrgRef = @([pscustomobject]@{ oid = 'a'; relation = 'org:manager' }) }
        Resolve-MidpointDepartment $user @{ 'a' = 'TeamA' } | Should -Be 'TeamA'
    }
    It 'returns empty when the chosen org was not synced' {
        $user = [pscustomobject]@{ parentOrgRef = @([pscustomobject]@{ oid = 'unknown'; relation = 'org:default' }) }
        Resolve-MidpointDepartment $user @{ 'other' = 'X' } | Should -Be ''
    }
}

Describe 'Get-MidpointString' {
    It 'returns Fallback for null' { Get-MidpointString $null 'fb' | Should -Be 'fb' }
    It 'returns a plain string as-is' { Get-MidpointString 'hello' | Should -Be 'hello' }
    It 'extracts .orig from a PolyString' {
        Get-MidpointString ([pscustomobject]@{ orig = 'Orig'; norm = 'orig' }) | Should -Be 'Orig'
    }
    It 'falls back to .norm when no .orig' {
        Get-MidpointString ([pscustomobject]@{ norm = 'normval' }) | Should -Be 'normval'
    }
    It 'returns the first non-null value of an array' {
        Get-MidpointString @($null, 'second', 'third') | Should -Be 'second'
    }
}

Describe 'Get-MidpointStringList' {
    It 'returns empty array for null' { (Get-MidpointStringList $null).Count | Should -Be 0 }
    It 'collects all values, dropping empties' {
        $r = Get-MidpointStringList @('a', '', [pscustomobject]@{ orig = 'b' })
        @($r).Count | Should -Be 2
        $r           | Should -Contain 'a'
        $r           | Should -Contain 'b'
    }
}

Describe 'ConvertTo-MapRows' {
    It 'returns empty array for null' { (ConvertTo-MapRows $null @('a')).Count | Should -Be 0 }
    It 'maps keys and trims values, blank for missing' {
        $raw = @([pscustomobject]@{ archetype = '  App  '; subtype = $null })
        $rows = ConvertTo-MapRows $raw @('archetype', 'subtype', 'resourceType')
        $rows[0].archetype    | Should -Be 'App'
        $rows[0].subtype      | Should -Be ''
        $rows[0].resourceType | Should -Be ''
    }
}

Describe 'Get-MidpointArchetypeNames' {
    It 'resolves archetypeRefs to deduped labels' {
        $obj = [pscustomobject]@{ archetypeRef = @(
            [pscustomobject]@{ oid = 'a1' }, [pscustomobject]@{ oid = 'a2' }) }
        $map = @{ 'a1' = @('Birthright'); 'a2' = @('Birthright', 'AppRole') }
        $r = Get-MidpointArchetypeNames $obj $map
        @($r).Count | Should -Be 2
        $r          | Should -Contain 'Birthright'
        $r          | Should -Contain 'AppRole'
    }
    It 'returns empty when no archetypeRef matches' {
        $obj = [pscustomobject]@{ archetypeRef = @([pscustomobject]@{ oid = 'x' }) }
        (Get-MidpointArchetypeNames $obj @{}).Count | Should -Be 0
    }
}

Describe 'Resolve-MappedResourceType' {
    BeforeAll {
        $rows = @(
            [pscustomobject]@{ archetype = 'App'; subtype = ''; resourceType = 'Application' },
            [pscustomobject]@{ archetype = ''; subtype = 'birthright'; resourceType = 'BusinessRole' },
            [pscustomobject]@{ archetype = ''; subtype = ''; resourceType = 'CatchAll' }
        )
    }
    It 'matches an archetype first' {
        Resolve-MappedResourceType $rows @('App') @() 'Default' | Should -Be 'Application'
    }
    It 'matches a subtype when no archetype matches' {
        Resolve-MappedResourceType $rows @('Other') @('birthright') 'Default' | Should -Be 'BusinessRole'
    }
    It 'falls to the catch-all row' {
        Resolve-MappedResourceType $rows @() @() 'Default' | Should -Be 'CatchAll'
    }
    It 'returns Default when no rows match and no catch-all' {
        $r = @([pscustomobject]@{ archetype = 'X'; subtype = ''; resourceType = 'Y' })
        Resolve-MappedResourceType $r @() @() 'FallbackType' | Should -Be 'FallbackType'
    }
}

Describe 'Resolve-MappedValue' {
    BeforeAll {
        $rows = @(
            [pscustomobject]@{ orgType = 'Department'; contextType = 'OrgUnit' },
            [pscustomobject]@{ orgType = ''; contextType = 'GenericCtx' }
        )
    }
    It 'matches a keyed row' {
        Resolve-MappedValue @('Department') $rows 'orgType' 'contextType' 'Def' | Should -Be 'OrgUnit'
    }
    It 'falls to the catch-all (blank key) row' {
        Resolve-MappedValue @('Unknown') $rows 'orgType' 'contextType' 'Def' | Should -Be 'GenericCtx'
    }
    It 'returns Default when nothing matches' {
        $r = @([pscustomobject]@{ orgType = 'X'; contextType = 'Y' })
        Resolve-MappedValue @('nope') $r 'orgType' 'contextType' 'Def' | Should -Be 'Def'
    }
}

Describe 'Get-MidpointAttrValue' {
    It 'returns null when shadow has no attributes' {
        Get-MidpointAttrValue ([pscustomobject]@{}) @('dn') | Should -Be $null
    }
    It 'reads a ri:-prefixed typed-scalar value' {
        $shadow = [pscustomobject]@{ attributes = [pscustomobject]@{ 'ri:dn' = [pscustomobject]@{ '@value' = 'CN=Foo' } } }
        Get-MidpointAttrValue $shadow @('dn') | Should -Be 'CN=Foo'
    }
    It 'reads the first non-empty value of an array attribute' {
        $shadow = [pscustomobject]@{ attributes = [pscustomobject]@{ 'ri:mail' = @([pscustomobject]@{ '@value' = 'a@b.com' }) } }
        Get-MidpointAttrValue $shadow @('mail') | Should -Be 'a@b.com'
    }
    It 'returns null when no requested key matches' {
        $shadow = [pscustomobject]@{ attributes = [pscustomobject]@{ 'ri:dn' = [pscustomobject]@{ '@value' = 'x' } } }
        Get-MidpointAttrValue $shadow @('mail') | Should -Be $null
    }
}

Describe 'Format-AccountLabel' {
    It 'extracts the CN component from a DN' {
        Format-AccountLabel 'CN=Andrea Hill,OU=Users,DC=corp' | Should -Be 'Andrea Hill'
    }
    It 'stops at a bracketed suffix' {
        Format-AccountLabel 'CN=Andrea Hill [adm],OU=x' | Should -Be 'Andrea Hill'
    }
    It 'returns the raw value when no CN present' {
        Format-AccountLabel 'plain-name' | Should -Be 'plain-name'
    }
}

Describe 'New-StableGuid' {
    It 'is deterministic for the same seed' {
        New-StableGuid 'seed-1' | Should -Be (New-StableGuid 'seed-1')
    }
    It 'differs for different seeds' {
        New-StableGuid 'seed-1' | Should -Not -Be (New-StableGuid 'seed-2')
    }
    It 'returns a parseable GUID' {
        { [guid]::Parse((New-StableGuid 'x')) } | Should -Not -Throw
    }
}

Describe 'Convert-MidpointOutcome' {
    It 'maps accept to Certify' { Convert-MidpointOutcome 'accept' | Should -Be 'Certify' }
    It 'maps revoke to Revoke' { Convert-MidpointOutcome 'revoke' | Should -Be 'Revoke' }
    It 'maps reduce to Reduce' { Convert-MidpointOutcome 'reduce' | Should -Be 'Reduce' }
    It 'maps notDecided to NoDecision' { Convert-MidpointOutcome 'notDecided' | Should -Be 'NoDecision' }
    It 'maps noResponse to NoResponse' { Convert-MidpointOutcome 'noResponse' | Should -Be 'NoResponse' }
    It 'passes through an unknown non-empty outcome' { Convert-MidpointOutcome 'weird' | Should -Be 'weird' }
    It 'defaults empty to NoDecision' { Convert-MidpointOutcome '' | Should -Be 'NoDecision' }
}

Describe 'Test-MidpointEnabled' {
    It 'enabled when no activation present' {
        Test-MidpointEnabled ([pscustomobject]@{}) | Should -BeTrue
    }
    It 'reads effectiveStatus' {
        Test-MidpointEnabled ([pscustomobject]@{ activation = [pscustomobject]@{ effectiveStatus = 'disabled' } }) | Should -BeFalse
        Test-MidpointEnabled ([pscustomobject]@{ activation = [pscustomobject]@{ effectiveStatus = 'enabled' } }) | Should -BeTrue
    }
    It 'falls back to administrativeStatus' {
        Test-MidpointEnabled ([pscustomobject]@{ activation = [pscustomobject]@{ administrativeStatus = 'enabled' } }) | Should -BeTrue
        Test-MidpointEnabled ([pscustomobject]@{ activation = [pscustomobject]@{ administrativeStatus = 'disabled' } }) | Should -BeFalse
    }
}

# ════════════════════════════════════════════════════════════════════════════════
#  Azure RM — auth + paged GET
# ════════════════════════════════════════════════════════════════════════════════
Describe 'Connect-AzureRM / Update-ARMTokenIfNeeded' {
    BeforeEach {
        $script:ARMSession = $null
        $Global:AccessToken = $null
    }
    It 'acquires a token and stores the session' {
        Mock Get-FGAccessToken { $Global:AccessToken = 'arm-tok' }
        Connect-AzureRM -TenantId 't' -ClientId 'c' -ClientSecret 's'
        $script:ARMSession.TenantId | Should -Be 't'
        Should -Invoke Get-FGAccessToken -Times 1 -ParameterFilter { $Resource -eq 'https://management.azure.com/' }
    }
    It 'throws when no token is acquired' {
        Mock Get-FGAccessToken { $Global:AccessToken = $null }
        { Connect-AzureRM -TenantId 't' -ClientId 'c' -ClientSecret 's' } | Should -Throw '*access token*'
    }
    It 'Update-ARMTokenIfNeeded throws when not connected' {
        { Update-ARMTokenIfNeeded } | Should -Throw '*not connected*'
    }
    It 'refreshes the token once it is older than 45 minutes' {
        Mock Get-FGAccessToken { $Global:AccessToken = 'tok' }
        Connect-AzureRM -TenantId 't' -ClientId 'c' -ClientSecret 's'
        $script:ARMSession.AcquiredAt = [datetime]::UtcNow.AddMinutes(-50)
        Update-ARMTokenIfNeeded
        Should -Invoke Get-FGAccessToken -Times 2   # connect + refresh
    }
    It 'does not refresh a fresh token' {
        Mock Get-FGAccessToken { $Global:AccessToken = 'tok' }
        Connect-AzureRM -TenantId 't' -ClientId 'c' -ClientSecret 's'
        Update-ARMTokenIfNeeded
        Should -Invoke Get-FGAccessToken -Times 1
    }
}

Describe 'Resolve-ARMUri' {
    It 'returns an absolute URL unchanged' {
        Resolve-ARMUri -Path 'https://other.com/x' | Should -Be 'https://other.com/x'
    }
    It 'prefixes the ARM base for a path' {
        Resolve-ARMUri -Path '/subscriptions/abc' | Should -Be 'https://management.azure.com/subscriptions/abc'
    }
}

Describe 'Invoke-ARMRequestRaw / Invoke-ARMList / Invoke-ARMGet' {
    BeforeEach {
        Mock Get-FGAccessToken { $Global:AccessToken = 'arm-tok' }
        Connect-AzureRM -TenantId 't' -ClientId 'c' -ClientSecret 's'
        $Global:AzCallCount = 0
        Mock Start-Sleep { }
    }
    It 'GETs with the bearer header and increments AzCallCount' {
        Mock Invoke-RestMethod { [pscustomobject]@{ value = @(1, 2) } }
        Invoke-ARMGet -Path '/x' | Out-Null
        $Global:AzCallCount | Should -Be 1
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Headers.Authorization -eq 'Bearer arm-tok' -and $Method -eq 'Get'
        }
    }
    It 'Invoke-ARMList follows nextLink across pages and flattens value' {
        $script:p = 0
        Mock Invoke-RestMethod {
            $script:p++
            if ($script:p -eq 1) {
                [pscustomobject]@{ value = @([pscustomobject]@{ id = '1' }); nextLink = 'https://management.azure.com/next' }
            } else {
                [pscustomobject]@{ value = @([pscustomobject]@{ id = '2' }) }
            }
        }
        $items = Invoke-ARMList -Path '/resources'
        @($items).Count | Should -Be 2
        Should -Invoke Invoke-RestMethod -Times 2
    }
    It 'retries a transient 503 then succeeds' {
        $script:c = 0
        Mock Invoke-RestMethod {
            $script:c++
            if ($script:c -lt 2) {
                $resp = [pscustomobject]@{ StatusCode = 503; Headers = @{} }
                $ex = [System.Exception]::new('err')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
                throw $ex
            }
            [pscustomobject]@{ value = @() }
        }
        Invoke-ARMList -Path '/x' | Out-Null
        Should -Invoke Invoke-RestMethod -Times 2
        Should -Invoke Start-Sleep -Times 1
    }
    It 'gives up after MaxRetries on a persistent 500' {
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = 500; Headers = @{} }
            $ex = [System.Exception]::new('err')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
            throw $ex
        }
        { Invoke-ARMGet -Path '/x' -MaxRetries 1 } | Should -Throw
        Should -Invoke Invoke-RestMethod -Times 2   # initial + 1 retry
    }
}

# ════════════════════════════════════════════════════════════════════════════════
#  Azure Resource Graph (ARG) helpers
# ════════════════════════════════════════════════════════════════════════════════
Describe 'Invoke-ARGQuery / Invoke-ARGRequestRaw' {
    BeforeEach {
        Mock Get-FGAccessToken { $Global:AccessToken = 'arm-tok' }
        Connect-AzureRM -TenantId 't' -ClientId 'c' -ClientSecret 's'
        $Global:AzCallCount = 0
        Mock Start-Sleep { }
    }
    It 'POSTs a subscription-scoped query and returns the flat data rows' {
        Mock Invoke-RestMethod {
            [pscustomobject]@{ data = @([pscustomobject]@{ id = 'r1' }, [pscustomobject]@{ id = 'r2' }) }
        }
        $rows = Invoke-ARGQuery -Query 'resources' -SubscriptionIds @('sub-1')
        @($rows).Count | Should -Be 2
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -like '*Microsoft.ResourceGraph/resources*' -and $Method -eq 'Post'
        }
    }
    It 'follows $skipToken across pages' {
        $script:argp = 0
        Mock Invoke-RestMethod {
            $script:argp++
            if ($script:argp -eq 1) {
                [pscustomobject]@{ data = @([pscustomobject]@{ id = '1' }); '$skipToken' = 'tok2' }
            } else {
                [pscustomobject]@{ data = @([pscustomobject]@{ id = '2' }) }
            }
        }
        $rows = Invoke-ARGQuery -Query 'resources' -SubscriptionIds @('sub-1')
        @($rows).Count | Should -Be 2
        Should -Invoke Invoke-RestMethod -Times 2
    }
    It 'scopes by management group when supplied (single query)' {
        Mock Invoke-RestMethod { [pscustomobject]@{ data = @() } }
        Invoke-ARGQuery -Query 'authorizationresources' -ManagementGroups @('mg-root') -ScopeFilter 'AtScopeAndAbove' | Out-Null
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Body -like '*managementGroups*' -and $Body -like '*AtScopeAndAbove*'
        }
    }
    It 'retries a transient 429 then succeeds' {
        $script:argc = 0
        Mock Invoke-RestMethod {
            $script:argc++
            if ($script:argc -lt 2) {
                $resp = [pscustomobject]@{ StatusCode = 429; Headers = @{} }
                $ex = [System.Exception]::new('throttled')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
                throw $ex
            }
            [pscustomobject]@{ data = @() }
        }
        Invoke-ARGQuery -Query 'resources' -SubscriptionIds @('sub-1') | Out-Null
        Should -Invoke Invoke-RestMethod -Times 2
    }
}

Describe 'ARG typed reads' {
    BeforeEach {
        Mock Get-FGAccessToken { $Global:AccessToken = 'arm-tok' }
        Connect-AzureRM -TenantId 't' -ClientId 'c' -ClientSecret 's'
        $Global:AzCallCount = 0
        Mock Start-Sleep { }
    }
    It 'Get-ARGResourceGroups queries resourcecontainers' {
        Mock Invoke-RestMethod { [pscustomobject]@{ data = @([pscustomobject]@{ id = 'rg1'; name = 'rg1'; subscriptionId = 'sub' }) } }
        $r = Get-ARGResourceGroups -SubscriptionIds @('sub')
        @($r).Count | Should -Be 1
        Should -Invoke Invoke-RestMethod -ParameterFilter { $Body -like '*resourcecontainers*' }
    }
    It 'Get-ARGResources queries resources' {
        Mock Invoke-RestMethod { [pscustomobject]@{ data = @() } }
        Get-ARGResources -SubscriptionIds @('sub') | Out-Null
        Should -Invoke Invoke-RestMethod -ParameterFilter { $Body -like '*| project id, name, type, location*' }
    }
    It 'Get-ARGRoleDefinitions uses AtScopeAndAbove' {
        Mock Invoke-RestMethod { [pscustomobject]@{ data = @() } }
        Get-ARGRoleDefinitions -SubscriptionIds @('sub') | Out-Null
        Should -Invoke Invoke-RestMethod -ParameterFilter { $Body -like '*AtScopeAndAbove*' }
    }
    It 'Get-ARGRoleAssignments uses AtScopeAboveAndBelow' {
        Mock Invoke-RestMethod { [pscustomobject]@{ data = @() } }
        Get-ARGRoleAssignments -SubscriptionIds @('sub') | Out-Null
        Should -Invoke Invoke-RestMethod -ParameterFilter { $Body -like '*AtScopeAboveAndBelow*' }
    }
    It 'Get-ARGSubscriptionMgChains builds a subscriptionId → mg-ancestor map' {
        Mock Invoke-RestMethod {
            [pscustomobject]@{ data = @([pscustomobject]@{
                subscriptionId = 'sub-1'
                chain = @([pscustomobject]@{ name = 'mg-team' }, [pscustomobject]@{ name = 'mg-root' }) }) }
        }
        $map = Get-ARGSubscriptionMgChains -SubscriptionIds @('sub-1')
        $map['sub-1']        | Should -Be @('mg-team', 'mg-root')
    }
}

# ════════════════════════════════════════════════════════════════════════════════
#  OData GET / Paged — deepen beyond the existing Omada tests
# ════════════════════════════════════════════════════════════════════════════════
Describe 'Invoke-ODataGetRequest — guards' {
    It 'throws when not connected' {
        $script:ODataSession = $null
        { Invoke-ODataGetRequest -Path '/Users' } | Should -Throw '*not connected*'
    }
}

Describe 'Invoke-ODataGetRequest — fetch + paging' {
    BeforeEach {
        Connect-ODataAPI -BaseUrl 'https://omada.example.com/odata/dataobjects' -AuthMethod 'ApiToken' -ApiToken 'tok'
        Mock Start-Sleep { }
    }
    It 'GETs a path and returns the .value array' {
        Mock Invoke-RestMethod { [pscustomobject]@{ value = @([pscustomobject]@{ id = 1 }, [pscustomobject]@{ id = 2 }) } }
        $r = Invoke-ODataGetRequest -Path '/Users'
        @($r).Count | Should -Be 2
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://omada.example.com/odata/dataobjects/Users' -and
            $Headers.Authorization -eq 'Bearer tok'
        }
    }
    It 'builds a query string from QueryParams (escaped)' {
        Mock Invoke-RestMethod { [pscustomobject]@{ value = @() } }
        Invoke-ODataGetRequest -Path '/Users' -QueryParams @{ filter = 'a b' } | Out-Null
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://omada.example.com/odata/dataobjects/Users?filter=a%20b'
        }
    }
    It 'follows @odata.nextLink until exhausted' {
        $script:onl = 0
        Mock Invoke-RestMethod {
            $script:onl++
            if ($script:onl -eq 1) {
                [pscustomobject]@{ value = @([pscustomobject]@{ id = 1 }); '@odata.nextLink' = 'https://omada.example.com/odata/dataobjects/Users?$skip=1' }
            } else {
                [pscustomobject]@{ value = @([pscustomobject]@{ id = 2 }) }
            }
        }
        $r = Invoke-ODataGetRequest -Path '/Users'
        @($r).Count | Should -Be 2
        Should -Invoke Invoke-RestMethod -Times 2
    }
    It 'wraps a bare (non-value) single response into a one-element array' {
        Mock Invoke-RestMethod { [pscustomobject]@{ id = 99; name = 'single' } }
        $r = Invoke-ODataGetRequest -Path '/Users/99'
        @($r).Count | Should -Be 1
        $r[0].id    | Should -Be 99
    }
    It 'retries a transient 503 then succeeds' {
        $script:o503 = 0
        Mock Invoke-RestMethod {
            $script:o503++
            if ($script:o503 -lt 2) {
                $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 503 } }
                $ex = [System.Exception]::new('err')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
                throw $ex
            }
            [pscustomobject]@{ value = @() }
        }
        Invoke-ODataGetRequest -Path '/Users' | Out-Null
        Should -Invoke Invoke-RestMethod -Times 2
        Should -Invoke Start-Sleep -Times 1
    }
    It 'throws on a non-transient 400' {
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 400 } }
            $ex = [System.Exception]::new('bad')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
            throw $ex
        }
        { Invoke-ODataGetRequest -Path '/Users' } | Should -Throw '*HTTP 400*'
        Should -Invoke Invoke-RestMethod -Times 1
    }
    It 'CookieString auth raises a helpful message on 401' {
        Connect-ODataAPI -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' `
            -AuthMethod 'CookieString' -CookieString 'oisauthtoken=abc'
        Mock Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = 401 } }
            $ex = [System.Exception]::new('unauth')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -PassThru | Out-Null
            throw $ex
        }
        { Invoke-ODataGetRequest -Path '/Users' } | Should -Throw '*cookie*'
    }
}

Describe 'Invoke-ODataPagedRequest — $skip paging' {
    BeforeEach {
        Connect-ODataAPI -BaseUrl 'https://omada.example.com/odata/dataobjects' -AuthMethod 'ApiToken' -ApiToken 'tok'
        Mock Start-Sleep { }
    }
    It 'throws when not connected' {
        $script:ODataSession = $null
        { Invoke-ODataPagedRequest -Path '/Users' } | Should -Throw '*not connected*'
    }
    It 'pages with $top/$skip until an empty page stops it' {
        $script:pp = 0
        Mock Invoke-RestMethod {
            $script:pp++
            if ($script:pp -le 2) {
                [pscustomobject]@{ value = @([pscustomobject]@{ id = $script:pp }) }
            } else {
                [pscustomobject]@{ value = @() }
            }
        }
        $r = Invoke-ODataPagedRequest -Path '/Users' -PageSize 1
        @($r).Count | Should -Be 2
        Should -Invoke Invoke-RestMethod -Times 3   # two data pages + one empty terminator
    }
    It 'passes $top and $skip in the request URI' {
        Mock Invoke-RestMethod { [pscustomobject]@{ value = @() } }
        Invoke-ODataPagedRequest -Path '/Users' -PageSize 50 | Out-Null
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -like '*$top=50*' -and $Uri -like '*$skip=0*'
        }
    }
}
