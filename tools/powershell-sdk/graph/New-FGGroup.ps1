function New-FGGroup {
    [alias("New-Group")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$DisplayName,
        [Parameter(Mandatory = $false)]
        [string]$Description = "",
        [Parameter(Mandatory = $false)]
        [bool] $mailEnabled = $false,

        [Parameter(Mandatory = $false)]
        [string]$mailNickname = $DisplayName.Replace(" ", "").ToLower(),
        [Parameter(Mandatory = $false)]
        [bool]$SecurityEnabled = $true

    )

    $URI = "https://graph.microsoft.com/beta/groups"
    $Body = @{
        displayName     = $DisplayName
        description     = $Description
        groupTypes      = @()
        mailEnabled     = $mailEnabled
        mailNickname    = $mailNickname
        securityEnabled = $SecurityEnabled
    }

    $ReturnValue = Invoke-FGPostRequest -URI $URI -Body $Body
    return $ReturnValue
}