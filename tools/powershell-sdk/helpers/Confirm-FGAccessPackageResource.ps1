function Confirm-FGAccessPackageResource {
    [alias("Confirm-AccessPackageResource")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        $AccessPackage,
        [Parameter(Mandatory = $true)]
        $Group,
        [Parameter(Mandatory = $true)]
        $CatalogGroup
    )

    $GroupDisplayName = $Group.displayName
    $AccessPackageName = $AccessPackage.displayName

    $AccessPackageResourceRoles = Get-FGAccessPackagesResource -AccessPackageID $AccessPackage.id
    If ($AccessPackageResourceRoles.accessPackageResourceRoleScopes.accessPackageResourceScope.originId -eq $Group.id) {
        Write-Host "Confirmed AccessPackageResource Group: $GroupDisplayName is linked to $AccessPackageName" -ForegroundColor Green
    }
    Else {
        Write-Host "Adding AccessPackageResource Group: $GroupDisplayName to Access Package: $AccessPackageName" -ForegroundColor Yellow
        AddFGGroupToAccessPackage -AccessPackageID $AccessPackage.id -GroupId $Group.id -CatalogGroupID $CatalogGroup.id
    }

    $Result = Get-FGAccessPackagesResource -AccessPackageID $AccessPackage.id
    return $Result
}