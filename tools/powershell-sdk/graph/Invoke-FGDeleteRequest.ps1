function Invoke-FGDeleteRequest {
    [alias("Invoke-DeleteRequest")]
    [cmdletbinding()]
    
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$URI
    )

    If (!($Global:AccessToken)) {
        Throw "No Access Token found. Please run Get-AccessToken or Get-AccessTokenInteractive before running this function."
    }
    Else {
        $AccessToken = $Global:AccessToken
    }

    If ($Global:DebugMode) {
        If ($Global:DebugMode.Contains('D')) {
            Write-Host "++++++++++++++++++++++++++++++++++++++++++++++++ Debug Message ++++++++++++++++++++++++++++++++++++++++++++++++++++++++" -ForegroundColor Blue
            Write-Host "Invoke-FGDeleteRequest" -ForegroundColor Blue
            Write-Host $URI -ForegroundColor Blue
        }
    }

    #Check if Access token is expired, if so get new one.
    Update-FGAccessTokenIfExpired -DebugFlag 'D'

    Try {
        #Run request
        $Result = Invoke-RestMethod -Method DELETE -Uri $URI -Headers @{"Authorization" = "Bearer $AccessToken" }
    }
    Catch {
        Throw $_

    }
    
    if ($Result.PSobject.Properties.name -match "value") {
        $ReturnValue = $Result.value
    }
    else {
        $ReturnValue = $Result
    }

    return $ReturnValue
}