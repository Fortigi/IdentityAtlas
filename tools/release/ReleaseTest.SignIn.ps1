<#
.SYNOPSIS
    Sign-in checks of the release test (F-01: a caller without a role gets nothing).
    Dot-source after ReleaseTest.Functions.ps1.

.DESCRIPTION
    No browser can sign in on a CI runner, so the test uses the closest honest
    substitute: real Entra ID access tokens, obtained without a secret through
    GitHub's OIDC token and a federated credential (client credentials).

      role caller     the release-test app, assigned the Servicedesk app role
                      (data.read) on the SSO app registration
      no-role caller  a second app with no role on it

    Both tokens have aud = api://<SSO client id> and are signed by the tenant,
    so they go through exactly the validation a user's token goes through:
    signature, issuer, audience, tenant, then the roles claim. What this does
    NOT cover: a delegated (user) token, the browser's MSAL redirect and the
    redirect URI, roles assigned through a group, Conditional Access and MFA.
    docs/contributing/release-process.md lists the same.
#>

Set-StrictMode -Version Latest

function Get-GitHubOidcToken {
    <# A GitHub Actions OIDC token for Entra's federated-credential exchange. Needs id-token: write. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([string] $Audience = 'api://AzureADTokenExchange')
    if (-not $env:ACTIONS_ID_TOKEN_REQUEST_URL) { throw 'No GitHub OIDC token available: the job needs "permissions: id-token: write".' }
    $uri = "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=$([uri]::EscapeDataString($Audience))"
    (Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN)" }).value
}

function Get-FederatedAccessToken {
    <# Client-credentials access token for $Scope, with the GitHub OIDC token as the client assertion. #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string] $TenantId,
        [Parameter(Mandatory)][string] $ClientId,
        [Parameter(Mandatory)][string] $Scope,
        [Parameter(Mandatory)][string] $Assertion
    )
    $body = @{
        grant_type            = 'client_credentials'
        client_id             = $ClientId
        scope                 = $Scope
        client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        client_assertion      = $Assertion
    }
    $r = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" -Body $body -ContentType 'application/x-www-form-urlencoded'
    if (-not (Get-Prop $r 'access_token')) { throw "Entra returned no access token for $ClientId." }
    if ($env:GITHUB_ACTIONS) { Write-Host "::add-mask::$($r.access_token)" }
    $r.access_token
}

function Get-SignInToken {
    <#
    .SYNOPSIS
        The four tokens the checks use, keyed by name.
    .DESCRIPTION
        'other-audience' is an Azure Resource Manager token from the role caller: valid,
        signed by the right tenant, but for a different API. The app must
        refuse it, or any token from the tenant would do.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string] $TenantId,
        [Parameter(Mandatory)][string] $SsoClientId,
        [Parameter(Mandatory)][string] $RoleCallerId,
        [Parameter(Mandatory)][string] $NoRoleCallerId
    )
    $api = "api://$SsoClientId/.default"
    $get = { param($client, $scope) Get-FederatedAccessToken -TenantId $TenantId -ClientId $client -Scope $scope -Assertion (Get-GitHubOidcToken) }
    @{
        'role'           = & $get $RoleCallerId $api
        'no-role'        = & $get $NoRoleCallerId $api
        'other-audience' = & $get $RoleCallerId 'https://management.azure.com/.default'
        'none'           = ''
        'garbage'        = 'not-a-jwt'
    }
}

function Get-SignInExpectation {
    <#
    .SYNOPSIS
        What each caller must get, as data: path, token name, status, and the
        error code a refusal must carry.
    .DESCRIPTION
        Paired on purpose: the no-role caller is refused on the very path the
        role caller is let into, and the role caller is refused on an admin
        path its role does not grant. A gate that lets everyone in, or nobody,
        fails one half of each pair.
    #>
    [CmdletBinding()]
    param()
    @(
        @{ Name = 'no token is refused';                    Token = 'none';           Path = '/users?limit=1';         Status = 401 }
        @{ Name = 'a malformed token is refused';           Token = 'garbage';        Path = '/users?limit=1';         Status = 401 }
        @{ Name = 'a token for another API is refused';     Token = 'other-audience'; Path = '/users?limit=1';         Status = 401 }
        @{ Name = 'a caller with a role reads data';        Token = 'role';           Path = '/users?limit=1';         Status = 200 }
        @{ Name = 'a caller with a role reads the matrix';  Token = 'role';           Path = '/permissions?userLimit=1'; Status = 200 }
        @{ Name = 'a read-only role is kept out of admin';  Token = 'role';           Path = '/admin/crawler-configs'; Status = 403 }
        @{ Name = 'a caller without a role reads nothing';  Token = 'no-role';        Path = '/users?limit=1';         Status = 403; Code = 'NO_ROLE' }
        @{ Name = 'a caller without a role sees no matrix'; Token = 'no-role';        Path = '/permissions?userLimit=1'; Status = 403; Code = 'NO_ROLE' }
        @{ Name = 'a caller without a role may ask who it is'; Token = 'no-role';     Path = '/auth-me';               Status = 200 }
    )
}

function Get-SignInProblem {
    <# The problem with one response against one expectation, or $null. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable] $Expectation, [int] $Status, [string] $Content = '')
    $e = $Expectation
    if ($Status -ne $e.Status) { return "$($e.Name): $($e.Path) as '$($e.Token)' answered $Status, expected $($e.Status)" }
    if (-not $e.ContainsKey('Code')) { return $null }
    $code = try { Get-Prop ($Content | ConvertFrom-Json) 'code' } catch { $null }
    if ($code -ne $e.Code) { return "$($e.Name): refused, but with code '$code' instead of '$($e.Code)'" }
    return $null
}

function Invoke-SignInCheck {
    <# Runs every expectation; returns the problems (empty = all passed). #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][hashtable] $Tokens)
    $problems = foreach ($e in Get-SignInExpectation) {
        $headers = @{}
        if ($Tokens[$e.Token]) { $headers.Authorization = "Bearer $($Tokens[$e.Token])" }
        $r = Invoke-WebRequest -Uri "$BaseUrl$($e.Path)" -Headers $headers -TimeoutSec 60 -SkipHttpErrorCheck
        Get-SignInProblem -Expectation $e -Status ([int]$r.StatusCode) -Content ([string]$r.Content)
    }
    @($problems | Where-Object { $_ })
}

function Assert-AuthConfig {
    <# The app says sign-in is on and configured for the SSO app — what the SPA reads before it signs in. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][string] $SsoClientId)
    $c = Invoke-Api -BaseUrl $BaseUrl -Path '/auth-config'
    if (-not (Get-Prop $c 'enabled') -or -not (Get-Prop $c 'configured')) { throw "Sign-in is not on and configured: $($c | ConvertTo-Json -Compress)" }
    if ((Get-Prop $c 'clientId') -ne $SsoClientId) { throw "The app is configured for client '$(Get-Prop $c 'clientId')', not '$SsoClientId'." }
}
