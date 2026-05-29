<#
.SYNOPSIS
    Omada REST API authentication — multi-method session management.

.DESCRIPTION
    Provides Connect-OmadaAPI (establishes a session) and
    Update-OmadaSessionIfExpired (refreshes before each request).

    Session state lives in $script:OmadaSession (module-scoped).
    Auth methods:
      FormCookie  — POST /api/authenticate, capture Set-Cookie
      OAuth2CC    — client_credentials grant → bearer token
      OAuth2ROPC  — password grant → bearer token
      ApiToken    — static bearer token (no refresh)
      CookieString — pre-built semicolon-delimited cookie string

.NOTES
    WindowsAuth is intentionally not implemented — it requires a
    domain-joined worker (Kerberos keytab on Linux) which is not
    practical for Docker deployments. Use FormCookie or OAuth2ROPC
    for on-premise environments instead.
#>

$script:OmadaSession = $null

function Connect-OmadaAPI {
    <#
    .SYNOPSIS
        Authenticate to Omada and store the session for subsequent calls.
    #>
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory)] [string]$BaseUrl,
        [Parameter(Mandatory)] [ValidateSet('FormCookie','OAuth2CC','OAuth2ROPC','ApiToken','CookieString')]
        [string]$AuthMethod,
        [string]$Username          = '',
        [string]$Password          = '',
        [string]$ClientId          = '',
        [string]$ClientSecret      = '',
        [string]$TokenEndpoint     = '',
        [string]$ApiToken          = '',
        [string]$CookieString      = '',
        [string]$ApiVersion        = 'v14',
        [int]$SessionTimeoutMinutes = 30
    )

    $base = $BaseUrl.TrimEnd('/')

    $script:OmadaSession = @{
        AuthMethod            = $AuthMethod
        BaseUrl               = $base
        ApiVersion            = $ApiVersion
        WebSession            = $null
        AccessToken           = $null
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
        'FormCookie'   { Invoke-OmadaFormAuth }
        'OAuth2CC'     { Invoke-OmadaOAuth2 -GrantType 'client_credentials' }
        'OAuth2ROPC'   { Invoke-OmadaOAuth2 -GrantType 'password' }
        'ApiToken'     { $script:OmadaSession.AccessToken = $ApiToken }
        'CookieString' { Invoke-OmadaCookieStringAuth -CookieString $CookieString }
    }

    Write-Host "  Omada: authenticated via $AuthMethod to $base" -ForegroundColor Green
}

function Invoke-OmadaFormAuth {
    $base = $script:OmadaSession.BaseUrl
    $webSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $body = @{ Username = $script:OmadaSession._Username; Password = $script:OmadaSession._Password } | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri "$base/api/authenticate" -Method Post `
            -ContentType 'application/json' -Body $body `
            -WebSession $webSession -ErrorAction Stop | Out-Null
    } catch {
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
        throw "Omada FormCookie auth failed (HTTP $status): $($_.Exception.Message)"
    }

    $script:OmadaSession.WebSession  = $webSession
    $script:OmadaSession.LastAuthAt  = [datetime]::UtcNow
}

function Invoke-OmadaOAuth2 {
    param([ValidateSet('client_credentials','password')] [string]$GrantType)
    $endpoint = $script:OmadaSession._TokenEndpoint
    if (-not $endpoint) { throw "Omada OAuth2: tokenEndpoint is required" }

    $form = @{
        grant_type    = $GrantType
        client_id     = $script:OmadaSession._ClientId
        client_secret = $script:OmadaSession._ClientSecret
    }
    if ($GrantType -eq 'password') {
        $form['username'] = $script:OmadaSession._Username
        $form['password'] = $script:OmadaSession._Password
    }

    try {
        $resp = Invoke-RestMethod -Uri $endpoint -Method Post -Body $form -ErrorAction Stop
    } catch {
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
        throw "Omada OAuth2 ($GrantType) failed (HTTP $status): $($_.Exception.Message)"
    }

    $script:OmadaSession.AccessToken    = $resp.access_token
    $expiresIn = if ($resp.expires_in) { [int]$resp.expires_in } else { 3600 }
    $script:OmadaSession.TokenExpiresAt = [datetime]::UtcNow.AddSeconds($expiresIn)
}

