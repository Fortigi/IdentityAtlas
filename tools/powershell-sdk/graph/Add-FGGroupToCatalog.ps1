function Add-FGGroupToCatalog {
    [alias("Add-GroupToCatalog")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$CatalogId,
        [Parameter(Mandatory = $true)]
        [string]$GroupName
    )

    $GroupObject = Get-Group -GroupName $GroupName

    $Body = @{
        catalogId             = $CatalogId
        requestType           = "AdminAdd"
        accessPackageResource = @{
            originId     = $GroupObject.id
            originSystem = "AadGroup"         
        }
    }

    #It takes a little time before a group can be added to a catalog.. so sleep..
    Start-sleep -s 45
    
    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageResourceRequests"
    
    $ReturnValue = Invoke-FGPostRequest -URI $URI -Body $Body
    return $ReturnValue
}