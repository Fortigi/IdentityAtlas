function New-FGAccessPackage {
    [alias("New-AccessPackage")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$CatalogId,
        [Parameter(Mandatory = $true)]
        [string]$DisplayName,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages"

    $Body = @{
        catalogId   = $CatalogId
        displayName = $DisplayName
        description = $Description
    }
    
    $ReturnValue = Invoke-FGPostRequest -URI $URI -Body $Body
    return $ReturnValue
}