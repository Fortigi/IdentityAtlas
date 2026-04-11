function Get-FGObject {
    [alias("Get-Object")]
    [cmdletbinding()]
    Param
    (
        [Alias("ObjectId")]
        [Parameter(Mandatory = $true)]
        [string]$Id
    )

    $URI = "https://graph.microsoft.com/beta/directoryObjects/$id"

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
   
}