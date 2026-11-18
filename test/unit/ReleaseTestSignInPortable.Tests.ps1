#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Sign-in and portable-ZIP helpers of the release test
    (tools/release/ReleaseTest.SignIn.ps1, ReleaseTest.Portable.ps1).

.DESCRIPTION
    The sign-in checks are only worth something if a broken gate fails them.
    Two broken gates are simulated below — one that lets every token in, one
    that refuses everybody — and each must produce problems, while a gate that
    behaves as the API's authMiddleware does must produce none.

.USAGE
    Invoke-Pester -Path test/unit/ReleaseTestSignInPortable.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Docker.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseTest.SignIn.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Portable.ps1')

    $script:Tokens = @{ 'role' = 'R'; 'no-role' = 'N'; 'other-audience' = 'O'; 'none' = ''; 'garbage' = 'not-a-jwt' }

    # How authMiddleware answers: 401 for no/invalid/foreign tokens, the role
    # caller in except on admin paths, the no-role caller only on /auth-me.
    function Get-CorrectAnswer([string] $Uri, [hashtable] $Headers) {
        $token = if ($Headers.ContainsKey('Authorization')) { $Headers.Authorization -replace '^Bearer ', '' } else { '' }
        $status, $body = switch ($token) {
            'A' { 200, '{}' }
            'R' { if ($Uri -like '*/admin/*') { 403, '{"error":"Insufficient permissions"}' } else { 200, '{}' } }
            'N' { if ($Uri -like '*/auth-me') { 200, '{}' } else { 403, '{"error":"no role","code":"NO_ROLE"}' } }
            default { 401, '{"error":"Missing or invalid authorization header"}' }
        }
        [pscustomobject]@{ StatusCode = $status; Content = $body }
    }
}

Describe 'Get-SignInExpectation' {
    BeforeAll { $script:E = Get-SignInExpectation }

    It 'refuses the no-role caller on every data path the role caller is let into' {
        $allowed = @($script:E | Where-Object { $_.Token -eq 'role' -and $_.Status -eq 200 } | ForEach-Object Path)
        $allowed.Count | Should -BeGreaterThan 0
        foreach ($path in $allowed) {
            $script:E | Where-Object { $_.Token -eq 'no-role' -and $_.Path -eq $path -and $_.Status -eq 403 } | Should -Not -BeNullOrEmpty
        }
    }
    It 'requires the NO_ROLE code on every no-role refusal (the UI keys its screen on it)' {
        $script:E | Where-Object { $_.Token -eq 'no-role' -and $_.Status -eq 403 } | ForEach-Object { $_.Code | Should -Be 'NO_ROLE' }
    }
    It 'keeps a read-only role out of an admin path' {
        $script:E | Where-Object { $_.Token -eq 'role' -and $_.Path -like '/admin/*' } | ForEach-Object Status | Should -Be 403
    }
    It 'refuses a missing, a malformed and a foreign-audience token with 401' {
        foreach ($t in 'none', 'garbage', 'other-audience') {
            ($script:E | Where-Object Token -eq $t).Status | Should -Be 401
        }
    }
}

