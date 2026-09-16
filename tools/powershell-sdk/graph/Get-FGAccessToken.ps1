function Get-FGAccessToken {
    <#
    .SYNOPSIS
        Retrieves a Microsoft Graph access token using service principal credentials.

    .DESCRIPTION
        Authenticates to Microsoft Graph using client credentials flow (service principal).
        Supports either explicit credential parameters or reading from a JSON configuration file.

        When using -ConfigFile:
        - TenantId is read from Graph.TenantId
        - ClientId is read from Graph.ClientId
        - ClientSecret is read from Graph.ClientSecret (with DPAPI encryption support)

    .PARAMETER ClientId
        Azure AD application (client) ID. Mandatory unless using -ConfigFile.

    .PARAMETER ClientSecret
        Azure AD application client secret. Mandatory unless using -ConfigFile.

    .PARAMETER TenantId
        Azure AD tenant ID. Mandatory unless using -ConfigFile.

    .PARAMETER Resource
        The resource to authenticate to. Default: "https://graph.microsoft.com/"

    .PARAMETER ConfigFile
        Path to a JSON configuration file containing credentials.
        If specified, ClientId, ClientSecret, and TenantId are read from the config file.

    .EXAMPLE
        Get-FGAccessToken -ClientId "..." -ClientSecret "..." -TenantId "..."
        Authenticates using explicit credentials.

    .EXAMPLE
        Get-FGAccessToken -ConfigFile "config.json"
        Authenticates using credentials from config file.

    .EXAMPLE
        Get-FGAccessToken -ConfigFile "config.json" -Resource "https://management.azure.com/"
        Authenticates to Azure Resource Manager using config file credentials.

    .NOTES
        Sets the following global variables:
        - $Global:AccessToken - The access token
        - $Global:ClientId - The client ID
        - $Global:ClientSecret - The client secret
        - $Global:TenantId - The tenant ID
    #>

    [alias("Get-AccessToken")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $false, ParameterSetName = "Explicit")]
        [System.String]$ClientId,

        [Parameter(Mandatory = $false, ParameterSetName = "Explicit")]
        [System.String]$ClientSecret,

        [Parameter(Mandatory = $false, ParameterSetName = "Explicit")]
        [System.String]$TenantId,

        [Parameter(Mandatory = $false, ParameterSetName = "ConfigFile")]
        [System.String]$ConfigFile,

        [Parameter(Mandatory = $false)]
        $Resource = "https://graph.microsoft.com/"
    )

    # Read + validate credentials from a JSON config file. Returns the resolved
    # tenant/client/secret; throws (matching the original messages) on any gap.
    function Get-FGTokenConfigCredential {
        param([System.String]$ConfigFile)

        if (-not (Test-Path $ConfigFile)) {
            throw "Configuration file not found: $ConfigFile"
        }

        $config = Get-Content -Path $ConfigFile -Raw | ConvertFrom-Json

        if (-not $config.Graph.TenantId) {
            throw "Graph.TenantId not found in configuration file"
        }
        if (-not $config.Graph.ClientId) {
            throw "Graph.ClientId not found in configuration file"
        }

        # ClientSecret (with encryption support)
        $secret = Get-FGSecureConfigValue -ConfigPath $ConfigFile -PropertyPath "Graph.ClientSecret" -AllowEmpty
        if ([string]::IsNullOrWhiteSpace($secret)) {
            Write-Warning "No ClientSecret configured. You may need to use Get-FGAccessTokenInteractive instead."
            throw "Graph.ClientSecret not available in configuration file"
        }

        [pscustomobject]@{
            TenantId     = $config.Graph.TenantId
            ClientId     = $config.Graph.ClientId
            ClientSecret = $secret
        }
    }

    # Validate the explicit credential parameters; throws on the first missing one.
    function Confirm-FGTokenExplicitCredential {
        param([System.String]$ClientId, [System.String]$ClientSecret, [System.String]$TenantId)

        if ([string]::IsNullOrWhiteSpace($ClientId)) {
            throw "ClientId is required when not using -ConfigFile"
        }
        if ([string]::IsNullOrWhiteSpace($ClientSecret)) {
            throw "ClientSecret is required when not using -ConfigFile"
        }
        if ([string]::IsNullOrWhiteSpace($TenantId)) {
            throw "TenantId is required when not using -ConfigFile"
        }
    }

    # If ConfigFile is specified, read credentials from config
    if ($PSCmdlet.ParameterSetName -eq "ConfigFile") {
        $cred = Get-FGTokenConfigCredential -ConfigFile $ConfigFile
        $TenantId = $cred.TenantId
        $ClientId = $cred.ClientId
        $ClientSecret = $cred.ClientSecret
    }
    elseif ($PSCmdlet.ParameterSetName -eq "Explicit") {
        Confirm-FGTokenExplicitCredential -ClientId $ClientId -ClientSecret $ClientSecret -TenantId $TenantId
    }

    $Body = @{
        client_id     = $ClientID
        client_secret = $ClientSecret
        grant_type    = "client_credentials"
        resource      = $Resource
    }
    $URI = "https://login.microsoftonline.com/$TenantId/oauth2/token"
    $TokenRequest = Invoke-RestMethod -Method Post -Uri $URI -Body $Body

    $AccessToken = $TokenRequest.access_token
    if ($AccessToken) {
        $global:AccessToken = $AccessToken
        $global:ClientId = $ClientId
        $global:ClientSecret = $ClientSecret
        $global:TenantId = $TenantId
    }
    else {
        throw "Error retrieving Graph Access Token. Please validate parameter input for -ClientID, -ClientSecret and -TenantId and check API permissions of the (App Registration) client in AzureAD"
    }
} 