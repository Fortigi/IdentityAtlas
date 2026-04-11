function Get-FGServicePrincipal {
    [alias("Get-ServicePrincipal")]
    [cmdletbinding()]
    Param
    (
        #Name or ObjectId can be specified.. not required. but if specified it must have a value.
        [Alias("ApplicationName", "Name")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$DisplayName,

        [Alias("ObjectId")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$id
    )

    If ($DisplayName) {
        $URI = 'https://graph.microsoft.com/beta/servicePrincipals?$filter=' + "displayName eq '$DisplayName'"
    }
    Elseif ($id) {
        $URI = 'https://graph.microsoft.com/beta/servicePrincipals?$filter=' + "id eq '$id'"
    }
    Else {
        $URI = 'https://graph.microsoft.com/beta/servicePrincipals'
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue

}