Describe 'Invoke-SignInCheck' {
    It 'finds nothing wrong with a gate that behaves as authMiddleware does' {
        Mock Invoke-WebRequest { Get-CorrectAnswer $Uri $Headers }
        Invoke-SignInCheck -BaseUrl 'http://x/api' -Tokens $script:Tokens | Should -BeNullOrEmpty
    }
    It 'fails every refusal when the gate lets everyone in (the F-01 bug)' {
        Mock Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200; Content = '{}' } }
        $problems = Invoke-SignInCheck -BaseUrl 'http://x/api' -Tokens $script:Tokens
        $refusals = @(Get-SignInExpectation | Where-Object { $_.Status -ne 200 })
        $problems.Count | Should -Be $refusals.Count
        $problems | Where-Object { $_ -like "*as 'no-role' answered 200, expected 403*" } | Should -Not -BeNullOrEmpty
    }
    It 'fails every admission when the gate refuses everybody' {
        Mock Invoke-WebRequest { [pscustomobject]@{ StatusCode = 401; Content = '{}' } }
        $problems = Invoke-SignInCheck -BaseUrl 'http://x/api' -Tokens $script:Tokens
        $problems | Where-Object { $_ -like "*as 'role' answered 401, expected 200*" } | Should -Not -BeNullOrEmpty
        $problems | Where-Object { $_ -like '*may ask who it is*' } | Should -Not -BeNullOrEmpty
    }
    It 'catches a no-role refusal that lost its code' {
        Mock Invoke-WebRequest { $a = Get-CorrectAnswer $Uri $Headers; if ($a.Content -like '*NO_ROLE*') { $a.Content = '{"error":"Forbidden"}' }; $a }
        Invoke-SignInCheck -BaseUrl 'http://x/api' -Tokens $script:Tokens | Should -BeLike "*with code '' instead of 'NO_ROLE'*"
    }
    It 'lets the Admin caller into admin when its token is given' {
        Mock Invoke-WebRequest { Get-CorrectAnswer $Uri $Headers }
        Invoke-SignInCheck -BaseUrl 'http://x/api' -Tokens ($script:Tokens + @{ 'admin' = 'A' }) | Should -BeNullOrEmpty
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter { $Headers.Authorization -eq 'Bearer A' -and $Uri -eq 'http://x/api/admin/crawler-configs' }
    }
    It 'fails when the Admin caller is kept out of admin like a read-only role' {
        Mock Invoke-WebRequest { if ($Headers['Authorization'] -eq 'Bearer A') { $Headers = @{ Authorization = 'Bearer R' } }; Get-CorrectAnswer $Uri $Headers }
        $p = @(Invoke-SignInCheck -BaseUrl 'http://x/api' -Tokens ($script:Tokens + @{ 'admin' = 'A' }))
        $p.Count | Should -Be 1
        $p[0] | Should -BeLike "an Admin caller gets into admin*as 'admin' answered 403, expected 200"
    }
    It 'skips the Admin check, and only that one, without an admin token (the Docker scenario)' {
        Mock Invoke-WebRequest { Get-CorrectAnswer $Uri $Headers }
        Invoke-SignInCheck -BaseUrl 'http://x/api' -Tokens $script:Tokens | Out-Null
        Should -Invoke Invoke-WebRequest -Times (@(Get-SignInExpectation).Count - 1) -Exactly
        Should -Invoke Invoke-WebRequest -Times 0 -ParameterFilter { $Uri -like '*/admin/*' -and -not $Headers.ContainsKey('Authorization') }
    }
    It 'sends no Authorization header for the no-token case' {
        Mock Invoke-WebRequest { Get-CorrectAnswer $Uri $Headers }
        Invoke-SignInCheck -BaseUrl 'http://x/api' -Tokens $script:Tokens | Out-Null
        Should -Invoke Invoke-WebRequest -ParameterFilter { -not $Headers.ContainsKey('Authorization') } -Times 1 -Exactly
    }
}

Describe 'Get-SignInProblem' {
    BeforeAll { $script:NoRole = @{ Name = 'n'; Token = 'no-role'; Path = '/users'; Status = 403; Code = 'NO_ROLE' } }
    It 'accepts the right status and code' { Get-SignInProblem -Expectation $script:NoRole -Status 403 -Content '{"code":"NO_ROLE"}' | Should -BeNullOrEmpty }
    It 'reports the wrong status first' { Get-SignInProblem -Expectation $script:NoRole -Status 200 -Content '{}' | Should -BeLike '*answered 200, expected 403*' }
    It 'reports a body that is not JSON as a missing code' { Get-SignInProblem -Expectation $script:NoRole -Status 403 -Content '<html>' | Should -BeLike "*code ''*" }
    It 'ignores the body when no code is expected' {
        Get-SignInProblem -Expectation @{ Name = 'r'; Token = 'role'; Path = '/users'; Status = 200 } -Status 200 -Content 'anything' | Should -BeNullOrEmpty
    }
}

