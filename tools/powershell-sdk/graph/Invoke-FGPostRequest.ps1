function Invoke-FGPostRequest {
    [alias("Invoke-PostRequest")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$URI,
        [Parameter(Mandatory = $true)]
        $Body
    )
    Invoke-FGWriteRequest -Method Post -URI $URI -Body $Body
}
