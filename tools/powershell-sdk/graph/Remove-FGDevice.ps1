function Remove-FGDevice {
    [alias("Remove-Device")]
    [cmdletbinding()]
    Param
    (
        [Alias("ObjectId")]
        [Parameter(Mandatory = $true)]
        [string]$Id
    )

    $URI = "https://graph.microsoft.com/beta/devices/$Id"
    $Result = Invoke-FGDeleteRequest -URI $URI
    $Result
}