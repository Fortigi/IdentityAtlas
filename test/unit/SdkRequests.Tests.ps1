#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the IdentityAtlas PowerShell SDK HTTP request family
    and access-token functions (tools/powershell-sdk/graph/).

.DESCRIPTION
    Covers the GET/POST/PATCH/PUT/DELETE request wrappers (and their shared
    Invoke-FGGetPage / Invoke-FGWriteRequest helpers) plus the token lifecycle
    functions (Get-FGAccessToken*, Confirm-/Update-FGAccessToken*, Use-FG*,
    Read-/Save-FGToken, Test-FGConnection).

    All internal calls are mocked inside the IdentityAtlas module scope so no
    real network or OAuth traffic occurs. Each wrapper's built URI / body /
    method / headers are asserted via Should -Invoke -ParameterFilter, and the
    paging / error / retry branches are exercised where present.

.USAGE
    Invoke-Pester -Path test/unit/SdkRequests.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    Import-Module (Join-Path $script:repoRoot 'setup/IdentityAtlas.psd1') -Force -ErrorAction Stop
}

# ---------------------------------------------------------------------------
# Invoke-FGGetPage — the shared single-page fetcher with retry/throttle logic
# ---------------------------------------------------------------------------
Describe 'Invoke-FGGetPage' {
    BeforeAll {
        $Global:AccessToken = 'fake-token'
        $Global:ClientSecret = 'fake-secret'
        $Global:ClientId = 'fake-client'
        $Global:TenantId = 'fake-tenant'
    }
    AfterAll {
        $Global:AccessToken = $null
        $Global:ClientSecret = $null
        $Global:ClientId = $null
        $Global:TenantId = $null
    }

    It 'calls Invoke-RestMethod with GET, the URI, and a Bearer header' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ value = @('x') } }

        $r = Invoke-FGGetPage -URI 'https://graph.microsoft.com/v1.0/users'

        $r.value | Should -Be @('x')
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1 -ParameterFilter {
            $Method -eq 'Get' -and
            $Uri -eq 'https://graph.microsoft.com/v1.0/users' -and
            $Headers.Authorization -eq 'Bearer fake-token'
        }
    }

    It 'refreshes the token before fetching' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ value = @() } }

        Invoke-FGGetPage -URI 'https://graph.microsoft.com/v1.0/groups' | Out-Null

        Should -Invoke -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired -Times 1
    }

    It 'passes TimeoutSec through when greater than zero' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ value = @() } }

        Invoke-FGGetPage -URI 'https://graph.microsoft.com/v1.0/users' -TimeoutSec 30 | Out-Null

        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1 -ParameterFilter {
            $TimeoutSec -eq 30
        }
    }

    It 'retries on a transient 503 then succeeds' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Start-Sleep { }
        $script:callNo = 0
        Mock -ModuleName IdentityAtlas Invoke-RestMethod {
            $script:callNo++
            if ($script:callNo -eq 1) {
                $resp = [pscustomobject]@{ StatusCode = 503; Headers = $null }
                $ex = [System.Exception]::new('Service Unavailable')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
                throw $ex
            }
            [pscustomobject]@{ value = @('ok') }
        }

        $r = Invoke-FGGetPage -URI 'https://graph.microsoft.com/v1.0/users' -RetryDelays @(0, 0, 0)
        $r.value | Should -Be @('ok')
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 2
        Should -Invoke -ModuleName IdentityAtlas Start-Sleep -Times 1
    }

    It 'classifies an UnknownError message as transient and retries' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Start-Sleep { }
        $script:callNo2 = 0
        Mock -ModuleName IdentityAtlas Invoke-RestMethod {
            $script:callNo2++
            if ($script:callNo2 -eq 1) { throw [System.Exception]::new('UnknownError occurred') }
            [pscustomobject]@{ value = @('done') }
        }

        $r = Invoke-FGGetPage -URI 'https://graph.microsoft.com/v1.0/users' -RetryDelays @(0, 0, 0)
        $r.value | Should -Be @('done')
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 2
    }

    It 'honours the Retry-After header on a 429' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Start-Sleep { }
        $script:callNo3 = 0
        Mock -ModuleName IdentityAtlas Invoke-RestMethod {
            $script:callNo3++
            if ($script:callNo3 -eq 1) {
                $headers = @([pscustomobject]@{ Key = 'Retry-After'; Value = '7' })
                $resp = [pscustomobject]@{ StatusCode = 429; Headers = $headers }
                $ex = [System.Exception]::new('Too Many Requests')
                $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
                throw $ex
            }
            [pscustomobject]@{ value = @('throttled-ok') }
        }

        $r = Invoke-FGGetPage -URI 'https://graph.microsoft.com/v1.0/users' -RetryDelays @(1, 1, 1)
        $r.value | Should -Be @('throttled-ok')
        Should -Invoke -ModuleName IdentityAtlas Start-Sleep -Times 1 -ParameterFilter { $Seconds -eq 7 }
    }

    It 'rethrows a non-transient error without retrying' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = 404; Headers = $null }
            $ex = [System.Exception]::new('Not Found')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
            throw $ex
        }

        { Invoke-FGGetPage -URI 'https://graph.microsoft.com/v1.0/missing' } | Should -Throw
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1
    }

    It 'throws after exhausting retries on persistent transient errors' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Start-Sleep { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod {
            $resp = [pscustomobject]@{ StatusCode = 500; Headers = $null }
            $ex = [System.Exception]::new('Server Error')
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
            throw $ex
        }

        { Invoke-FGGetPage -URI 'https://graph.microsoft.com/v1.0/users' -MaxRetries 2 -RetryDelays @(0, 0, 0) } |
            Should -Throw
        # initial attempt + 2 retries = 3 calls
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 3
    }
}

