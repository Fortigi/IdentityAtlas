<#
.SYNOPSIS
    midPoint (Evolveum) REST API client — authentication, search, get, and ref helpers.

.DESCRIPTION
    midPoint exposes a REST API under <base>/midpoint/ws/rest. Objects are read with
    POST /{type}/search (paged) and GET /{type}/{oid}. This library provides:

      Connect-MidpointAPI    — establish a session (BasicAuth, ApiToken, OAuth2CC, OAuth2ROPC)
      Invoke-MidpointSearch  — fetch all objects of a type, transparently paged
      Invoke-MidpointGet     — fetch a single object by OID (unwrapped)
      Get-MidpointRefOid     — extract the .oid from a midPoint reference (or first of an array)
      Get-MidpointRefType    — extract the (normalised) target type from a reference
      Get-MidpointString     — coerce a PolyString / plain string field to a plain string
      Test-MidpointEnabled   — map activation.effectiveStatus to a boolean

    Session state lives in $script:MidpointSession (module-scoped), mirroring the
    OData base layer's pattern so the dispatcher can dot-source this file before the
    midpoint entry point runs.

.NOTES
    The search envelope is { "object": { "@type": "...", "object": [ ... ] } }. The
    inner "object" is an array for multiple results but a single object for exactly
    one result — callers always receive a flat array.
#>

$script:MidpointSession = $null

#region Connection

function Connect-MidpointAPI {
    <#
    .SYNOPSIS
        Authenticate to a midPoint REST endpoint and store the session for later calls.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory)] [string]$BaseUrl,
        [Parameter(Mandatory)] [ValidateSet('BasicAuth', 'ApiToken', 'OAuth2CC', 'OAuth2ROPC')]
        [string]$AuthMethod,
        [string]$Username      = '',
        [string]$Password      = '',
        [string]$ApiToken      = '',
        [string]$ClientId      = '',
        [string]$ClientSecret  = '',
        [string]$TokenEndpoint = '',
        [int]$TimeoutSec       = 120
    )

    $rest = Get-MidpointRestRoot -BaseUrl $BaseUrl

    $script:MidpointSession = @{
        AuthMethod      = $AuthMethod
        RestRoot        = $rest
        TimeoutSec      = $TimeoutSec
        AuthHeader      = $null
        AccessToken     = $null
        TokenExpiresAt  = $null
        _Username       = $Username
        _Password       = $Password
        _ClientId       = $ClientId
        _ClientSecret   = $ClientSecret
        _TokenEndpoint  = $TokenEndpoint
    }

    switch ($AuthMethod) {
        'BasicAuth' {
            if (-not $Username -or -not $Password) { throw "midPoint BasicAuth: username and password are required" }
            $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("${Username}:${Password}"))
            $script:MidpointSession.AuthHeader = "Basic $encoded"
        }
        'ApiToken' {
            if (-not $ApiToken) { throw "midPoint ApiToken: apiToken is required" }
            $script:MidpointSession.AuthHeader = "Bearer $ApiToken"
        }
        'OAuth2CC'   { Invoke-MidpointOAuth2 -GrantType 'client_credentials' }
        'OAuth2ROPC' { Invoke-MidpointOAuth2 -GrantType 'password' }
    }

    Write-Host "  midPoint: authenticated via $AuthMethod to $rest" -ForegroundColor Green
}

function Get-MidpointRestRoot {
    <#
    .SYNOPSIS
        Normalise any midPoint base URL to the REST root (<host>/midpoint/ws/rest).
        Accepts: https://h/midpoint, https://h/midpoint/, https://h/midpoint/ws/rest,
        or a bare host (assumes /midpoint/ws/rest).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$BaseUrl)
    $b = $BaseUrl.Trim().TrimEnd('/')
    if ($b -match '(?i)/ws/rest$') { return $b }
    if ($b -match '(?i)/midpoint$') { return "$b/ws/rest" }
    if ($b -match '(?i)/midpoint/') { return ($b -replace '(?i)(/midpoint).*$', '$1') + '/ws/rest' }
    return "$b/midpoint/ws/rest"
}