Describe 'Tokens' {
    It 'exchanges the GitHub token with client credentials for the requested scope' {
        Mock Invoke-RestMethod { [pscustomobject]@{ access_token = 'AT' } }
        Get-FederatedAccessToken -TenantId 't1' -ClientId 'c1' -Scope 'api://sso/.default' -Assertion 'gh' | Should -Be 'AT'
        Should -Invoke Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
            $Uri -eq 'https://login.microsoftonline.com/t1/oauth2/v2.0/token' -and $Body.grant_type -eq 'client_credentials' -and
            $Body.client_id -eq 'c1' -and $Body.scope -eq 'api://sso/.default' -and $Body.client_assertion -eq 'gh' -and
            $Body.client_assertion_type -eq 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' -and -not $Body.ContainsKey('client_secret')
        }
    }
    It 'throws when Entra returns no token' {
        Mock Invoke-RestMethod { [pscustomobject]@{ error = 'invalid_client' } }
        { Get-FederatedAccessToken -TenantId t -ClientId c -Scope s -Assertion a } | Should -Throw '*no access token*'
    }
    It 'asks GitHub for a token with the Entra exchange audience' {
        $env:ACTIONS_ID_TOKEN_REQUEST_URL = 'https://gh/token?x=1'; $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'req'
        try {
            Mock Invoke-RestMethod { [pscustomobject]@{ value = 'OIDC' } }
            Get-GitHubOidcToken | Should -Be 'OIDC'
            Should -Invoke Invoke-RestMethod -ParameterFilter { $Uri -eq 'https://gh/token?x=1&audience=api%3A%2F%2FAzureADTokenExchange' -and $Headers.Authorization -eq 'Bearer req' }
        } finally { Remove-Item Env:ACTIONS_ID_TOKEN_REQUEST_URL, Env:ACTIONS_ID_TOKEN_REQUEST_TOKEN }
    }
    It 'says what is missing without id-token: write' {
        Remove-Item Env:ACTIONS_ID_TOKEN_REQUEST_URL -ErrorAction SilentlyContinue
        { Get-GitHubOidcToken } | Should -Throw '*id-token: write*'
    }
    It 'takes each token from the right app and for the right API' {
        Mock Get-GitHubOidcToken { 'gh' }
        Mock Get-FederatedAccessToken { "$ClientId|$Scope" }
        $t = Get-SignInToken -TenantId t -SsoClientId sso -RoleCallerId withrole -NoRoleCallerId norole
        $t['role'] | Should -Be 'withrole|api://sso/.default'
        $t['no-role'] | Should -Be 'norole|api://sso/.default'
        $t['other-audience'] | Should -Be 'withrole|https://management.azure.com/.default'
        $t['none'] | Should -Be ''
        $t.ContainsKey('admin') | Should -BeFalse
    }
    It 'adds the Admin caller''s token for the SSO app when one is given' {
        Mock Get-GitHubOidcToken { 'gh' }
        Mock Get-FederatedAccessToken { "$ClientId|$Scope" }
        $t = Get-SignInToken -TenantId t -SsoClientId sso -RoleCallerId withrole -NoRoleCallerId norole -AdminCallerId admin
        $t['admin'] | Should -Be 'admin|api://sso/.default'
        $t['role'] | Should -Be 'withrole|api://sso/.default'
    }
}

Describe 'Assert-AuthConfig' {
    It 'passes when sign-in is on and configured for the SSO app' {
        Mock Invoke-Api { [pscustomobject]@{ enabled = $true; configured = $true; clientId = 'sso' } }
        { Assert-AuthConfig -BaseUrl 'http://x/api' -SsoClientId 'sso' } | Should -Not -Throw
    }
    It 'fails on the setup-required state (enabled, not configured)' {
        Mock Invoke-Api { [pscustomobject]@{ enabled = $true; configured = $false; clientId = '' } }
        { Assert-AuthConfig -BaseUrl 'http://x/api' -SsoClientId 'sso' } | Should -Throw '*not on and configured*'
    }
    It 'fails when configured for another app' {
        Mock Invoke-Api { [pscustomobject]@{ enabled = $true; configured = $true; clientId = 'other' } }
        { Assert-AuthConfig -BaseUrl 'http://x/api' -SsoClientId 'sso' } | Should -Throw "*'other'*"
    }
}