# ---------------------------------------------------------------------------
# Invoke-FGGetRequest — pagination loop on top of Invoke-FGGetPage
# ---------------------------------------------------------------------------
Describe 'Invoke-FGGetRequest' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll { $Global:AccessToken = $null }

    It 'throws when no access token is set' {
        $Global:AccessToken = $null
        { Invoke-FGGetRequest -URI 'https://graph.microsoft.com/v1.0/users' } |
            Should -Throw '*No Access Token*'
        $Global:AccessToken = 'fake-token'
    }

    It 'returns the value array from a single page' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage { [pscustomobject]@{ value = @('a', 'b') } }
        Invoke-FGGetRequest -URI 'https://graph.microsoft.com/v1.0/users' | Should -Be @('a', 'b')
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetPage -Times 1 -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/v1.0/users'
        }
    }

    It 'returns the raw result when there is no value property' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage { [pscustomobject]@{ id = '123'; displayName = 'Bob' } }
        $r = Invoke-FGGetRequest -URI 'https://graph.microsoft.com/v1.0/users/123'
        $r.id | Should -Be '123'
    }

    It 'follows @odata.nextLink across pages' {
        $script:page = 0
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage {
            $script:page++
            if ($script:page -eq 1) {
                [pscustomobject]@{ value = @('a'); '@odata.nextLink' = 'https://graph.microsoft.com/next' }
            }
            else {
                [pscustomobject]@{ value = @('b') }
            }
        }

        $r = Invoke-FGGetRequest -URI 'https://graph.microsoft.com/v1.0/users'
        $r | Should -Be @('a', 'b')
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetPage -Times 2
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetPage -Times 1 -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/next'
        }
    }

    It 'forwards MaxRetries and TimeoutSec overrides to the page helper' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage { [pscustomobject]@{ value = @() } }
        Invoke-FGGetRequest -URI 'https://graph.microsoft.com/v1.0/x' -MaxRetries 1 -TimeoutSec 30 | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetPage -Times 1 -ParameterFilter {
            $MaxRetries -eq 1 -and $TimeoutSec -eq 30
        }
    }

    It 'writes debug output when DebugMode contains G' {
        $Global:DebugMode = 'G'
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage { [pscustomobject]@{ value = @('a') } }
        Mock -ModuleName IdentityAtlas Write-Host { }
        Invoke-FGGetRequest -URI 'https://graph.microsoft.com/v1.0/users' | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Write-Host -Times 1 -ParameterFilter { $Object -eq 'Invoke-FGGetRequest' }
        $Global:DebugMode = $null
    }
}

