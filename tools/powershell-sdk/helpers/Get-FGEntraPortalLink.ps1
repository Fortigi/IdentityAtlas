function Get-FGEntraPortalLink {
    <#
    .SYNOPSIS
        Returns the Entra ID admin portal deep link for an object.

    .DESCRIPTION
        Different object types need different blade URLs. The function covers
        the types the Entra crawler currently syncs:

          User             → UserProfileMenuBlade
          Group            → GroupDetailsMenuBlade
          ServicePrincipal → ManagedAppMenuBlade (Enterprise Applications —
                             covers SPs, managed identities, AI agents)
          Application      → ApplicationMenuBlade (App Registrations)

        URLs are the same ones the Identity Atlas UI uses on its detail pages
        so the round-trip experience is consistent: click "Open in Entra ID"
        from either the UI or the exported `Link` attribute and you end up at
        the same blade.

    .PARAMETER Id
        The object's directory id (GUID).

    .PARAMETER AppId
        Application-id GUID. Required for ServicePrincipal and Application —
        the blade needs both ids to route correctly. Ignored for User/Group.

    .PARAMETER Type
        One of: User, Group, ServicePrincipal, Application.

    .OUTPUTS
        [string] — the https URL, or $null for an unknown type.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    Param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [AllowNull()]
        [string]$Id,

        [Parameter(Mandatory = $false)]
        [AllowEmptyString()]
        [AllowNull()]
        [string]$AppId,

        [Parameter(Mandatory = $true)]
        [ValidateSet('User', 'Group', 'ServicePrincipal', 'Application')]
        [string]$Type
    )

    if ([string]::IsNullOrWhiteSpace($Id)) { return $null }
    $eId = [uri]::EscapeDataString($Id)

    switch ($Type) {
        'User' {
            return "https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/$eId"
        }
        'Group' {
            return "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/$eId"
        }
        'ServicePrincipal' {
            $url = "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Overview/objectId/$eId"
            if (-not [string]::IsNullOrWhiteSpace($AppId)) {
                $url += "/appId/$([uri]::EscapeDataString($AppId))"
            }
            return $url
        }
        'Application' {
            if (-not [string]::IsNullOrWhiteSpace($AppId)) {
                $eAppId = [uri]::EscapeDataString($AppId)
                return "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/$eAppId/objectId/$eId"
            }
            # No appId supplied — fall back to the objectId-only form.
            return "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/objectId/$eId"
        }
    }
    return $null
}
