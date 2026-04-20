function Test-FGDistinguishedName {
    <#
    .SYNOPSIS
        Returns $true if the supplied string looks like an LDAP Distinguished
        Name.

    .DESCRIPTION
        Deliberately strict: we only say yes when the value starts with a
        well-known RDN prefix (CN / OU / DC / UID / O) AND contains at least
        two such prefixes separated by commas. That filters out plain emails,
        free text that happens to contain "OU=Finance", and single-field
        pseudo-DNs like "CN=admin" that carry no hierarchical information.

        The positive rate matters because
        Add-FGEntraCalculatedAttributes scans every string value on every
        synced object and a false positive pollutes extendedAttributes with
        an `_OuPath` field derived from non-LDAP text.

    .PARAMETER Value
        String to test. Non-strings / empty / whitespace-only → $false.

    .OUTPUTS
        [bool]
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    Param(
        [Parameter(Mandatory = $false, Position = 0, ValueFromPipeline = $true)]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value))    { return $false }
    if ($Value -notmatch '^(?i)(CN|OU|DC|UID|O)=') { return $false }
    if (-not $Value.Contains(','))                { return $false }

    # Simple comma-split is good enough — escaped commas (`\,`) in RDN values
    # are legal per RFC 4514 but vanishingly rare in Entra / on-prem AD data,
    # and splitting them precisely isn't worth the implementation effort for
    # a boolean check. Worst case: a sentence with a comma gets a +1 false
    # positive if its first clause happens to start with "CN=...".
    $parts = $Value -split ',' | ForEach-Object { $_.Trim() }
    $prefixed = $parts | Where-Object { $_ -match '^(?i)(CN|OU|DC|UID|O)=' }
    return $prefixed.Count -ge 2
}