function Invoke-MidpointOAuth2 {
    [CmdletBinding()]
    param([ValidateSet('client_credentials', 'password')][string]$GrantType)
    $endpoint = $script:MidpointSession._TokenEndpoint
    if (-not $endpoint) { throw "midPoint OAuth2: tokenEndpoint is required" }

    $form = @{
        grant_type    = $GrantType
        client_id     = $script:MidpointSession._ClientId
        client_secret = $script:MidpointSession._ClientSecret
    }
    if ($GrantType -eq 'password') {
        $form['username'] = $script:MidpointSession._Username
        $form['password'] = $script:MidpointSession._Password
    }

    try {
        $resp = Invoke-RestMethod -Uri $endpoint -Method Post -Body $form -ErrorAction Stop
    } catch {
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
        throw "midPoint OAuth2 ($GrantType) failed (HTTP $status): $($_.Exception.Message)"
    }

    $script:MidpointSession.AccessToken = $resp.access_token
    $script:MidpointSession.AuthHeader  = "Bearer $($resp.access_token)"
    $expiresIn = if ($resp.expires_in) { [int]$resp.expires_in } else { 3600 }
    $script:MidpointSession.TokenExpiresAt = [datetime]::UtcNow.AddSeconds($expiresIn)
}

function Update-MidpointSessionIfExpired {
    [CmdletBinding()]
    param()
    if ($null -eq $script:MidpointSession) { throw "midPoint: not connected. Call Connect-MidpointAPI first." }
    $margin = [timespan]::FromMinutes(2)
    switch ($script:MidpointSession.AuthMethod) {
        'OAuth2CC' {
            if ($script:MidpointSession.TokenExpiresAt -and [datetime]::UtcNow -ge ($script:MidpointSession.TokenExpiresAt - $margin)) {
                Invoke-MidpointOAuth2 -GrantType 'client_credentials'
            }
        }
        'OAuth2ROPC' {
            if ($script:MidpointSession.TokenExpiresAt -and [datetime]::UtcNow -ge ($script:MidpointSession.TokenExpiresAt - $margin)) {
                Invoke-MidpointOAuth2 -GrantType 'password'
            }
        }
    }
}

function Get-MidpointHeaders {
    [CmdletBinding()]
    param()
    if ($null -eq $script:MidpointSession) { throw "midPoint: not connected. Call Connect-MidpointAPI first." }
    Update-MidpointSessionIfExpired
    return @{
        Authorization  = $script:MidpointSession.AuthHeader
        'Content-Type' = 'application/json'
        Accept         = 'application/json'
    }
}

#endregion Connection

#region Requests

function Invoke-MidpointSearch {
    <#
    .SYNOPSIS
        Fetch all objects of a midPoint type via POST /{type}/search, transparently paged.
    .PARAMETER Type
        REST collection name: users, roles, orgs, services, resources, shadows, connectors, ...
    .PARAMETER Query
        Optional hashtable merged into the "query" object (e.g. a filter). Paging is added
        automatically and must not be supplied here.
    .PARAMETER PageSize
        maxSize per request (default 100).
    .PARAMETER MaxItems
        Optional hard cap on total items returned (0 = no cap).
    .OUTPUTS
        Flat [object[]] of midPoint objects (never null; empty array when none).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Type,
        [hashtable]$Query = @{},
        [int]$PageSize    = 100,
        [int]$MaxItems    = 0,
        [int]$MaxRetries  = 4,
        [string]$Options  = '',  # midPoint search options appended as ?options= (e.g. 'raw' for shadows)
        [string]$Include  = ''   # container(s) to retrieve, appended as ?include= (e.g. 'case' for campaigns)
    )

    $rest    = $script:MidpointSession.RestRoot
    $uri     = "$rest/$Type/search"
    $qs = @()
    if ($Options) { $qs += "options=$Options" }
    if ($Include) { $qs += "include=$Include" }
    if ($qs.Count -gt 0) { $uri += '?' + ($qs -join '&') }
    $offset  = 0
    $all     = [System.Collections.Generic.List[object]]::new()

    while ($true) {
        $paging = @{ maxSize = $PageSize; offset = $offset }
        $queryObj = @{}
        foreach ($k in $Query.Keys) { $queryObj[$k] = $Query[$k] }
        $queryObj['paging'] = $paging
        $body = @{ query = $queryObj } | ConvertTo-Json -Depth 20 -Compress

        $resp = Invoke-MidpointRequest -Method Post -Uri $uri -Body $body -MaxRetries $MaxRetries
        $page = ConvertTo-MidpointObjectArray -SearchResponse $resp

        foreach ($o in $page) {
            [void]$all.Add($o)
            if ($MaxItems -gt 0 -and $all.Count -ge $MaxItems) { return $all.ToArray() }
        }

        if ($page.Count -lt $PageSize) { break }   # last page
        $offset += $PageSize
    }

    # Return the flat array; callers wrap with @() so 0/1-element results stay arrays.
    return $all.ToArray()
}

