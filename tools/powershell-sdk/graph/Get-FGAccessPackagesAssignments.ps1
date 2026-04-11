function Get-FGAccessPackagesAssignments {
    [alias("Get-AccessPackagesAssignments")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$AccessPackageID,
        
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [bool]$DeliveredOnly
    )

    #https://learn.microsoft.com/en-us/graph/api/entitlementmanagement-list-accesspackageassignments?view=graph-rest-beta&tabs=http
    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignments" + '?$expand=accessPackage,target&$filter=accessPackage/id+eq+' + "'" + $AccessPackageID + "'"
    $ReturnValue = Invoke-FGGetRequest -URI $URI

    if ($DeliveredOnly) {
        $ReturnValue = $ReturnValue | Where-Object { $_.assignmentStatus -eq "Delivered" }
    }

    
    return $ReturnValue
}