function Get-FGAccessTokenManagedIdentity {
    <#
    .SYNOPSIS
        Retrieves a Microsoft Graph access token using an Azure managed identity.

    .DESCRIPTION
        Asks the identity endpoint the Azure platform injects into App Service and
        Container Apps containers (IDENTITY_ENDPOINT + IDENTITY_HEADER) for a token.
        There is no secret involved: the platform only hands a token to code running
        inside the container the identity is attached to.

        A managed identity can only be used for the tenant it lives in.

    .PARAMETER ClientId
        Client ID of the user-assigned managed identity to use. Required when the
        container has more than one identity attached. Omit for a system-assigned identity.

    .PARAMETER Resource
        The resource to authenticate to. Default: "https://graph.microsoft.com/"

    .EXAMPLE
        Get-FGAccessTokenManagedIdentity -ClientId "11111111-2222-3333-4444-555555555555"

    .NOTES
        Sets the following global variables:
        - $Global:AccessToken             - The access token
        - $Global:TenantId                - The tenant the identity lives in (from the token)
        - $Global:ClientId                - The identity's application (client) ID (from the token)
        - $Global:ManagedIdentity         - $true, so an expired token is renewed the same way
        - $Global:ManagedIdentityClientId - The -ClientId that was asked for
        and clears $Global:ClientSecret / $Global:RefreshToken.
    #>
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $false)]
        [System.String]$ClientId,

        [Parameter(Mandatory = $false)]
        $Resource = "https://graph.microsoft.com/"
    )

    $Endpoint = $env:IDENTITY_ENDPOINT
    $IdentityHeader = $env:IDENTITY_HEADER
    if ([string]::IsNullOrWhiteSpace($Endpoint) -or [string]::IsNullOrWhiteSpace($IdentityHeader)) {
        throw "No managed identity is available to this process (IDENTITY_ENDPOINT / IDENTITY_HEADER are not set). Managed identity sign-in works in Azure App Service and Azure Container Apps with an identity attached."
    }

    $Query = "resource=$([uri]::EscapeDataString(([string]$Resource).TrimEnd('/')))&api-version=2019-08-01"
    if (-not [string]::IsNullOrWhiteSpace($ClientId)) {
        $Query += "&client_id=$([uri]::EscapeDataString($ClientId))"
    }

    $Separator = '?'
    if ($Endpoint.Contains('?')) {
        $Separator = '&'
    }

    $TokenRequest = Invoke-RestMethod -Method Get -Uri "$Endpoint$Separator$Query" -Headers @{ 'X-IDENTITY-HEADER' = $IdentityHeader }

    $AccessToken = $TokenRequest.access_token
    if (-not $AccessToken) {
        throw "Error retrieving a managed identity access token. Check that the identity is attached to this container and has been granted the Microsoft Graph application permissions."
    }

    $global:AccessToken = $AccessToken
    $global:ManagedIdentity = $true
    $global:ManagedIdentityClientId = $ClientId
    $global:ClientSecret = $null
    $global:RefreshToken = $null

    # The tenant and the client ID are whatever the platform issued the token for.
    $TokenDetail = Get-FGAccessTokenDetail
    $global:TenantId = $TokenDetail['tid']
    $global:ClientId = $TokenDetail['appid']
    if (-not $global:ClientId) {
        $global:ClientId = $TokenDetail['azp']
    }
}
