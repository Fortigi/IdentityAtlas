function Add-FGOuPathField {
    <#
    .SYNOPSIS
        Adds a `<Name>_OuPath` companion field to $Ext when $Value is a
        DN-shaped string, without ever overwriting an existing companion.

    .DESCRIPTION
        Shared per-value step used by Add-FGEntraCalculatedAttributes for
        both DN-enrichment passes (values already in $Ext and top-level
        properties on the raw Graph object). Non-string, non-DN, and
        already-enriched values are skipped; a null OU conversion is skipped.

    .PARAMETER Ext
        The extendedAttributes hashtable being enriched; mutated in place.

    .PARAMETER Name
        The source field name; the companion key is `${Name}_OuPath`.

    .PARAMETER Value
        The candidate value to test and convert.
    #>
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Ext,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $false)]
        $Value
    )

    if (-not ($Value -is [string])) { return }
    if (-not (Test-FGDistinguishedName $Value)) { return }
    $pathKey = "${Name}_OuPath"
    if ($Ext.ContainsKey($pathKey)) { return }
    $ou = Convert-FGDistinguishedNameToOUPath $Value
    if ($ou) { $Ext[$pathKey] = $ou }
}

function Add-FGEntraCalculatedAttributes {
    <#
    .SYNOPSIS
        Enriches an extendedAttributes hashtable with Identity-Atlas-calculated
        fields before the record ships to the ingest API.

    .DESCRIPTION
        Two classes of derived data are added in place:

          1. `Link` — deep link into the Entra admin portal, derived from the
             object's id (+ appId for SPs / Apps). Wired so the value is the
             same URL the Identity Atlas UI would open if the user clicked
             "Open in Entra ID" on the same row.

          2. `<fieldName>_OuPath` — for every string value in $Ext (and every
             top-level string property on $Object) that looks like an LDAP
             Distinguished Name, a companion field is added with the
             forward-slash-separated OU path (root → leaf). Example:
                 onPremisesDistinguishedName         = "CN=100001,OU=Users,OU=Accounts,OU=Clients,DC=krypton,DC=ad,…"
                 onPremisesDistinguishedName_OuPath  = "Clients\Accounts\Users"

             Every DN-shaped field is converted, not just hard-coded ones —
             tenants have custom extension attributes holding secondary DNs
             (e.g. `fgGroupDN`) and we want them enriched too.

        Nothing is removed; this function only adds. Existing keys are never
        overwritten — if a tenant happens to ship an ext-attribute called
        `Link` already, we don't clobber it.

    .PARAMETER Object
        The raw Graph object (user, group, servicePrincipal, application).
        Needs `id` at minimum; `appId` is consulted for SP/Application.

    .PARAMETER Ext
        The extendedAttributes hashtable the caller is building for ingest.
        Mutated in place AND returned (callers may chain).

    .PARAMETER Type
        One of: User, Group, ServicePrincipal, Application. Drives the
        portal-link blade selection.

    .OUTPUTS
        [hashtable] — the same `$Ext` that was passed in, with calculated
        fields added.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    Param(
        [Parameter(Mandatory = $true)]
        $Object,

        [Parameter(Mandatory = $true)]
        [hashtable]$Ext,

        [Parameter(Mandatory = $true)]
        [ValidateSet('User', 'Group', 'ServicePrincipal', 'Application')]
        [string]$Type
    )

    # ── Portal link ─────────────────────────────────────────────────
    if (-not $Ext.ContainsKey('Link') -and $Object.id) {
        $link = Get-FGEntraPortalLink -Id $Object.id -AppId $Object.appId -Type $Type
        if ($link) { $Ext['Link'] = $link }
    }

    # ── OU path enrichment ──────────────────────────────────────────
    # Pass 1: DN-shaped values already collected in $Ext. Snapshot the key
    # list first so we can add new keys during iteration without tripping
    # "collection was modified".
    foreach ($key in @($Ext.Keys)) {
        Add-FGOuPathField -Ext $Ext -Name $key -Value $Ext[$key]
    }

    # Pass 2: top-level DN-shaped properties on the raw Graph object that
    # the caller didn't explicitly copy into $Ext. onPremisesDistinguishedName
    # is the canonical case — it's fetched by the core $select now but the
    # existing crawler blocks don't always forward it into $Ext.
    if ($Object.PSObject -and $Object.PSObject.Properties) {
        foreach ($prop in $Object.PSObject.Properties) {
            Add-FGOuPathField -Ext $Ext -Name $prop.Name -Value $prop.Value
        }
    }

    return $Ext
}