Describe 'Get-QuickstartScript -ExtraEnv' {
    It 'writes the sign-in lines into .env before the start' {
        $lines = (Get-QuickstartScript -Ref main -ImageTag edge -ExtraEnv ([ordered]@{ AUTH_ENABLED = 'true'; AUTH_CLIENT_ID = '0000-1111' })) -split "`n"
        $auth = [array]::IndexOf($lines, 'echo "AUTH_CLIENT_ID=0000-1111" >> .env')
        $up = [array]::FindIndex($lines, [Predicate[string]] { param($l) $l -like 'IMAGE_TAG=*' })
        $auth | Should -BeGreaterThan 0
        $auth | Should -BeLessThan $up
    }
    It 'refuses a value that the shell would run' {
        { Get-QuickstartScript -Ref main -ImageTag edge -ExtraEnv @{ AUTH_CLIENT_ID = '$(id)' } } | Should -Throw '*plain identifiers*'
    }
    It 'documents the same three AUTH_ lines for Docker' {
        $doc = Get-Content (Join-Path $script:Root 'docs/admin/authentication.md') -Raw
        foreach ($k in 'AUTH_ENABLED=true', 'AUTH_TENANT_ID=', 'AUTH_CLIENT_ID=') { $doc | Should -BeLike "*$k*" }
    }
}

Describe 'Portable helpers' {
    It 'starts the -postgres ZIP on PostgreSQL explicitly, so a silent PGlite fallback fails' {
        Get-PortableDatabase postgres | Should -Be 'Postgres'
        Get-PortableDatabase default | Should -Be 'Auto'
    }
    It 'names the ZIPs the release ships' {
        Get-PortableZipName default | Should -Be 'IdentityAtlas-portable.zip'
        Get-PortableZipName postgres | Should -Be 'IdentityAtlas-portable-postgres.zip'
    }
    It 'finds the launcher in a nested folder of the ZIP' {
        $src = Join-Path $TestDrive 'src/IdentityAtlas'
        New-Item -ItemType Directory -Force $src | Out-Null
        Set-Content (Join-Path $src 'Start-IdentityAtlas.ps1') 'x'
        Compress-Archive -Path (Join-Path $TestDrive 'src/*') -DestinationPath (Join-Path $TestDrive 'a.zip')
        $dir = Expand-PortableZip -Zip (Join-Path $TestDrive 'a.zip') -Destination (Join-Path $TestDrive 'out')
        Split-Path $dir -Leaf | Should -Be 'IdentityAtlas'
    }
    It 'refuses a ZIP without a launcher' {
        Set-Content (Join-Path $TestDrive 'readme.txt') 'x'
        Compress-Archive -Path (Join-Path $TestDrive 'readme.txt') -DestinationPath (Join-Path $TestDrive 'b.zip')
        { Expand-PortableZip -Zip (Join-Path $TestDrive 'b.zip') -Destination (Join-Path $TestDrive 'out-b') } | Should -Throw '*no Start-IdentityAtlas.ps1*'
    }
    It 'reads the totals from the list endpoints' {
        Mock Invoke-Api { switch -Wildcard ($Path) { '/users*' { [pscustomobject]@{ total = 120 } } '/resources*' { [pscustomobject]@{ total = 80 } } default { [pscustomobject]@{ totalUsers = 118 } } } }
        $t = Get-ApiTotal -BaseUrl 'http://x/api'
        $t.Users | Should -Be 120; $t.Resources | Should -Be 80; $t.Matrix | Should -Be 118
    }
    It 'fails an empty matrix page' {
        Mock Invoke-Api { [pscustomobject]@{ data = @(); totalUsers = 0 } }
        { Assert-MatrixPage -BaseUrl 'http://x/api' } | Should -Throw '*no rows*'
    }
    It 'fails a matrix page when the UI does not answer' {
        Mock Invoke-Api { [pscustomobject]@{ data = @(@{ id = 1 }) } }
        Mock Get-HttpStatus { 0 }
        { Assert-MatrixPage -BaseUrl 'http://x/api' } | Should -Throw '*UI does not answer*'
    }
}
