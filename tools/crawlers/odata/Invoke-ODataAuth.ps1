<#
.SYNOPSIS
    OData REST API authentication — multi-method session management.

.DESCRIPTION
    Provides Connect-ODataAPI (establishes a session) and
    Update-ODataSessionIfExpired (refreshes before each request).

    Session state lives in $script:ODataSession (module-scoped).
    Auth methods:
      FormCookie   — POST /api/authenticate, capture Set-Cookie
      OAuth2CC     — client_credentials grant → bearer token
      OAuth2ROPC   — password grant → bearer token
      ApiToken     — static bearer token (no refresh)
      CookieString — pre-built semicolon-delimited cookie string
      BasicAuth    — HTTP Basic (Base64 username:password)

.NOTES
    WindowsAuth is intentionally not implemented — it requires a
    domain-joined worker (Kerberos keytab on Linux) which is not
    practical for Docker deployments. Use FormCookie or OAuth2ROPC
    for on-premise environments instead.
#>

$script:ODataSession = $null

#region Functions

function Connect-ODataAPI {
    <#
    .SYNOPSIS
        Authenticate to an OData endpoint and store the session for subsequent calls.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory)] [string]$BaseUrl,
        [Parameter(Mandatory)] [ValidateSet('FormCookie','OAuth2CC','OAuth2ROPC','ApiToken','CookieString','BasicAuth')]
        [string]$AuthMethod,
        [string]$Username          = '',
        [string]$Password          = '',
        [string]$ClientId          = '',
        [string]$ClientSecret      = '',
        [string]$TokenEndpoint     = '',
        [string]$ApiToken          = '',
        [string]$CookieString      = '',
        [string]$ApiVersion        = 'v4',
        [int]$SessionTimeoutMinutes = 30
    )

    $base = $BaseUrl.TrimEnd('/')

    $script:ODataSession = @{
        AuthMethod            = $AuthMethod
        BaseUrl               = $base
        ApiVersion            = $ApiVersion
        WebSession            = $null
        AccessToken           = $null
        BasicAuthHeader       = $null  # pre-computed for BasicAuth
        CookieHeader          = $null  # raw Cookie header string for CookieString auth (cloud)
        TokenExpiresAt        = $null
        LastAuthAt            = $null
        SessionTimeoutMinutes = $SessionTimeoutMinutes
        # Stored for re-auth
        _Username             = $Username
        _Password             = $Password
        _ClientId             = $ClientId
        _ClientSecret         = $ClientSecret
        _TokenEndpoint        = $TokenEndpoint
        _ApiToken             = $ApiToken
    }

    switch ($AuthMethod) {
        'FormCookie'   { Invoke-ODataFormAuth }
        'OAuth2CC'     { Invoke-ODataOAuth2 -GrantType 'client_credentials' }
        'OAuth2ROPC'   { Invoke-ODataOAuth2 -GrantType 'password' }
        'ApiToken'     { $script:ODataSession.AccessToken = $ApiToken }
        'CookieString' { Invoke-ODataCookieStringAuth -CookieString $CookieString }
        'BasicAuth'    {
            if (-not $Username -or -not $Password) { throw "OData BasicAuth: username and password are required" }
            $encoded = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("${Username}:${Password}"))
            $script:ODataSession.BasicAuthHeader = "Basic $encoded"
        }
    }

    Write-Host "  OData: authenticated via $AuthMethod to $base" -ForegroundColor Green
}

function Get-ODataAuthRoot {
    # Derive the server root URL for /api/authenticate from the OData base URL.
    # Cloud:    https://tenant.example.com/odata/dataobjects  → https://tenant.example.com
    # On-prem:  http://server/odata/dataobjects               → http://server
    # Fallback: http://server/anything-else                   → http://server/anything-else (unchanged)
    $base     = $script:ODataSession.BaseUrl
    $odataIdx = $base.IndexOf('/odata/')
    if ($odataIdx -gt 0) { return $base.Substring(0, $odataIdx) }
    return $base
}