# ---------------------------------------------------------------------------
# Invoke-FGGetRequestStream — streaming variant
# ---------------------------------------------------------------------------
Describe 'Invoke-FGGetRequestStream' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll { $Global:AccessToken = $null }

    It 'throws when no access token is set' {
        $Global:AccessToken = $null
        { Invoke-FGGetRequestStream -URI 'https://graph.microsoft.com/v1.0/users' } |
            Should -Throw '*No Access Token*'
        $Global:AccessToken = 'fake-token'
    }

    It 'emits each item of every page to the pipeline' {
        $script:spage = 0
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage {
            $script:spage++
            if ($script:spage -eq 1) {
                [pscustomobject]@{ value = @('a', 'b'); '@odata.nextLink' = 'https://graph.microsoft.com/p2' }
            }
            else {
                [pscustomobject]@{ value = @('c') }
            }
        }

        $items = Invoke-FGGetRequestStream -URI 'https://graph.microsoft.com/v1.0/users'
        $items | Should -Be @('a', 'b', 'c')
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetPage -Times 2
    }

    It 'emits the raw result when there is no value property' {
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage { [pscustomobject]@{ id = '9' } }
        $r = Invoke-FGGetRequestStream -URI 'https://graph.microsoft.com/v1.0/users/9'
        $r.id | Should -Be '9'
    }
}

# ---------------------------------------------------------------------------
# Invoke-FGGetRequestToFile — writes paginated result to a JSON file
# ---------------------------------------------------------------------------
Describe 'Invoke-FGGetRequestToFile' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll { $Global:AccessToken = $null }

    It 'throws when no access token is set' {
        $Global:AccessToken = $null
        { Invoke-FGGetRequestToFile -URI 'https://graph.microsoft.com/v1.0/users' -File 'x.json' } |
            Should -Throw '*No Access Token*'
        $Global:AccessToken = 'fake-token'
    }

    It 'writes the fetched value array to the target file and merges it' {
        $tmp = Join-Path $TestDrive 'out.json'
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage { [pscustomobject]@{ value = @('a', 'b') } }
        Mock -ModuleName IdentityAtlas Merge-FGJsonArrayFile { }

        Invoke-FGGetRequestToFile -URI 'https://graph.microsoft.com/v1.0/users' -File $tmp

        Test-Path $tmp | Should -BeTrue
        Should -Invoke -ModuleName IdentityAtlas Merge-FGJsonArrayFile -Times 1 -ParameterFilter {
            $File -eq $tmp
        }
    }

    It 'appends additional pages when @odata.nextLink is present' {
        $tmp = Join-Path $TestDrive 'out2.json'
        $script:fpage = 0
        Mock -ModuleName IdentityAtlas Invoke-FGGetPage {
            $script:fpage++
            if ($script:fpage -eq 1) {
                [pscustomobject]@{ value = @('a'); '@odata.nextLink' = 'https://graph.microsoft.com/next' }
            }
            else {
                [pscustomobject]@{ value = @('b') }
            }
        }
        Mock -ModuleName IdentityAtlas Merge-FGJsonArrayFile { }

        Invoke-FGGetRequestToFile -URI 'https://graph.microsoft.com/v1.0/users' -File $tmp

        Should -Invoke -ModuleName IdentityAtlas Invoke-FGGetPage -Times 2
        Should -Invoke -ModuleName IdentityAtlas Merge-FGJsonArrayFile -Times 1
    }
}

