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

#region Functions

function Connect-OmadaAPI {
    <#
    .SYNOPSIS
        Authenticate to Omada and store the session for subsequent calls.
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
        'FormCookie'   { Invoke-OmadaFormAuth }
        'OAuth2CC'     { Invoke-OmadaOAuth2 -GrantType 'client_credentials' }
        'OAuth2ROPC'   { Invoke-OmadaOAuth2 -GrantType 'password' }
        'ApiToken'     { $script:OmadaSession.AccessToken = $ApiToken }
        'CookieString' { Invoke-OmadaCookieStringAuth -CookieString $CookieString }
        'BasicAuth'    {
            if (-not $Username -or -not $Password) { throw "Omada BasicAuth: username and password are required" }
            $encoded = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("${Username}:${Password}"))
            $script:OmadaSession.BasicAuthHeader = "Basic $encoded"
        }
    }

    Write-Host "  Omada: authenticated via $AuthMethod to $base" -ForegroundColor Green
}

function Get-OmadaAuthRoot {
    # Derive the server root URL for /api/authenticate from the OData base URL.
    # Cloud:    https://tenant.omada.cloud/odata/dataobjects  → https://tenant.omada.cloud
    # On-prem:  http://server/odata/dataobjects               → http://server
    # Fallback: http://server/anything-else                   → http://server/anything-else (unchanged)
    $base     = $script:OmadaSession.BaseUrl
    $odataIdx = $base.IndexOf('/odata/')
    if ($odataIdx -gt 0) { return $base.Substring(0, $odataIdx) }
    return $base
}

function Invoke-OmadaFormAuth {
    $authRoot  = Get-OmadaAuthRoot
    $authUri   = $authRoot + '/api/authenticate'
    $webSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $body = @{ Username = $script:OmadaSession._Username; Password = $script:OmadaSession._Password } | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri $authUri -Method Post `
            -ContentType 'application/json' -Body $body `
            -WebSession $webSession -ErrorAction Stop | Out-Null
    } catch {
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
        throw "Omada FormCookie auth failed (HTTP $status) at $authUri`: $($_.Exception.Message)"
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

    $raw = $CookieString.Trim()

    # If the value is just a token (no cookie name prefix like "oisauthtoken=…"),
    # auto-prepend "oisauthtoken=". A name=value pair is detected by checking that
    # the first '=' is followed by a non-'=' character (i.e. not base64 padding).
    # Examples:
    #   "MHXp1OG0seFfKwNYzQkZwA=="        → oisauthtoken=MHXp1OG0seFfKwNYzQkZwA==
    #   "oisauthtoken=MHXp1OG0seFfKwNYzQkZwA==" → sent as-is (already name=value)
    #   "ASP.NET_SessionId=abc; Auth=xyz"  → sent as-is (multi-cookie, on-prem)
    if ($raw -notmatch '^[A-Za-z][A-Za-z0-9_.%-]*=[^=]') {
        $raw = 'oisauthtoken=' + $raw
    }

    # Cloud Omada requires an explicit Cookie request header; WebSession cookie-domain
    # matching is unreliable for cloud/HTTPS URLs.
    $script:OmadaSession.CookieHeader = $raw
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
        OData 4.0 (on-prem/cloud): OIS.SetValue has .Value (string label);
        OIS.ReferenceValue has .DisplayName (string label).
        CSV export fallback: column_VALUE, column_ENGLISH, _DISPLAYNAME.
    #>
    param($Ref, [string]$Fallback = '')
    if ($null -eq $Ref)           { return $Fallback }
    if ($Ref -is [string])        { return $Ref }
    if ($Ref.Value)               { return [string]$Ref.Value }       # OIS.SetValue
    if ($Ref.DisplayName)         { return [string]$Ref.DisplayName } # OIS.ReferenceValue (OData)
    if ($Ref.english)             { return [string]$Ref.english }
    if ($Ref._DISPLAYNAME)        { return [string]$Ref._DISPLAYNAME }
    if ($Ref.displayName)         { return [string]$Ref.displayName }
    return $Fallback
}

function Get-OmadaRefUid {
    <#
    .SYNOPSIS
        Extract the UId (Guid) from an Omada reference object or return the string as-is.
    .DESCRIPTION
        OData 4.0: OIS.ReferenceValue has .UId (Guid). Legacy: ._UID.
    #>
    param($Ref, [string]$Fallback = '')
    if ($null -eq $Ref)    { return $Fallback }
    if ($Ref -is [string]) { return $Ref }
    if ($Ref.UId)          { return [string]$Ref.UId }  # OIS.ReferenceValue (OData)
    if ($Ref._UID)         { return [string]$Ref._UID }
    if ($Ref.uid)          { return [string]$Ref.uid }
    if ($Ref.id)           { return [string]$Ref.id }
    return $Fallback
}

function Get-OmadaEntitySets {
    <#
    .SYNOPSIS
        Fetch the OData $metadata document and return the list of entity set names.
        Returns an empty array if the fetch fails (non-blocking — caller decides how to handle).
    #>
    if ($null -eq $script:OmadaSession) { return @() }
    # Build URI via string concat — NOT interpolation — to keep the literal '$metadata' intact
    $metaUri = $script:OmadaSession.BaseUrl.TrimEnd('/') + '/$metadata'
    $reqParams = @{ Uri = $metaUri; Method = 'Get'; ErrorAction = 'Stop' }
    switch ($script:OmadaSession.AuthMethod) {
        { $_ -in 'OAuth2CC','OAuth2ROPC','ApiToken' } {
            $reqParams['Headers'] = @{ Authorization = "Bearer $($script:OmadaSession.AccessToken)" }
        }
        'CookieString' {
            # $metadata returns XML — do NOT send Accept: application/json or Content-Type
            # here; those headers cause a 500 on cloud instances when the server tries to
            # serialize the metadata as JSON (which it does not support on this endpoint).
            $reqParams['Headers'] = @{ Cookie = $script:OmadaSession.CookieHeader }
        }
        'FormCookie' {
            $reqParams['WebSession'] = $script:OmadaSession.WebSession
        }
        'BasicAuth' {
            $reqParams['Headers'] = @{ Authorization = $script:OmadaSession.BasicAuthHeader }
        }
    }
    try {
        $content = (Invoke-WebRequest @reqParams).Content
        return @([regex]::Matches($content, 'EntitySet\s+Name="([^"]+)"') |
                 ForEach-Object { $_.Groups[1].Value } |
                 Where-Object { $_ })
    } catch {
        Write-Host "  Warning: OData metadata fetch failed — $($_.Exception.Message)" -ForegroundColor Yellow
        return @()
    }
}

#endregion Functions
