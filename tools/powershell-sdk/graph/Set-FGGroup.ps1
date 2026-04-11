function Set-FGGroup {
    [alias("Set-Group")]
    [cmdletbinding()]
    Param
    (
        [Alias("GroupID", "Id")]
        [Parameter(Mandatory = $true)]
        [string]$ObjectId,
        [Parameter(Mandatory = $false)]
        $Description,
        [Parameter(Mandatory = $false)]
        $Displayname
    )

    $URI = "https://graph.microsoft.com/beta/groups/$ObjectId"
    $Body = @{}

    if(PSBoundParameters.ContainsKey('Description')){
        $Body.Add("Description", $Description)
    }
    if(PSBoundParameters.ContainsKey('Displayname')){
        $Body.Add("Displayname", $Displayname)
    }

    $ReturnValue = Invoke-FGPatchRequest -URI $URI -Body $Body
    return $ReturnValue
}