# ---------------------------------------------------------------------------
# Invoke-FGWriteRequest + Post / Put wrappers
# ---------------------------------------------------------------------------
Describe 'Invoke-FGWriteRequest' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll { $Global:AccessToken = $null }

    It 'throws when no access token is set' {
        $Global:AccessToken = $null
        { Invoke-FGWriteRequest -Method Post -URI 'https://graph.microsoft.com/v1.0/users' -Body @{ a = 1 } } |
            Should -Throw '*No Access Token*'
        $Global:AccessToken = 'fake-token'
    }

    It 'serialises the body to JSON and calls Invoke-RestMethod with the method' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ id = 'created' } }

        $r = Invoke-FGWriteRequest -Method Post -URI 'https://graph.microsoft.com/v1.0/groups' -Body @{ displayName = 'G' }

        $r.id | Should -Be 'created'
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1 -ParameterFilter {
            $Method -eq 'Post' -and
            $Uri -eq 'https://graph.microsoft.com/v1.0/groups' -and
            $Headers.Authorization -eq 'Bearer fake-token' -and
            $Body -like '*displayName*'
        }
    }

    It 'returns the value property when the result has one' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ value = @('v1', 'v2') } }
        $r = Invoke-FGWriteRequest -Method Put -URI 'https://graph.microsoft.com/v1.0/x' -Body @{ a = 1 }
        $r | Should -Be @('v1', 'v2')
    }

    It 'rethrows when Invoke-RestMethod fails' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { throw 'boom' }
        { Invoke-FGWriteRequest -Method Post -URI 'https://graph.microsoft.com/v1.0/x' -Body @{ a = 1 } } |
            Should -Throw
    }

    It 'Invoke-FGPostRequest delegates with Method Post' {
        Mock -ModuleName IdentityAtlas Invoke-FGWriteRequest { }
        Invoke-FGPostRequest -URI 'https://graph.microsoft.com/v1.0/groups' -Body @{ a = 1 }
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGWriteRequest -Times 1 -ParameterFilter {
            $Method -eq 'Post' -and $URI -eq 'https://graph.microsoft.com/v1.0/groups'
        }
    }

    It 'Invoke-FGPutRequest delegates with Method Put' {
        Mock -ModuleName IdentityAtlas Invoke-FGWriteRequest { }
        Invoke-FGPutRequest -URI 'https://graph.microsoft.com/v1.0/groups/1' -Body @{ a = 1 }
        Should -Invoke -ModuleName IdentityAtlas Invoke-FGWriteRequest -Times 1 -ParameterFilter {
            $Method -eq 'Put' -and $URI -eq 'https://graph.microsoft.com/v1.0/groups/1'
        }
    }

    It 'writes debug output when DebugMode contains P' {
        $Global:DebugMode = 'P'
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ id = 'ok' } }
        Mock -ModuleName IdentityAtlas Write-Host { }
        Invoke-FGWriteRequest -Method Post -URI 'https://graph.microsoft.com/v1.0/x' -Body @{ a = 1 } | Out-Null
        Should -Invoke -ModuleName IdentityAtlas Write-Host -Times 1 -ParameterFilter { $Object -eq 'Invoke-FGPostRequest' }
        $Global:DebugMode = $null
    }
}

# ---------------------------------------------------------------------------
# Invoke-FGPatchRequest
# ---------------------------------------------------------------------------
Describe 'Invoke-FGPatchRequest' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll { $Global:AccessToken = $null }

    It 'throws when no access token is set' {
        $Global:AccessToken = $null
        { Invoke-FGPatchRequest -URI 'https://graph.microsoft.com/v1.0/users/1' -Body @{ a = 1 } } |
            Should -Throw '*No Access Token*'
        $Global:AccessToken = 'fake-token'
    }

    It 'sends a PATCH with a UTF-8 encoded body' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ id = 'patched' } }

        $r = Invoke-FGPatchRequest -URI 'https://graph.microsoft.com/v1.0/users/1' -Body @{ displayName = 'New' }

        $r.id | Should -Be 'patched'
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1 -ParameterFilter {
            $Method -eq 'PATCH' -and
            $Uri -eq 'https://graph.microsoft.com/v1.0/users/1' -and
            $Headers.Authorization -eq 'Bearer fake-token' -and
            $Body -is [byte[]]
        }
    }

    It 'returns the value property when present' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ value = @('p') } }
        Invoke-FGPatchRequest -URI 'https://graph.microsoft.com/v1.0/x' -Body @{ a = 1 } | Should -Be @('p')
    }

    It 'rethrows when the request fails' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { throw 'patch failed' }
        { Invoke-FGPatchRequest -URI 'https://graph.microsoft.com/v1.0/x' -Body @{ a = 1 } } | Should -Throw
    }
}

