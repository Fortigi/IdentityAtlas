function New-FGCatalog {
    [alias("New-Catalog")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$CatalogName,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(Mandatory = $true)]
        [string]$IsExternallyVisible
    )

    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs"

    $Body = @{
        displayName         = $CatalogName
        description         = $description
        isExternallyVisible = $isExternallyVisible
    }

    $ReturnValue = Invoke-FGPostRequest -URI $URI -Body $Body
    return $ReturnValue
   
}