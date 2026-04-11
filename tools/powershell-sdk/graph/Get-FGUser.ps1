function Get-FGUser {
    [alias("Get-User")]
    [cmdletbinding()]
    Param
    (
        #UPN or userPrincipalName can be specified.. not required. but if specified it must have a value.
        [Alias("UPN")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$userPrincipalName,
        
        [Alias("ObjectId")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$id,
                
        [Parameter(Mandatory = $false)]
        [ValidateSet('Member', 'Guest')]
        [string]$UserType,

        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [bool]$IncludeManager,
        
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [bool]$IncludeExtensions,

        [Parameter(Mandatory = $false)]
        [ValidateRange(1, 999)]
        [int]$Top
    )

    $URI = 'https://graph.microsoft.com/beta/users'

    If ($userPrincipalName) {
        $URI = $URI + '?$filter=' + "userPrincipalName eq '$userPrincipalName'"
    }
    
    If ($id) {
        if ($URI.Contains('?$filter=')) {
            $URI = $URI + " and id eq '$id'"
        } 
        else {
            $URI = $URI + '?$filter=' + "id eq '$id'"
        }
    }

    If ($UserType) {
        if ($URI.Contains('?$filter=')) {
            $URI = $URI + " and userType eq '$UserType'"
        }
        else {
            $URI = $URI + '?$filter=' + "userType eq '$UserType'"
        }
    }

    If ($includeManager) {
        if ($URI.Contains("?")) {
            $URI = $URI + '&$expand=manager'
        }
        else {
            $URI = $URI + '?$expand=manager'
        }
    }

    If ($IncludeExtensions) {
        if ($URI.Contains("?")) {
            $URI = $URI + '&$expand=extensions'
        }
        else {
            $URI = $URI + '?$expand=extensions'
        }
    }

    If ($Top) {
        if ($URI.Contains("?")) {
            $URI = $URI + "&`$top=$Top"
        }
        else {
            $URI = $URI + "?`$top=$Top"
        }
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue


}