# ---------------------------------------------------------------------------
# Invoke-FGDeleteRequest
# ---------------------------------------------------------------------------
Describe 'Invoke-FGDeleteRequest' {
    BeforeAll { $Global:AccessToken = 'fake-token' }
    AfterAll { $Global:AccessToken = $null }

    It 'throws when no access token is set' {
        $Global:AccessToken = $null
        { Invoke-FGDeleteRequest -URI 'https://graph.microsoft.com/v1.0/users/1' } |
            Should -Throw '*No Access Token*'
        $Global:AccessToken = 'fake-token'
    }

    It 'sends a DELETE with the Bearer header' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { $null }

        Invoke-FGDeleteRequest -URI 'https://graph.microsoft.com/v1.0/users/1'

        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1 -ParameterFilter {
            $Method -eq 'DELETE' -and
            $Uri -eq 'https://graph.microsoft.com/v1.0/users/1' -and
            $Headers.Authorization -eq 'Bearer fake-token'
        }
    }

    It 'rethrows when the request fails' {
        Mock -ModuleName IdentityAtlas Update-FGAccessTokenIfExpired { }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { throw 'delete failed' }
        { Invoke-FGDeleteRequest -URI 'https://graph.microsoft.com/v1.0/users/1' } | Should -Throw
    }
}

# ---------------------------------------------------------------------------
# Get-FGAccessToken — client-credentials flow
# ---------------------------------------------------------------------------
Describe 'Get-FGAccessToken' {
    AfterEach {
        $Global:AccessToken = $null
        $Global:ClientId = $null
        $Global:ClientSecret = $null
        $Global:TenantId = $null
    }

    It 'posts client_credentials to the tenant token endpoint and sets globals' {
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ access_token = 'NEW-TOKEN' } }

        Get-FGAccessToken -ClientId 'cid' -ClientSecret 'secret' -TenantId 'tid'

        $Global:AccessToken | Should -Be 'NEW-TOKEN'
        $Global:ClientId | Should -Be 'cid'
        $Global:TenantId | Should -Be 'tid'
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1 -ParameterFilter {
            $Method -eq 'Post' -and
            $Uri -eq 'https://login.microsoftonline.com/tid/oauth2/token' -and
            $Body.grant_type -eq 'client_credentials' -and
            $Body.client_id -eq 'cid'
        }
    }

    It 'throws when the token endpoint returns no access_token' {
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ } }
        { Get-FGAccessToken -ClientId 'cid' -ClientSecret 'secret' -TenantId 'tid' } |
            Should -Throw '*Error retrieving Graph Access Token*'
    }

    It 'validates that ClientId is required in the explicit set' {
        { Get-FGAccessToken -ClientId '' -ClientSecret 'secret' -TenantId 'tid' } |
            Should -Throw '*ClientId is required*'
    }

    It 'validates that ClientSecret is required in the explicit set' {
        { Get-FGAccessToken -ClientId 'cid' -ClientSecret '' -TenantId 'tid' } |
            Should -Throw '*ClientSecret is required*'
    }

    It 'validates that TenantId is required in the explicit set' {
        { Get-FGAccessToken -ClientId 'cid' -ClientSecret 'secret' -TenantId '' } |
            Should -Throw '*TenantId is required*'
    }

    It 'throws when the config file does not exist' {
        { Get-FGAccessToken -ConfigFile (Join-Path $TestDrive 'nope.json') } |
            Should -Throw '*Configuration file not found*'
    }

    It 'reads credentials from a config file and authenticates' {
        $cfg = Join-Path $TestDrive 'cfg.json'
        @{ Graph = @{ TenantId = 'ctid'; ClientId = 'ccid'; ClientSecret = 'csecret' } } |
            ConvertTo-Json | Set-Content -Path $cfg

        Mock -ModuleName IdentityAtlas Get-FGSecureConfigValue { 'csecret' }
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ access_token = 'CFG-TOKEN' } }

        Get-FGAccessToken -ConfigFile $cfg

        $Global:AccessToken | Should -Be 'CFG-TOKEN'
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://login.microsoftonline.com/ctid/oauth2/token'
        }
    }

    It 'throws when the config file has no ClientSecret' {
        $cfg = Join-Path $TestDrive 'cfg2.json'
        @{ Graph = @{ TenantId = 'ctid'; ClientId = 'ccid' } } | ConvertTo-Json | Set-Content -Path $cfg
        Mock -ModuleName IdentityAtlas Get-FGSecureConfigValue { '' }
        { Get-FGAccessToken -ConfigFile $cfg } | Should -Throw '*ClientSecret not available*'
    }

    It 'throws when the config file has no TenantId' {
        $cfg = Join-Path $TestDrive 'cfg3.json'
        @{ Graph = @{ ClientId = 'ccid' } } | ConvertTo-Json | Set-Content -Path $cfg
        { Get-FGAccessToken -ConfigFile $cfg } | Should -Throw '*Graph.TenantId not found*'
    }

    It 'throws when the config file has no ClientId' {
        $cfg = Join-Path $TestDrive 'cfg4.json'
        @{ Graph = @{ TenantId = 'ctid' } } | ConvertTo-Json | Set-Content -Path $cfg
        { Get-FGAccessToken -ConfigFile $cfg } | Should -Throw '*Graph.ClientId not found*'
    }
}