function Invoke-ODataFormAuth {
    $authRoot  = Get-ODataAuthRoot
    $authUri   = $authRoot + '/api/authenticate'
    $webSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $body = @{ Username = $script:ODataSession._Username; Password = $script:ODataSession._Password } | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri $authUri -Method Post `
            -ContentType 'application/json' -Body $body `
            -WebSession $webSession -ErrorAction Stop | Out-Null
    } catch {
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
        throw "OData FormCookie auth failed (HTTP $status) at $authUri`: $($_.Exception.Message)"
    }

    $script:ODataSession.WebSession  = $webSession
    $script:ODataSession.LastAuthAt  = [datetime]::UtcNow
}

function Invoke-ODataOAuth2 {
    param([ValidateSet('client_credentials','password')] [string]$GrantType)
    $endpoint = $script:ODataSession._TokenEndpoint
    if (-not $endpoint) { throw "OData OAuth2: tokenEndpoint is required" }

    $form = @{
        grant_type    = $GrantType
        client_id     = $script:ODataSession._ClientId
        client_secret = $script:ODataSession._ClientSecret
    }
    if ($GrantType -eq 'password') {
        $form['username'] = $script:ODataSession._Username
        $form['password'] = $script:ODataSession._Password
    }

    try {
        $resp = Invoke-RestMethod -Uri $endpoint -Method Post -Body $form -ErrorAction Stop
    } catch {
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
        throw "OData OAuth2 ($GrantType) failed (HTTP $status): $($_.Exception.Message)"
    }

    $script:ODataSession.AccessToken    = $resp.access_token
    $expiresIn = if ($resp.expires_in) { [int]$resp.expires_in } else { 3600 }
    $script:ODataSession.TokenExpiresAt = [datetime]::UtcNow.AddSeconds($expiresIn)
}

function Invoke-ODataCookieStringAuth {
    param([string]$CookieString)
    if (-not $CookieString.Trim()) { throw "OData CookieString: cookieString cannot be empty" }

    $raw = $CookieString.Trim()

    # If the value is just a token (no cookie name prefix like "oisauthtoken=…"),
    # auto-prepend "oisauthtoken=". A name=value pair is detected by checking that
    # the first '=' is followed by a non-'=' character (i.e. not base64 padding).
    if ($raw -notmatch '^[A-Za-z][A-Za-z0-9_.%-]*=[^=]') {
        $raw = 'oisauthtoken=' + $raw
    }

    # Cloud deployments require an explicit Cookie request header; WebSession cookie-domain
    # matching is unreliable for cloud/HTTPS URLs.
    $script:ODataSession.CookieHeader = $raw
    # No LastAuthAt — CookieString has no auto re-auth capability
}

function Update-ODataSessionIfExpired {
    <#
    .SYNOPSIS
        Re-authenticate if the session/token is about to expire.
        Call before every HTTP request.
    #>
    if ($null -eq $script:ODataSession) { throw "OData: not connected. Call Connect-ODataAPI first." }

    $margin = [timespan]::FromMinutes(2)

    switch ($script:ODataSession.AuthMethod) {
        'OAuth2CC' {
            if ($script:ODataSession.TokenExpiresAt -and [datetime]::UtcNow -ge ($script:ODataSession.TokenExpiresAt - $margin)) {
                Write-Host "  OData: refreshing OAuth2CC token..." -ForegroundColor Gray
                Invoke-ODataOAuth2 -GrantType 'client_credentials'
            }
        }
        'OAuth2ROPC' {
            if ($script:ODataSession.TokenExpiresAt -and [datetime]::UtcNow -ge ($script:ODataSession.TokenExpiresAt - $margin)) {
                Write-Host "  OData: refreshing OAuth2ROPC token..." -ForegroundColor Gray
                Invoke-ODataOAuth2 -GrantType 'password'
            }
        }
        'FormCookie' {
            $timeout = [timespan]::FromMinutes($script:ODataSession.SessionTimeoutMinutes)
            if ($script:ODataSession.LastAuthAt -and [datetime]::UtcNow -ge ($script:ODataSession.LastAuthAt + $timeout - $margin)) {
                Write-Host "  OData: re-authenticating (FormCookie session expiry)..." -ForegroundColor Gray
                Invoke-ODataFormAuth
            }
        }
        # CookieString and ApiToken: no-op (static)
    }
}

#endregion Functions
