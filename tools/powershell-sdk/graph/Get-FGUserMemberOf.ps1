function Get-FGUserMemberOf {
    [alias("Get-UserMemberOf")]
    [cmdletbinding()]
    Param
    (
        #UPN or userPrincipalName can be specified.. not required. but if specified it must have a value.
        [Alias("UPN")]
        [Alias("objectId")]
        [Alias("id")]
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$userPrincipalName
    )

    $URI = "https://graph.microsoft.com/beta/users/$userPrincipalName/memberOf"

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue


}