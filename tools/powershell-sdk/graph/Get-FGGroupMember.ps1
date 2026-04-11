function Get-FGGroupMember {
    [alias("Get-GroupMember")]
    [cmdletbinding()]
    Param
    (
        [Alias("ObjectId")]
        [Parameter(Mandatory = $true)]
        [string]$Id
    )


    $URI = "https://graph.microsoft.com/beta/groups/$Id/members"

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
   
}