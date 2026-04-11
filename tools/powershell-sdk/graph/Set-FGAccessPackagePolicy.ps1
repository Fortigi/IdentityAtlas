function Set-FGAccessPackagePolicy {
    [alias("Set-AccessPackagePolicy")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        $Policy,
        [Parameter(Mandatory = $true)]
        $PolicyID
    )

    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageAssignmentPolicies/$PolicyID"
    $Body = $Policy 

    $ReturnValue = Invoke-FGPutRequest -URI $URI -Body $Body
    return $ReturnValue
}