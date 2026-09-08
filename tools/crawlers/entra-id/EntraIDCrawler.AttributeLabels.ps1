<#
.SYNOPSIS
    Entra ID crawler — friendly display names for directory-extension attributes.

.DESCRIPTION
    Directory-extension attributes come off Graph under their wire name,
    `extension_<32-hex appId>_<attributeName>`, where the middle segment is the
    appId of the application the extension was defined for. That is the name the
    tenant knows the attribute by, so the crawler keeps storing it verbatim as
    the `extendedAttributes` key — nothing here changes what is stored.

    What the crawler adds is a rawKey -> friendly-name map, stamped onto the
    System's own `extendedAttributes` as `attributeDisplayNames`. The crawler is
    the only layer that sees a system's whole attribute set at once, which is what
    lets it disambiguate two extension apps that both define `employeeID`.

    The API applies the same strip as a read-time fallback for anything the map
    doesn't cover, so an install that has not re-crawled still gets clean names —
    this map is the authoritative, collision-aware version of that answer.

    Pure functions, no Graph or API calls; unit-tested by
    test/unit/EntraIDCrawlerAttributeLabels.Tests.ps1.
#>

<#
.SYNOPSIS
    Matches one attribute key against the directory-extension key shape.

.DESCRIPTION
    The single place the pattern lives — exactly 32 hex characters between the
    underscores, so `extension_notarealguid_foo` is NOT one and must be left
    alone. Group 1 is the owning appId, group 2 the attribute name.

    A function rather than a script-scope variable on purpose: these files are
    dot-sourced into the crawler entry point (and into a Pester scope), where a
    `$script:` lookup from inside a function resolves against the caller's script
    scope, not this file's.
#>
function Get-FGAttributeExtensionMatch {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string]$Key)

    return [regex]::Match($Key, '^extension_([0-9a-f]{32})_(.+)$', 'IgnoreCase')
}

<#
.SYNOPSIS
    The friendly name for one attribute key, or $null when there is nothing to
    rename.

.DESCRIPTION
    Returns everything after the `extension_<appId>_` prefix VERBATIM — the
    requested name is `sAMAccountName`, not `S A M Account Name`, and a derived
    `..._fgGroupDN_OuPath` key keeps its `_OuPath` tail. Any key that is not
    extension-shaped returns $null, meaning "leave it exactly as it is".
#>
function Get-FGAttributeDisplayName {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string]$Key)

    $m = Get-FGAttributeExtensionMatch -Key $Key
    if (-not $m.Success) { return $null }
    return $m.Groups[2].Value
}

<#
.SYNOPSIS
    Builds the rawKey -> display-name map to stamp on the System.

.DESCRIPTION
    Only keys that actually get a different name are included, so the map stays
    small and a missing entry unambiguously means "nothing to rename".

    Collision handling is the reason this map exists at all: when two extension
    apps define the same attribute name, both would strip to the same label and
    become indistinguishable in a filter menu. The colliding entries are suffixed
    with the first 8 characters of their owning appId — `employeeID (8ce8d3db)`.
    Storage keys are never touched.

.PARAMETER Keys
    Every `extendedAttributes` key this crawl can produce, in any order.
#>
function New-FGAttributeDisplayNameMap {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string[]]$Keys = @())

    $proposed = @{}
    foreach ($key in $Keys) {
        if ([string]::IsNullOrWhiteSpace($key)) { continue }
        if ($proposed.ContainsKey($key)) { continue }
        $name = Get-FGAttributeDisplayName -Key $key
        if ($null -ne $name) { $proposed[$key] = $name }
    }

    # How many keys want each name — anything above one has to be disambiguated.
    $usage = @{}
    foreach ($name in $proposed.Values) {
        if ($usage.ContainsKey($name)) { $usage[$name]++ } else { $usage[$name] = 1 }
    }

    $map = @{}
    foreach ($key in $proposed.Keys) {
        $name = $proposed[$key]
        if ($usage[$name] -gt 1) {
            $appId = (Get-FGAttributeExtensionMatch -Key $key).Groups[1].Value
            $name = "$name ($($appId.Substring(0, 8)))"
        }
        $map[$key] = $name
    }
    return $map
}

<#
.SYNOPSIS
    Every attribute key a crawl with these custom-attribute lists can produce.

.DESCRIPTION
    The configured user and group custom attributes, plus the `<attr>_OuPath`
    companion Add-FGEntraCalculatedAttributes derives from any DN-shaped value
    (which is why `..._fgGroupDN_OuPath` shows up alongside `..._fgGroupDN`).

    The `_OuPath` companions are included unconditionally rather than by testing
    whether a value is DN-shaped: the map is consulted by key, so an entry for a
    key that never materialises costs nothing, while a missing one would leave a
    real column unlabelled.
#>
function Get-FGEntraLabelCandidateKeys {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [string[]]$CustomUserAttributes = @(),
        [string[]]$CustomGroupAttributes = @()
    )

    $keys = [System.Collections.Generic.List[string]]::new()
    foreach ($attr in (@($CustomUserAttributes) + @($CustomGroupAttributes))) {
        if ([string]::IsNullOrWhiteSpace($attr)) { continue }
        $keys.Add($attr)
        $keys.Add("${attr}_OuPath")
    }
    return $keys.ToArray()
}

<#
.SYNOPSIS
    Stamps the display-name map onto the System record.

.DESCRIPTION
    A delta upsert on the same (systemType, tenantId) key the run registered
    under, so only `extendedAttributes` is touched and every other column keeps
    its value. Skipped entirely when no configured attribute is
    extension-shaped — the overwhelmingly common case, and one that must not
    cost an API call.

    Non-fatal by design: labels are cosmetic, and the API's read-time fallback
    already produces clean names without them. A failure here must never fail an
    otherwise good crawl, so it warns and returns.
#>
function Sync-EntraAttributeDisplayNames {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$TenantId,
        [string[]]$CustomUserAttributes = @(),
        [string[]]$CustomGroupAttributes = @()
    )

    $keys = Get-FGEntraLabelCandidateKeys -CustomUserAttributes $CustomUserAttributes `
                                          -CustomGroupAttributes $CustomGroupAttributes
    $map = New-FGAttributeDisplayNameMap -Keys $keys
    if ($map.Count -eq 0) { return $map }

    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Stamping $($map.Count) attribute display name(s)..." -ForegroundColor Cyan
    try {
        Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
            syncMode = 'delta'
            records  = @(@{
                systemType         = 'EntraID'
                tenantId           = $TenantId
                extendedAttributes = @{ attributeDisplayNames = $map }
            })
        } | Out-Null
        Write-Host "  Display names stamped" -ForegroundColor Green
    }
    catch {
        Write-Host "  Display-name stamping failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    return $map
}