function Invoke-OmadaCookieStringAuth {
    param([string]$CookieString)
    if (-not $CookieString.Trim()) { throw "Omada CookieString: cookieString cannot be empty" }

    $webSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $uri = [Uri]$script:OmadaSession.BaseUrl

    foreach ($pair in $CookieString.Split(';')) {
        $kv = $pair.Trim()
        if (-not $kv) { continue }
        $eqIdx = $kv.IndexOf('=')
        if ($eqIdx -le 0) { continue }
        $name  = $kv.Substring(0, $eqIdx).Trim()
        $value = $kv.Substring($eqIdx + 1).Trim()
        $cookie = [System.Net.Cookie]::new($name, $value, '/', $uri.Host)
        $webSession.Cookies.Add($cookie)
    }

    $script:OmadaSession.WebSession = $webSession
    # No LastAuthAt — CookieString has no auto re-auth capability
}

function Update-OmadaSessionIfExpired {
    <#
    .SYNOPSIS
        Re-authenticate if the session/token is about to expire.
        Call before every HTTP request.
    #>
    if ($null -eq $script:OmadaSession) { throw "Omada: not connected. Call Connect-OmadaAPI first." }

    $margin = [timespan]::FromMinutes(2)

    switch ($script:OmadaSession.AuthMethod) {
        'OAuth2CC' {
            if ($script:OmadaSession.TokenExpiresAt -and [datetime]::UtcNow -ge ($script:OmadaSession.TokenExpiresAt - $margin)) {
                Write-Host "  Omada: refreshing OAuth2CC token..." -ForegroundColor Gray
                Invoke-OmadaOAuth2 -GrantType 'client_credentials'
            }
        }
        'OAuth2ROPC' {
            if ($script:OmadaSession.TokenExpiresAt -and [datetime]::UtcNow -ge ($script:OmadaSession.TokenExpiresAt - $margin)) {
                Write-Host "  Omada: refreshing OAuth2ROPC token..." -ForegroundColor Gray
                Invoke-OmadaOAuth2 -GrantType 'password'
            }
        }
        'FormCookie' {
            $timeout = [timespan]::FromMinutes($script:OmadaSession.SessionTimeoutMinutes)
            if ($script:OmadaSession.LastAuthAt -and [datetime]::UtcNow -ge ($script:OmadaSession.LastAuthAt + $timeout - $margin)) {
                Write-Host "  Omada: re-authenticating (FormCookie session expiry)..." -ForegroundColor Gray
                Invoke-OmadaFormAuth
            }
        }
        # CookieString and ApiToken: no-op (static)
    }
}

function Get-OmadaRefValue {
    <#
    .SYNOPSIS
        Extract the display value from an Omada reference object or return a string as-is.
    .DESCRIPTION
        Omada REST API returns reference fields as objects: { _UID, Value, english, _DISPLAYNAME }.
        CSV exports flatten these to column_VALUE or column_ENGLISH. This helper handles both.
    #>
    param($Ref, [string]$Fallback = '')
    if ($null -eq $Ref)           { return $Fallback }
    if ($Ref -is [string])        { return $Ref }
    if ($Ref.Value)               { return [string]$Ref.Value }
    if ($Ref.english)             { return [string]$Ref.english }
    if ($Ref._DISPLAYNAME)        { return [string]$Ref._DISPLAYNAME }
    if ($Ref.displayName)         { return [string]$Ref.displayName }
    return $Fallback
}

function Get-OmadaRefUid {
    <#
    .SYNOPSIS
        Extract the _UID from an Omada reference object or return the string as-is.
    #>
    param($Ref, [string]$Fallback = '')
    if ($null -eq $Ref)    { return $Fallback }
    if ($Ref -is [string]) { return $Ref }
    if ($Ref._UID)         { return [string]$Ref._UID }
    if ($Ref.uid)          { return [string]$Ref.uid }
    if ($Ref.id)           { return [string]$Ref.id }
    return $Fallback
}
