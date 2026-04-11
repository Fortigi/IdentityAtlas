function Set-FGDevice {
    [alias("Set-Device")]
    [cmdletbinding()]
    Param
    (
        [Alias("Id")]
        [Parameter(Mandatory = $true)]
        [string]$DeviceId,
        [Parameter(Mandatory = $true)]
        $Updates
    )

    $URI = "https://graph.microsoft.com/beta/devices/$DeviceId"
    $Body = $Updates 

    $ReturnValue = Invoke-FGPatchRequest -URI $URI -Body $Body
    return $ReturnValue
}