function Invoke-MidpointGet {
    <#
    .SYNOPSIS
        Fetch a single midPoint object by OID. Returns the unwrapped object (or $null on 404).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Type,
        [Parameter(Mandatory)] [string]$Oid
    )
    $rest = $script:MidpointSession.RestRoot
    $uri  = "$rest/$Type/$Oid"
    try {
        $resp = Invoke-MidpointRequest -Method Get -Uri $uri
    } catch {
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
        if ($status -eq 404) { return $null }
        throw
    }
    # GET returns a single-key wrapper, e.g. { "user": { ... } }
    if ($resp -is [System.Collections.IDictionary] -or $resp.PSObject) {
        $props = @($resp.PSObject.Properties)
        if ($props.Count -eq 1) { return $props[0].Value }
    }
    return $resp
}

function Invoke-MidpointRequest {
    <#
    .SYNOPSIS
        Low-level REST call with retry/backoff on transient failures.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Method,
        [Parameter(Mandatory)] [string]$Uri,
        [string]$Body = $null,
        [int]$MaxRetries = 4
    )
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            $headers = Get-MidpointHeaders
            $params  = @{ Uri = $Uri; Method = $Method; Headers = $headers; TimeoutSec = $script:MidpointSession.TimeoutSec; ErrorAction = 'Stop' }
            if ($Body) { $params['Body'] = $Body }
            return Invoke-RestMethod @params
        } catch {
            $status = $null
            try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
            $isTransient = (-not $status) -or ($status -ge 500) -or ($status -eq 429)
            if ($isTransient -and $attempt -le $MaxRetries) {
                $delay = [Math]::Pow(2, $attempt)
                Write-Host "  midPoint transient failure ($([string]::Format('{0}', $status))) on $Method $Uri — retry $attempt/$MaxRetries in ${delay}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
                continue
            }
            throw
        }
    }
}

function ConvertTo-MidpointObjectArray {
    <#
    .SYNOPSIS
        Extract the object list from a midPoint search envelope as a flat array.
        Handles the single-result case (inner "object" is a single object, not an array).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$SearchResponse)

    $outer = $SearchResponse.object
    if ($null -eq $outer) { return @() }
    $inner = $outer.object
    if ($null -eq $inner) { return @() }
    if ($inner -is [System.Array]) { return $inner }
    return @($inner)
}

#endregion Requests

#region Ref / value helpers

function Get-MidpointRefOid {
    <#
    .SYNOPSIS
        Extract the .oid from a midPoint reference. Accepts a single ref object,
        an array of refs (returns the first), or $null. Returns '' (or -Fallback) when absent.
    #>
    [CmdletBinding()]
    param($Ref, $Fallback = '')
    if ($null -eq $Ref) { return $Fallback }
    if ($Ref -is [System.Array]) {
        if ($Ref.Count -eq 0) { return $Fallback }
        $Ref = $Ref[0]
    }
    if ($Ref -is [string]) { return $Ref }
    $oid = $Ref.oid
    if ($oid) { return [string]$oid }
    return $Fallback
}

function Get-MidpointRefType {
    <#
    .SYNOPSIS
        Return the normalised target type of a reference (e.g. "c:RoleType" → "RoleType").
    #>
    [CmdletBinding()]
    param($Ref, $Fallback = '')
    if ($null -eq $Ref) { return $Fallback }
    if ($Ref -is [System.Array]) {
        if ($Ref.Count -eq 0) { return $Fallback }
        $Ref = $Ref[0]
    }
    $t = $Ref.type
    if (-not $t) { return $Fallback }
    return ([string]$t) -replace '^[a-zA-Z0-9]+:', ''   # strip namespace prefix (c:)
}