# ---------------------------------------------------------------------------
# Get-FGAccessTokenWithRefreshToken
# ---------------------------------------------------------------------------
Describe 'Get-FGAccessTokenWithRefreshToken' {
    AfterEach {
        $Global:AccessToken = $null
        $Global:RefreshToken = $null
        $Global:ClientId = $null
        $Global:TenantId = $null
    }

    It 'posts refresh_token grant and sets access + refresh globals' {
        Mock -ModuleName IdentityAtlas Invoke-RestMethod {
            [pscustomobject]@{ access_token = 'RT-ACCESS'; refresh_token = 'RT-NEW' }
        }

        Get-FGAccessTokenWithRefreshToken -ClientId 'cid' -TenantId 'tid' -RefreshToken 'oldrt'

        $Global:AccessToken | Should -Be 'RT-ACCESS'
        $Global:RefreshToken | Should -Be 'RT-NEW'
        Should -Invoke -ModuleName IdentityAtlas Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://login.microsoftonline.com/tid/oauth2/token' -and
            $Body.grant_type -eq 'refresh_token' -and
            $Body.refresh_token -eq 'oldrt'
        }
    }

    It 'throws when no access_token comes back' {
        Mock -ModuleName IdentityAtlas Invoke-RestMethod { [pscustomobject]@{ } }
        { Get-FGAccessTokenWithRefreshToken -ClientId 'cid' -TenantId 'tid' -RefreshToken 'rt' } |
            Should -Throw '*Error retrieving Graph Access Token*'
    }
}

