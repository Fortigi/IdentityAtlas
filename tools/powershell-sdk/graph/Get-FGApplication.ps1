function Get-FGApplication {
    [alias("Get-Application")]
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
        $URI = 'https://graph.microsoft.com/beta/applications?$filter=' + "displayName eq '$DisplayName'"
    }
    Elseif ($id) {
        $URI = 'https://graph.microsoft.com/beta/applications?$filter=' + "id eq '$id'"
    }
    Else {
        $URI = 'https://graph.microsoft.com/beta/applications'
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue

}