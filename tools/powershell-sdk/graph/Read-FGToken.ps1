function Read-FGToken {
    [alias("Read-Token")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        $TokenFile
    )

    if (!(Test-Path $TokenFile)) {
        Throw "TokenFile not found."
    }

    $TokenJsonImport = Get-Content -Path $TokenFile | ConvertFrom-Json

    If ($TokenJsonImport.RefreshToken) {
        $Global:TenantId = $TokenJsonImport.TenantId
        $Global:ClientId = $TokenJsonImport.ClientId
        $Global:RefreshToken = $TokenJsonImport.RefreshToken
        Get-FGAccessTokenWithRefreshToken -ClientId $ClientId -TenantId $TenantId -RefreshToken $RefreshToken
    }
    Else {
        Throw "TokenFile does not contian a refresh token."
    }
}


