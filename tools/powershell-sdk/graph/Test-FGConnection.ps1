function Test-FGConnection {
    [cmdletbinding()]
    Param()
    If (!($Global:AccessToken)) {
        return $false
    }
    Else {
        return Confirm-FGAccessTokenValidity
    }
}