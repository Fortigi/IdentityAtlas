function Confirm-FGGroupInCatalog {
    [alias("Confirm-GroupInCatalog")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        $Catalog,
        [Parameter(Mandatory = $true)]
        $GroupName
    )

    $CatalogId = $Catalog.id

    [array]$CatalogGroups = Get-FGCatalogGroup -CatalogId $CatalogId
    [array]$CatalogGroup = $CatalogGroups | Where-Object { $_.displayName -eq $GroupName }

    $CatalogName = $Catalog.displayName

    if ($CatalogGroup.count -eq 1) {
        Write-Host "Confirmed GroupInCatalog: $GroupName is in catalog: $CatalogName" -ForegroundColor Green
    }
    elseif ($CatalogGroup.count -gt 1) {
        throw "More than one group found for group: $GroupName"
    }
    else {
        Write-Host "Adding GroupInCatalog: $GroupName to catalog: $CatalogName" -ForegroundColor Yellow
        Add-FGGroupToCatalog -CatalogId $CatalogId -GroupName $GroupName
    }

    [array]$CatalogGroups = Get-FGCatalogGroup -CatalogId $CatalogId
    $CatalogGroup = $CatalogGroups | Where-Object { $_.displayName -eq $GroupName }

    return $CatalogGroup
}