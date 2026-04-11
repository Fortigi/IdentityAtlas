function Get-FGDevice {
    [alias("Get-Device")]
    [cmdletbinding()]
    Param (
        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [int]$DaysThreshold,
        [Parameter(Mandatory=$false)]
        [ValidateNotNullOrEmpty()]
        [bool]$AccountEnabled=$true
    )

    $URI = 'https://graph.microsoft.com/beta/devices'

    if ($DaysThreshold) {
        $Date = (Get-Date).AddDays($DaysThreshold)
        $Date = (Get-Date $Date -Uformat "%Y-%m-%dT%H:%M:%SZ")
        $URI = $URI + '?$filter=approximateLastSignInDateTime le ' + $($Date)
    }

    if (!$AccountEnabled) {
        if ($URI.Contains('?$filter=')) {
            $URI = $URI + " and accountEnabled eq false"
        } else {
            $URI = $URI + "?$filter=accountEnabled eq false"
        }
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
}