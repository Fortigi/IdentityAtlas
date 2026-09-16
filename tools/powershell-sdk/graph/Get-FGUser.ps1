function Add-FGUserFilterClause {
    # Append an OData $filter clause, chaining with "and" when a filter already exists.
    param(
        [string]$URI,
        [string]$Clause
    )

    if ($URI.Contains('?$filter=')) {
        return $URI + " and $Clause"
    }
    return $URI + '?$filter=' + $Clause
}

function Add-FGUserQueryOption {
    # Append a query-string option ($expand / $top), using "&" when a query already exists.
    param(
        [string]$URI,
        [string]$Option
    )

    if ($URI.Contains('?')) {
        return $URI + "&$Option"
    }
    return $URI + "?$Option"
}

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
        $URI = Add-FGUserFilterClause -URI $URI -Clause "userPrincipalName eq '$userPrincipalName'"
    }

    If ($id) {
        $URI = Add-FGUserFilterClause -URI $URI -Clause "id eq '$id'"
    }

    If ($UserType) {
        $URI = Add-FGUserFilterClause -URI $URI -Clause "userType eq '$UserType'"
    }

    If ($includeManager) {
        $URI = Add-FGUserQueryOption -URI $URI -Option '$expand=manager'
    }

    If ($IncludeExtensions) {
        $URI = Add-FGUserQueryOption -URI $URI -Option '$expand=extensions'
    }

    If ($Top) {
        $URI = Add-FGUserQueryOption -URI $URI -Option "`$top=$Top"
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue


}
