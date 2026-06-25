function Invoke-FGGetRequestToFile {
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$URI,
        [Parameter(Mandatory = $true)]
        [string]$File
    )

    If (!($Global:AccessToken)) {
        Throw "No Access Token found. Please run Get-AccessToken or Get-AccessTokenInteractive before running this function."
    }

    If ($Global:DebugMode) {
        If ($Global:DebugMode.Contains('G')) {
            Write-Host "++++++++++++++++++++++++++++++++++++++++++++++++ Debug Message ++++++++++++++++++++++++++++++++++++++++++++++++++++++++" -ForegroundColor Blue
            Write-Host "Invoke-FGGetRequest" -ForegroundColor Blue
            Write-Host $URI -ForegroundColor Blue
        }
    }

    [array]$ReturnValue = $null
    $Result = Invoke-FGGetPage -URI $URI -CallerName 'Invoke-FGGetRequestToFile'

    if ($Result.PSobject.Properties.name -match "value") {
        [array]$ReturnValue = $Result.value
    }
    else {
        [array]$ReturnValue = $Result
    }

    ConvertTo-Json -Depth 10 -InputObject ([array]$ReturnValue) | Out-File $File -Force

    While ($Result.'@odata.nextLink') {
        $nextLink = $Result.'@odata.nextLink'
        $Result = Invoke-FGGetPage -URI $nextLink -CallerName 'Invoke-FGGetRequestToFile pagination'

        if ($Result.PSobject.Properties.name -match "value") {
            [array]$ReturnValue = $Result.value
        }
        else {
            [array]$ReturnValue = $Result
        }

        ConvertTo-Json -Depth 10 -InputObject ([array]$ReturnValue) | Out-File $File -Append
    }

    # Multiple JSON arrays appended to the file — merge them into one.
    Merge-FGJsonArrayFile -File $File
}
