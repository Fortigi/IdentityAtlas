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
                 onPremisesDistinguishedName         = "CN=204374,OU=Users,OU=Accounts,OU=Clients,DC=fujitsu,DC=ad,…"
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
    $extKeys = @($Ext.Keys)
    foreach ($key in $extKeys) {
        $v = $Ext[$key]
        if (-not ($v -is [string])) { continue }
        if (-not (Test-FGDistinguishedName $v)) { continue }
        $pathKey = "${key}_OuPath"
        if ($Ext.ContainsKey($pathKey)) { continue }
        $ou = Convert-FGDistinguishedNameToOUPath $v
        if ($ou) { $Ext[$pathKey] = $ou }
    }

    # Pass 2: top-level DN-shaped properties on the raw Graph object that
    # the caller didn't explicitly copy into $Ext. onPremisesDistinguishedName
    # is the canonical case — it's fetched by the core $select now but the
    # existing crawler blocks don't always forward it into $Ext.
    if ($Object.PSObject -and $Object.PSObject.Properties) {
        foreach ($prop in $Object.PSObject.Properties) {
            $v = $prop.Value
            if (-not ($v -is [string])) { continue }
            if (-not (Test-FGDistinguishedName $v)) { continue }
            $pathKey = "$($prop.Name)_OuPath"
            if ($Ext.ContainsKey($pathKey)) { continue }
            $ou = Convert-FGDistinguishedNameToOUPath $v
            if ($ou) { $Ext[$pathKey] = $ou }
        }
    }

    return $Ext
}