# ---------------------------------------------------------------------------
# Get-FGAccessTokenDetail — JWT decode
# ---------------------------------------------------------------------------
Describe 'Get-FGAccessTokenDetail' {
    BeforeAll {
        # Build a real (unsigned) JWT-shaped token so the base64 decode path runs.
        function New-FakeJwt {
            param($HeaderObj, $PayloadObj)
            $enc = {
                param($o)
                $json = $o | ConvertTo-Json -Compress
                $b = [System.Text.Encoding]::ASCII.GetBytes($json)
                [System.Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
            }
            "$(& $enc $HeaderObj).$(& $enc $PayloadObj).signature"
        }
        $script:jwt = New-FakeJwt -HeaderObj @{ typ = 'JWT'; alg = 'RS256' } `
            -PayloadObj @{ tid = 'TENANT-1'; appid = 'APP-1'; exp = 9999999999; upn = 'a@b.com'; idtyp = 'user' }
    }
    AfterAll { $Global:AccessToken = $null }

    It 'throws when no access token is set' {
        $Global:AccessToken = $null
        { Get-FGAccessTokenDetail } | Should -Throw '*No Access Token*'
    }

    It 'rejects a token that does not look like a JWT' {
        $Global:AccessToken = 'not-a-jwt'
        { Get-FGAccessTokenDetail } | Should -Throw '*Invalid token*'
        $Global:AccessToken = $null
    }

    It 'decodes the header and payload into a single hashtable' {
        $Global:AccessToken = $script:jwt
        $detail = Get-FGAccessTokenDetail
        $detail.tid | Should -Be 'TENANT-1'
        $detail.appid | Should -Be 'APP-1'
        $detail.alg | Should -Be 'RS256'
        $Global:AccessToken = $null
    }
}

# ---------------------------------------------------------------------------
# Confirm-FGAccessTokenValidity
# ---------------------------------------------------------------------------
Describe 'Confirm-FGAccessTokenValidity' {
    AfterAll { $Global:AccessToken = $null }

    It 'throws when no access token is set' {
        $Global:AccessToken = $null
        { Confirm-FGAccessTokenValidity } | Should -Throw '*No Access Token*'
    }

    It 'returns true for a token whose exp is in the future' {
        $Global:AccessToken = 'fake-token'
        Mock -ModuleName IdentityAtlas Get-FGAccessTokenDetail { @{ exp = 4102444800 } } # year 2100
        Confirm-FGAccessTokenValidity | Should -BeTrue
        $Global:AccessToken = $null
    }

    It 'returns false for an expired token' {
        $Global:AccessToken = 'fake-token'
        Mock -ModuleName IdentityAtlas Get-FGAccessTokenDetail { @{ exp = 1000000000 } } # year 2001
        Confirm-FGAccessTokenValidity | Should -BeFalse
        $Global:AccessToken = $null
    }
}

# ---------------------------------------------------------------------------
# Update-FGAccessTokenIfExpired
# ---------------------------------------------------------------------------
Describe 'Update-FGAccessTokenIfExpired' {
    AfterEach {
        $Global:AccessToken = $null
        $Global:ClientSecret = $null
        $Global:RefreshToken = $null
        $Global:ClientId = $null
        $Global:TenantId = $null
    }

    It 'does nothing when the token is still valid' {
        Mock -ModuleName IdentityAtlas Confirm-FGAccessTokenValidity { $true }
        Mock -ModuleName IdentityAtlas Get-FGAccessToken { }
        Mock -ModuleName IdentityAtlas Get-FGAccessTokenWithRefreshToken { }

        Update-FGAccessTokenIfExpired -DebugFlag 'G'

        Should -Invoke -ModuleName IdentityAtlas Get-FGAccessToken -Times 0
        Should -Invoke -ModuleName IdentityAtlas Get-FGAccessTokenWithRefreshToken -Times 0
    }

    It 'refreshes via client secret when expired and a secret is present' {
        $Global:ClientSecret = 'secret'
        $Global:ClientId = 'cid'
        $Global:TenantId = 'tid'
        Mock -ModuleName IdentityAtlas Confirm-FGAccessTokenValidity { $false }
        Mock -ModuleName IdentityAtlas Get-FGAccessToken { }

        Update-FGAccessTokenIfExpired

        Should -Invoke -ModuleName IdentityAtlas Get-FGAccessToken -Times 1
    }

    It 'refreshes via refresh token when expired and no secret is present' {
        $Global:RefreshToken = 'rt'
        $Global:ClientId = 'cid'
        $Global:TenantId = 'tid'
        Mock -ModuleName IdentityAtlas Confirm-FGAccessTokenValidity { $false }
        Mock -ModuleName IdentityAtlas Get-FGAccessTokenWithRefreshToken { }

        Update-FGAccessTokenIfExpired

        Should -Invoke -ModuleName IdentityAtlas Get-FGAccessTokenWithRefreshToken -Times 1
    }

    It 'throws when expired with neither secret nor refresh token' {
        Mock -ModuleName IdentityAtlas Confirm-FGAccessTokenValidity { $false }
        { Update-FGAccessTokenIfExpired } | Should -Throw '*no ClientSecret or RefreshToken*'
    }
}

# ---------------------------------------------------------------------------
# Use-FGExistingAccessTokenString / Use-FGExistingMSALToken
# ---------------------------------------------------------------------------
Describe 'Use-FGExistingAccessTokenString' {
    AfterAll {
        $Global:AccessToken = $null
        $Global:TenantId = $null
        $Global:ClientId = $null
    }

    It 'sets the token plus tenant/client globals from the decoded detail' {
        Mock -ModuleName IdentityAtlas Get-FGAccessTokenDetail { @{ tid = 'TID-X'; appid = 'APP-X' } }
        Use-FGExistingAccessTokenString -AccessTokenString 'some-token'
        $Global:AccessToken | Should -Be 'some-token'
        $Global:TenantId | Should -Be 'TID-X'
        $Global:ClientId | Should -Be 'APP-X'
    }
}

Describe 'Use-FGExistingMSALToken' {
    AfterAll {
        $Global:AccessToken = $null
        $Global:AccessTokenObject = $null
        $Global:TenantId = $null
        $Global:ClientId = $null
    }

    It 'unwraps an MSAL token object and sets globals' {
        Mock -ModuleName IdentityAtlas Get-FGAccessTokenDetail { @{ tid = 'TID-M'; appid = 'APP-M' } }
        $msal = [pscustomobject]@{ AccessToken = 'msal-access' }
        Use-FGExistingMSALToken -Token $msal
        $Global:AccessToken | Should -Be 'msal-access'
        $Global:AccessTokenObject.AccessToken | Should -Be 'msal-access'
        $Global:TenantId | Should -Be 'TID-M'
        $Global:ClientId | Should -Be 'APP-M'
    }
}

# ---------------------------------------------------------------------------
# Read-FGToken / Save-FGToken
# ---------------------------------------------------------------------------
Describe 'Read-FGToken' {
    AfterEach {
        $Global:TenantId = $null
        $Global:ClientId = $null
        $Global:RefreshToken = $null
    }

    It 'throws when the token file does not exist' {
        { Read-FGToken -TokenFile (Join-Path $TestDrive 'missing.token') } |
            Should -Throw '*TokenFile not found*'
    }

    It 'throws when the file has no refresh token' {
        $f = Join-Path $TestDrive 'norefresh.token'
        @{ TenantId = 'tid'; ClientId = 'cid' } | ConvertTo-Json | Set-Content -Path $f
        { Read-FGToken -TokenFile $f } | Should -Throw '*does not contian a refresh token*'
    }

    It 'loads globals and refreshes the access token' {
        $f = Join-Path $TestDrive 'good.token'
        @{ TenantId = 'tid'; ClientId = 'cid'; RefreshToken = 'rt' } | ConvertTo-Json | Set-Content -Path $f
        Mock -ModuleName IdentityAtlas Get-FGAccessTokenWithRefreshToken { }

        Read-FGToken -TokenFile $f

        $Global:RefreshToken | Should -Be 'rt'
        Should -Invoke -ModuleName IdentityAtlas Get-FGAccessTokenWithRefreshToken -Times 1
    }
}

Describe 'Save-FGToken' {
    AfterAll {
        $Global:TenantId = $null
        $Global:ClientId = $null
        $Global:RefreshToken = $null
    }

    It 'throws when the target directory does not exist' {
        { Save-FGToken -TokenFilePath (Join-Path $TestDrive 'no-such-dir') } |
            Should -Throw '*TokenFilePath not found*'
    }

    It 'writes a <tenant>+<idtyp>+<upn>.token file with the refresh token' {
        $dir = Join-Path $TestDrive 'tokens'
        New-Item -ItemType Directory -Path $dir | Out-Null
        $Global:TenantId = 'tid'
        $Global:ClientId = 'cid'
        $Global:RefreshToken = 'rt'
        Mock -ModuleName IdentityAtlas Get-FGAccessTokenDetail { @{ idtyp = 'user'; upn = 'a@b.com' } }

        Save-FGToken -TokenFilePath $dir

        $written = Get-ChildItem -Path $dir -Filter '*.token'
        $written.Name | Should -Be 'tid+user+a@b.com.token'
        $content = Get-Content $written.FullName -Raw | ConvertFrom-Json
        $content.RefreshToken | Should -Be 'rt'
    }
}

# ---------------------------------------------------------------------------
# Test-FGConnection
# ---------------------------------------------------------------------------
Describe 'Test-FGConnection' {
    AfterAll { $Global:AccessToken = $null }

    It 'returns false when no access token is set' {
        $Global:AccessToken = $null
        Test-FGConnection | Should -BeFalse
    }

    It 'delegates to Confirm-FGAccessTokenValidity when a token is set' {
        $Global:AccessToken = 'fake-token'
        Mock -ModuleName IdentityAtlas Confirm-FGAccessTokenValidity { $true }
        Test-FGConnection | Should -BeTrue
        Should -Invoke -ModuleName IdentityAtlas Confirm-FGAccessTokenValidity -Times 1
        $Global:AccessToken = $null
    }
}
