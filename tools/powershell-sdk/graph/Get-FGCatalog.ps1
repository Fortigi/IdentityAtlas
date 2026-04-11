function Get-FGCatalog {
    [alias("Get-Catalog")]
    [cmdletbinding()]
    Param
    (
        #UPN or userPrincipalName can be specified.. not required. but if specified it must have a value.
        [Alias("Name")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$DisplayName,
        
        [Alias("ObjectId")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$id
    )

    $BaseURI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs"

    If ($DisplayName) {
        $URI = $BaseURI + '?$filter=' + "displayName eq '$DisplayName'"
    }
    Elseif ($id) {
        $URI = $BaseURI + '?$filter=' + "id eq '$id'"
    }
    Else {
        $URI = $BaseURI
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
   
}