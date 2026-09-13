<#
.SYNOPSIS
    Worker-side SSRF guard for crawler connector URLs.

.DESCRIPTION
    A pull crawler sends its credential (client secret, Basic header, bearer token,
    session cookie) to whatever baseUrl / tokenEndpoint its config names, and follows
    pagination links the server hands back. Nothing on the worker used to check those
    URLs, so a config could point a crawler at the Identity Atlas API, the database
    network, or a cloud metadata endpoint (SEC-2026-09 M-03).

    This is the PowerShell twin of app/api/src/lib/ssrfGuard.js — keep the rule sets
    in step. Every address is one of three classes:
      public    — always allowed;
      private   — loopback, RFC 1918, CGNAT, IPv6 unique-local / site-local; allowed
                  only with -AllowPrivateNetwork (an on-premises server);
      forbidden — link-local / cloud metadata, unspecified, multicast, reserved,
                  documentation and tunnelling ranges; never allowed.
    IPv6 addresses that embed an IPv4 address (IPv4-mapped, NAT64, 6to4) are
    classified by the IPv4 address they carry. The scheme must be https unless
    -AllowInsecureHttp is given.

    Config opt-ins: `allowPrivateNetwork: true` and `allowInsecureHttp: true` in the
    crawler config (see Get-FGUrlPolicyParam). The API applies the same policy when
    a config is saved, so a URL refused here was normally refused there too — this
    check exists for configs stored before the guard, and for DNS that changes
    between save and run.

    Dot-sourced by the crawler libraries that open connections
    (odata/Invoke-ODataAuth.ps1, midpoint/Invoke-MidpointApi.ps1,
    scim/ScimCrawler.Functions.ps1).
#>

#region Functions

function Get-FGIPv4Class {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [byte[]]$Bytes)
    $a = [int]$Bytes[0]
    $b = [int]$Bytes[1]
    if ($a -eq 0 -or ($a -eq 169 -and $b -eq 254) -or $a -ge 224) { return 'forbidden' }

    if ($a -eq 127 -or $a -eq 10 -or ($a -eq 192 -and $b -eq 168)) { return 'private' }

    if (($a -eq 172 -and $b -ge 16 -and $b -le 31) -or ($a -eq 100 -and $b -ge 64 -and $b -le 127)) { return 'private' }

    return 'public'
}

# ::/96 (unspecified, loopback, IPv4-compatible), ::ffff:0:0/96 (IPv4-mapped) and
# 64:ff9b::/96 (NAT64). Returns a class, or $null when the address is none of them.
function Get-FGIPv6EmbeddingClass {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [int[]]$Hextet, [Parameter(Mandatory)] [byte[]]$Bytes)
    $v4 = [byte[]]$Bytes[12..15]
    $upper5Zero = -not ($Hextet[0..4] | Where-Object { $_ -ne 0 })
    if ($upper5Zero -and $Hextet[5] -eq 0xffff) { return Get-FGIPv4Class -Bytes $v4 }

    if ($upper5Zero -and $Hextet[5] -eq 0) {
        if ($Hextet[6] -eq 0 -and $Hextet[7] -eq 1) { return 'private' }

        return 'forbidden'
    }

    $nat64Zero = -not ($Hextet[2..5] | Where-Object { $_ -ne 0 })
    if ($Hextet[0] -eq 0x64 -and $Hextet[1] -eq 0xff9b -and $nat64Zero) { return Get-FGIPv4Class -Bytes $v4 }

    return $null
}

function Get-FGIPv6Class {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [byte[]]$Bytes)
    $g = [int[]](0..7 | ForEach-Object { ([int]$Bytes[2 * $_] -shl 8) -bor [int]$Bytes[2 * $_ + 1] })
    $embedded = Get-FGIPv6EmbeddingClass -Hextet $g -Bytes $Bytes
    if ($embedded) { return $embedded }

    if (($g[0] -band 0xe000) -ne 0x2000) {
        # Outside global unicast: unique-local fc00::/7 and site-local fec0::/10 are
        # private; link-local, multicast and everything reserved is forbidden.
        if (($g[0] -band 0xfe00) -eq 0xfc00 -or ($g[0] -band 0xffc0) -eq 0xfec0) { return 'private' }

        return 'forbidden'
    }

    if ($g[0] -eq 0x2002) { return Get-FGIPv4Class -Bytes ([byte[]]$Bytes[2..5]) }

    if ($g[0] -eq 0x2001 -and ($g[1] -eq 0 -or $g[1] -eq 0x0db8)) { return 'forbidden' }

    return 'public'
}

<#
.SYNOPSIS
    Classify an IP address literal as 'public', 'private' or 'forbidden'.
    Anything that is not a dotted-quad or IPv6 literal is 'forbidden' (fail closed).
#>
function Get-FGAddressClass {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string]$Address)
    $text = $Address.Trim().TrimStart('[').TrimEnd(']')
    # IPAddress.TryParse also accepts bare integers ("10" → 0.0.0.10); only a
    # dotted quad or an IPv6 literal counts as an address here.
    if ($text -notmatch '^(\d{1,3}\.){3}\d{1,3}$' -and $text -notmatch ':') { return 'forbidden' }

    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($text, [ref]$ip)) { return 'forbidden' }

    $bytes = $ip.GetAddressBytes()
    if ($bytes.Length -eq 4) { return Get-FGIPv4Class -Bytes $bytes }

    return Get-FGIPv6Class -Bytes $bytes
}

<#
.SYNOPSIS
    Resolve a host name to its IP address strings. Separate so tests can mock DNS.
#>
function Resolve-FGHostAddress {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [string]$HostName)
    return @([System.Net.Dns]::GetHostAddresses($HostName) | ForEach-Object { $_.ToString() })
}

