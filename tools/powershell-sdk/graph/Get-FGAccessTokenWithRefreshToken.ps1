function Get-FGAccessTokenWithRefreshToken {
    [alias("Get-AccessTokenWithRefreshToken")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [System.String]$ClientId,       
        [Parameter(Mandatory = $true)]
        [System.String]$TenantId,       
        [Parameter(Mandatory = $true)]
        [System.String]$RefreshToken,
        [Parameter()]
        $Resource = "https://graph.microsoft.com/"              
    )
    
    $Body = @{
        client_id     = $ClientId
        grant_type    = "refresh_token"
        refresh_token = $RefreshToken
        resource      = $Resource
    }
    $URI = "https://login.microsoftonline.com/$TenantId/oauth2/token"
    $TokenRequest = Invoke-RestMethod -Method Post -Uri $URI -Body $Body
   

    $AccessToken = $TokenRequest.access_token
    If ($AccessToken) {        
        $global:AccessToken = $TokenRequest.access_token
        $global:RefreshToken = $TokenRequest.refresh_token
        $global:ClientId = $ClientId
        $global:TenantId = $TenantId
    }
    If (!$AccessToken) { 
        Throw "Error retrieving Graph Access Token. Please validate parameter input and check API permissions of the (App Registration) client in AzureAD" 
    }
}