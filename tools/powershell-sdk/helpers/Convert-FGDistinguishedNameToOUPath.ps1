function Convert-FGDistinguishedNameToOUPath {
    <#
    .SYNOPSIS
        Converts an LDAP Distinguished Name to a forward-slash-separated OU
        path in root → leaf order.

    .DESCRIPTION
        Example:
            Input:  CN=204374,OU=Users,OU=Accounts,OU=Clients,DC=fujitsu,DC=ad,DC=portofrotterdam,DC=com
            Output: Clients\Accounts\Users

        CN / DC / UID components are dropped — only OU segments make it into
        the output. Order is reversed from LDAP's innermost-first convention
        so the result reads top-to-bottom from the directory root.

        Returns $null (not empty string) when the DN has no OU components,
        so callers can skip emitting an empty `_OuPath` field.

    .PARAMETER Dn
        The Distinguished Name string. No validation — use Test-FGDistinguishedName
        first if you're not sure.

    .OUTPUTS
        [string] — backslash-separated OU path, or $null.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    Param(
        [Parameter(Mandatory = $false, Position = 0, ValueFromPipeline = $true)]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Dn
    )

    if ([string]::IsNullOrWhiteSpace($Dn)) { return $null }

    $ous = @()
    foreach ($part in ($Dn -split ',')) {
        $trimmed = $part.Trim()
        if ($trimmed -match '^(?i)OU=(.+)$') {
            $ous += $Matches[1]
        }
    }

    if ($ous.Count -eq 0) { return $null }

    # LDAP reads innermost-first (CN is the leaf, outermost OU comes last).
    # We reverse so the output is path-shaped: root → leaf.
    [array]::Reverse($ous)
    return ($ous -join '\')
}
