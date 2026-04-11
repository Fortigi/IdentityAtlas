function Confirm-FGUser {
    [alias("Confirm-User")]
    [cmdletbinding()]
    Param
    (
        [Alias("UPN")]
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$userPrincipalName
    )

    #Check if user exists only once
    [array]$User = Get-FGUser -UserPrincipalName $userPrincipalName
    if ($User.count -eq 1) {
        Write-Host "Confirmed User exists: $userPrincipalName" -ForegroundColor Green
    }
    elseif ($User.count -gt 1) {
        throw "More than one user found with upn: $userPrincipalName"
    }
    else {
        Write-Host ("User: " + $userPrincipalName + " was not found.") -ForegroundColor Red
    }

    return $User
   
}