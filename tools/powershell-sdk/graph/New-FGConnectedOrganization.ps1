function New-FGConnectedOrganization {
    [alias("New-ConnectedOrganization")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$DisplayName,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(Mandatory = $true)]
        [string]$DomainName

    )

    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/connectedOrganizations/"
    $Body = @{
        displayName     = $displayName
        description     = $Description
        identitySources = @(
            @{
                "@odata.type" = "#microsoft.graph.domainIdentitySource"
                domainName    = $DomainName
                displayName   = $DomainName
            }    
        )
        state           = "configured"
    }

    $ReturnValue = Invoke-FGPostRequest -URI $URI -Body $Body
    return $ReturnValue
}