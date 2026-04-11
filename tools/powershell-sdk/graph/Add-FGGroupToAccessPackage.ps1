function Add-FGGroupToAccessPackage {
    [alias("Add-GroupToAccessPackage")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$AccessPackageID,
        [Parameter(Mandatory = $true)]
        [string]$GroupID,
        [Parameter(Mandatory = $true)]
        [string]$CatalogGroupID
    )

    $Body = @{
        accessPackageResourceRole  = @{
            originId              = ("Member_" + $GroupID)
            displayName           = "Member"
            originSystem          = "AadGroup"
            accessPackageResource = @{
                id           = $CatalogGroupID
                resourceType = "O365 Group"
                originId     = $GroupID
                originSystem = "AadGroup"
            }
        }
        accessPackageResourceScope = @{
            originId     = $GroupID
            originSystem = "AadGroup"
        }
    }
    
    #It takes a little time before a group can be added to a catalog.. so sleep..
    Start-sleep -s 45
    
    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages/$AccessPackageID/accessPackageResourceRoleScopes"
    
    $ReturnValue = Invoke-FGPostRequest -URI $URI -Body $Body
    return $ReturnValue
}