function Get-MidpointRefRelation {
    [CmdletBinding()]
    param($Ref, $Fallback = '')
    if ($null -eq $Ref) { return $Fallback }
    if ($Ref -is [System.Array]) {
        if ($Ref.Count -eq 0) { return $Fallback }
        $Ref = $Ref[0]
    }
    $r = $Ref.relation
    if ($r) { return [string]$r }
    return $Fallback
}

function Get-MidpointString {
    <#
    .SYNOPSIS
        Coerce a midPoint field to a single plain string. Handles: plain strings,
        PolyString ({ orig } / { norm }) objects, and MULTI-VALUED fields (midPoint
        returns repeating properties such as emailAddress as a JSON array) — for which
        the first non-null value is taken, since the target is a single SQL column.
    #>
    [CmdletBinding()]
    param($Value, $Fallback = '')
    if ($null -eq $Value) { return $Fallback }
    if ($Value -is [string]) { return $Value }
    if ($Value -is [System.Array]) {
        foreach ($v in $Value) { if ($null -ne $v) { return (Get-MidpointString $v $Fallback) } }
        return $Fallback
    }
    if ($Value.orig) { return [string]$Value.orig }
    if ($Value.norm) { return [string]$Value.norm }
    return [string]$Value
}

function Get-MidpointAttrValue {
    <#
    .SYNOPSIS
        Read a (ri:-prefixed) attribute value from a shadow's attributes bag. Values are
        midPoint typed-scalars { "@value": ... } and may be arrays — first non-empty wins.
    #>
    [CmdletBinding()]
    param($Shadow, [string[]]$Keys)
    $attrs = $Shadow.attributes
    if (-not $attrs) { return $null }
    foreach ($k in $Keys) {
        foreach ($prop in $attrs.PSObject.Properties) {
            if (($prop.Name -replace '^ri:', '') -ieq $k) {
                $v = $prop.Value
                if ($v -is [System.Array]) { $v = $v | Select-Object -First 1 }
                $val = if ($null -ne $v.'@value') { [string]$v.'@value' } elseif ($v -is [string]) { $v } else { [string]$v }
                if ($val -and $val.Trim()) { return $val.Trim() }
            }
        }
    }
    return $null
}

function Format-AccountLabel {
    <# .SYNOPSIS Extract the CN component from an LDAP DN: "CN=Andrea Hill [..],OU=.." → "Andrea Hill". #>
    [CmdletBinding()]
    param([string]$Raw)
    if ($Raw -and $Raw -match '(?i)^CN=([^,\[]+)') { return $Matches[1].Trim() }
    return $Raw
}

function New-StableGuid {
    <# .SYNOPSIS Stable UUID derived from a string (MD5 → GUID) for idempotent surrogate ids. #>
    [CmdletBinding()]
    param([string]$Seed)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try { $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Seed)) } finally { $md5.Dispose() }
    return ([guid]::new($bytes)).ToString()
}

function Convert-MidpointOutcome {
    <# .SYNOPSIS Map a midPoint certification outcome to an Identity Atlas review decision. #>
    [CmdletBinding()]
    param([string]$Outcome)
    switch ($Outcome) {
        'accept'     { 'Certify' }
        'revoke'     { 'Revoke' }
        'reduce'     { 'Reduce' }
        'notDecided' { 'NoDecision' }
        'noResponse' { 'NoResponse' }
        default      { if ($Outcome) { $Outcome } else { 'NoDecision' } }
    }
}

function Test-MidpointEnabled {
    <#
    .SYNOPSIS
        Map an object's activation to a boolean (enabled). Absent activation = enabled.
    #>
    [CmdletBinding()]
    param($Object)
    $act = $Object.activation
    if ($null -eq $act) { return $true }
    $eff = $act.effectiveStatus
    if ($eff) { return ([string]$eff -eq 'enabled') }
    $adm = $act.administrativeStatus
    if ($adm) { return ([string]$adm -eq 'enabled') }
    return $true
}

#endregion Ref / value helpers
