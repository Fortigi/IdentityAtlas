function Confirm-FGCatalog {
    [alias("Confirm-Catalog")]
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

    [array]$Catalogs = Get-FGCatalog
    [array]$Catalog = $Catalogs | Where-object { $_.displayName -eq $CatalogName }
    if ($Catalog.count -eq 1) {
        Write-Host "Confirmed Catalog: $CatalogName exists" -ForegroundColor Green
    }
    elseif ($Catalog.count -gt 1) {
        throw "More than one catalog found for CatalogName: $CatalogName"
    }
    else {
        Write-Host "Adding catalog: $CatalogName" -ForegroundColor Yellow
        New-FGCatalog -CatalogName $CatalogName -Description $Description -IsExternallyVisible $IsExternallyVisible
    }

    [array]$Catalogs = Get-FGCatalog
    [array]$Catalog = $Catalogs | Where-object { $_.displayName -eq $CatalogName }

    Return $Catalog
}