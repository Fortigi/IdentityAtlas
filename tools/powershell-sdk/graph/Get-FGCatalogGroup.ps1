function Get-FGCatalogGroup {
    [alias("Get-CatalogGroup")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$CatalogId
    )

    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs/$CatalogId/accessPackageResources"

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
}