function New-FGServicePrincipalSecret {
    [alias("New-ServicePrincipalSecret")]
    [cmdletbinding()]
    Param
    (
        [Alias("ObjectId","Id")]
        [Parameter(Mandatory = $true)]
        $ServicePrincipalObjectID,
        [Parameter(Mandatory = $false)]
        $SecretDescription
    )

    If (!($SecretDescription)) {
        $SecretDescription = "Created by New-ServicePrincipalSecret.ps1"
    }

    $url = 'https://graph.microsoft.com/beta/servicePrincipals/' + $ServicePrincipalObjectID + '/addPassword'

    $Body = @{
        "passwordCredential" = @{
            "displayName" = $SecretDescription
        }     
    }
    
    $ReturnValue = Invoke-FGPostRequest -URI $url -Body $Body

    return $ReturnValue
}