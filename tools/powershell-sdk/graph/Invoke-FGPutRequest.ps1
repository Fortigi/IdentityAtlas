function Invoke-FGPutRequest {
    [alias("Invoke-PutRequest")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$URI,
        [Parameter(Mandatory = $true)]
        $Body
    )
    Invoke-FGWriteRequest -Method Put -URI $URI -Body $Body
}
