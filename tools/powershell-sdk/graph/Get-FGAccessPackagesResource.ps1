function Get-FGAccessPackagesResource {
    [alias("Get-AccessPackagesResource")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$AccessPackageID
    )

    #https://docs.microsoft.com/en-us/graph/api/accesspackage-list-accesspackageresourcerolescopes?view=graph-rest-beta&tabs=http
    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages/" + $AccessPackageID + '?$expand=accessPackageResourceRoleScopes($expand=accessPackageResourceRole,accessPackageResourceScope)'

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
}