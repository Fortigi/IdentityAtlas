function New-FGAccessPackagePolicy {
    [alias("New-AccessPackagePolicy")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        $Policy
    )

    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignmentPolicies"
    $Body = $Policy 

    $ReturnValue = Invoke-FGPostRequest -URI $URI -Body $Body
    return $ReturnValue
}