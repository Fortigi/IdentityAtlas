function Get-FGAccessPackagesPolicy {
    [alias("Get-AccessPackagesPolicy")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $false)]
        [string]$AccessPackageId
    )

    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignmentPolicies"

    If ($AccessPackageId) {
        $URI = $URI + "?`$filter=accessPackageId eq '$AccessPackageId'"
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
}