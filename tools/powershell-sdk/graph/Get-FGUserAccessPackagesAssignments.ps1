function Get-FGUserAccessPackagesAssignments {
    [alias("Get-UserAccessPackagesAssignments")]
    [cmdletbinding()]
    Param
    (
        [Alias("UserObjectId")]
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$id,
        
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [bool]$DeliveredOnly
    )

    #https://learn.microsoft.com/en-us/graph/api/entitlementmanagement-list-accesspackageassignments?view=graph-rest-beta&tabs=http
    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignments"+'?$expand=accessPackage,target&$filter=target/objectid+eq+'+"'"+$id+"'"
    $ReturnValue = Invoke-FGGetRequest -URI $URI
    
    if ($DeliveredOnly) {
        $ReturnValue = $ReturnValue | Where-Object { $_.assignmentStatus -eq "Delivered" }
    }

    return $ReturnValue
}