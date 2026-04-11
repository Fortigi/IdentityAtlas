function Confirm-FGAccessTokenValidity {
    [alias("Confirm-AccessTokenValidity")]
    [cmdletbinding()]
    Param()
    
    If (!($Global:AccessToken)) {
        Throw "No Access Token found. Please run Get-AccessToken or Get-AccessTokenInteractive before running this function."
    }
    
    $TokenDecoded = Get-FGAccessTokenDetail

    [Int64]$Ctime = $TokenDecoded.exp
    [datetime]$Epoch = '1970-01-01 00:00:00'
    [datetime]$ResultUTC = $epoch.AddSeconds($Ctime)
    [datetime]$NowUTC = (Get-Date).ToUniversalTime()


    If ($ResultUTC -gt $NowUTC) {
        return $true
    }
    else {
        return $false
    }

}