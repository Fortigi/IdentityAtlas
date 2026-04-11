function Get-FGUserManager {
    [alias("Get-UserManager")]
    [cmdletbinding()]
    Param
    (
        [Alias("ObjectId")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$id
    )

    $URI = 'https://graph.microsoft.com/beta/users/'+$id+'/manager'
    
    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue


}