function New-FGUrlVerdict {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([bool]$IsAllowed, [string]$Reason = '')
    return [pscustomobject]@{ IsAllowed = $IsAllowed; Reason = $Reason }
}

# The addresses a URL's host stands for: the literal itself, or its DNS answers.
function Get-FGUrlHostAddress {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [System.Uri]$Uri)
    if ($Uri.HostNameType -in @('IPv4', 'IPv6')) { return @($Uri.Host.TrimStart('[').TrimEnd(']')) }

    return @(Resolve-FGHostAddress -HostName $Uri.DnsSafeHost)
}

# Why a URL's scheme is not acceptable, or $null when it is.
function Get-FGSchemeRejection {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [System.Uri]$Uri, [switch]$AllowInsecureHttp)
    if ($Uri.Scheme -eq 'https') { return $null }

    if ($Uri.Scheme -ne 'http') { return 'must use http or https' }

    if ($AllowInsecureHttp) { return $null }

    return 'must use https (set allowInsecureHttp in the crawler config to permit http)'
}

<#
.SYNOPSIS
    Decide whether a crawler may send a request (and its credential) to a URL.

.OUTPUTS
    [pscustomobject] @{ IsAllowed = [bool]; Reason = [string] } — Reason is empty
    when allowed, otherwise a sentence fragment ("must use https ...").
#>
function Test-FGPublicUrl {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$Url,
        [switch]$AllowPrivateNetwork,
        [switch]$AllowInsecureHttp
    )
    $uri = $null
    if (-not [System.Uri]::TryCreate($Url.Trim(), [System.UriKind]::Absolute, [ref]$uri) -or -not $uri.Host) {
        return New-FGUrlVerdict -IsAllowed $false -Reason 'is not a valid absolute URL'
    }

    $schemeProblem = Get-FGSchemeRejection -Uri $uri -AllowInsecureHttp:$AllowInsecureHttp
    if ($schemeProblem) { return New-FGUrlVerdict -IsAllowed $false -Reason $schemeProblem }

    try {
        $addresses = @(Get-FGUrlHostAddress -Uri $uri)
    }
    catch {
        return New-FGUrlVerdict -IsAllowed $false -Reason "host '$($uri.DnsSafeHost)' could not be resolved"
    }

    if ($addresses.Count -eq 0) { return New-FGUrlVerdict -IsAllowed $false -Reason "host '$($uri.DnsSafeHost)' did not resolve to any address" }

    $classes = @($addresses | ForEach-Object { Get-FGAddressClass -Address $_ })
    if ($classes -contains 'forbidden') { return New-FGUrlVerdict -IsAllowed $false -Reason 'resolves to a link-local, metadata, or reserved address' }

    if (($classes -contains 'private') -and -not $AllowPrivateNetwork) {
        return New-FGUrlVerdict -IsAllowed $false -Reason 'resolves to a private or loopback address (set allowPrivateNetwork in the crawler config for an on-premises system)'
    }

    return New-FGUrlVerdict -IsAllowed $true
}

<#
.SYNOPSIS
    Throw unless Test-FGPublicUrl allows the URL. The message names the config field
    (-Label) but not the URL itself, which may carry userinfo credentials.
#>
function Assert-FGPublicUrl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$Url,
        [Parameter(Mandatory)] [string]$Label,
        [switch]$AllowPrivateNetwork,
        [switch]$AllowInsecureHttp
    )
    $verdict = Test-FGPublicUrl -Url $Url -AllowPrivateNetwork:$AllowPrivateNetwork -AllowInsecureHttp:$AllowInsecureHttp
    if (-not $verdict.IsAllowed) { throw "$Label rejected: it $($verdict.Reason)" }

}

<#
.SYNOPSIS
    Throw unless a server-supplied link (an OData @odata.nextLink) stays on the host
    of the URL the crawler was configured with. The next request carries the same
    credential, so a link to any other host is refused rather than followed. The link
    may not use http unless -AllowInsecureHttp is given.
#>
function Assert-FGSameHostLink {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$Url,
        [Parameter(Mandatory)] [string]$BaseUrl,
        [Parameter(Mandatory)] [string]$Label,
        [switch]$AllowInsecureHttp
    )
    $link = $null
    $base = $null
    $linkOk = [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$link)
    $baseOk = [System.Uri]::TryCreate($BaseUrl, [System.UriKind]::Absolute, [ref]$base)
    if (-not $linkOk -or -not $baseOk) { throw "$Label rejected: it is not a valid absolute URL" }

    if ($link.Host -ne $base.Host) { throw "$Label rejected: it points to a different host than the configured base URL" }

    $schemeProblem = Get-FGSchemeRejection -Uri $link -AllowInsecureHttp:$AllowInsecureHttp
    if ($schemeProblem) { throw "$Label rejected: it $schemeProblem" }

}

<#
.SYNOPSIS
    Read the two URL opt-ins from a crawler config (hashtable or PSCustomObject) as
    a splattable hashtable for Connect-*API. Only a real boolean $true opts in: a
    string "true" does not.
#>
function Get-FGUrlPolicyParam {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([AllowNull()] $Cfg)
    $result = @{ AllowPrivateNetwork = $false; AllowInsecureHttp = $false }
    if ($null -eq $Cfg) { return $result }

    foreach ($name in @('AllowPrivateNetwork', 'AllowInsecureHttp')) {
        $key = $name.Substring(0, 1).ToLowerInvariant() + $name.Substring(1)
        $value = if ($Cfg -is [System.Collections.IDictionary]) { $Cfg[$key] } else { $Cfg.$key }
        $result[$name] = ($value -is [bool]) -and $value
    }

    return $result
}

#endregion Functions
