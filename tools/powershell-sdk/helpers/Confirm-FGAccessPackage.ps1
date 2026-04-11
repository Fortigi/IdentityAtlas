function Confirm-FGAccessPackage {
    [alias("Confirm-AccessPackage")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        $Catalog,
        [Parameter(Mandatory = $true)]
        [string]$DisplayName,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )
    
    $CatalogId = $Catalog.id
    $CatalogName = $Catalog.displayName

    [array]$AccessPackages = Get-AccessPackage | Where-object { $_.catalogId -eq $CatalogId }
    [array]$AccessPackage = $AccessPackages | Where-object { $_.displayName -eq $DisplayName }

    if ($AccessPackage.count -eq 1) {
        Write-Host "Confirmed AccessPackage: $DisplayName is in catalog: $CatalogName" -ForegroundColor Green

        If ($AccessPackage.Description -eq $Description) {
            Write-Host ("Confirmed AccessPackage Description: " + $Description) -ForegroundColor Green
        }
        else {
            Write-Host ("Setting AccessPackage Description: " + $Description ) -ForegroundColor Yellow
            $Updates = @{description = $Description }
            Set-FGAccessPackage -ObjectId $AccessPackage.id -Updates $Updates
        }

    }
    elseif ($AccessPackage.count -gt 1) {
        throw "More than one AccessPackage found for AccessPackageName: $DisplayName"
    }
    else {
        Write-Host "Adding AccessPackage: $DisplayName to catalog: $CatalogName" -ForegroundColor Yellow
        New-FGAccessPackage -CatalogId $CatalogId -DisplayName $DisplayName -Description $Description
    }

    [array]$AccessPackages = Get-FGAccessPackage | Where-object { $_.catalogId -eq $CatalogId }
    $AccessPackage = $AccessPackages | Where-object { $_.displayName -eq $DisplayName }

    Return $AccessPackage
}