function Get-FGGroup {
    [alias("Get-Group")]
    [cmdletbinding()]
    Param
    (
        [Alias("GroupName","Name")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$DisplayName,
        [Alias("ObjectId")]
        [Parameter(Mandatory = $false)]
        [ValidateNotNullOrEmpty()]
        [string]$Id,

        [Parameter(Mandatory = $false)]
        [ValidateRange(1, 999)]
        [int]$Top
    )

    If ($DisplayName) {
        $URI = 'https://graph.microsoft.com/beta/groups?$filter=' + "displayName eq '$DisplayName'"
    }
    Elseif ($id) {
        $URI = 'https://graph.microsoft.com/beta/groups?$filter=' + "id eq '$id'"
    }
    Else {
        $URI = 'https://graph.microsoft.com/beta/groups'
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