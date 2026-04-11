function Invoke-FGPatchRequest {
    [alias("Invoke-PatchRequest")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$URI,
        [Parameter(Mandatory = $true)]
        $Body
    )

    If (!($Global:AccessToken)) {
        Throw "No Access Token found. Please run Get-AccessToken or Get-AccessTokenInteractive before running this function."
    }
    Else {
        $AccessToken = $Global:AccessToken
    }

    $Body = $Body | ConvertTo-Json -Depth 10
    $Body = [System.Text.Encoding]::UTF8.GetBytes($body)

    If ($Global:DebugMode) {
        If ($Global:DebugMode.Contains('P')) {
            Write-Host "++++++++++++++++++++++++++++++++++++++++++++++++ Debug Message ++++++++++++++++++++++++++++++++++++++++++++++++++++++++" -ForegroundColor Blue
            Write-Host "Invoke-FGPatchRequest" -ForegroundColor Blue
            Write-Host $URI -ForegroundColor Blue
            Write-Host $Body -ForegroundColor Blue
        }
    }
    
    #Check if Access token is expired, if so get new one.
    Update-FGAccessTokenIfExpired -DebugFlag 'P'

    Try {
        #Run request
        $Result = Invoke-RestMethod -Method PATCH -Uri $URI -Headers @{"Authorization" = "Bearer $AccessToken" } -Body $Body -ContentType "application/json; charset=utf-8"
    }
    Catch {
        Throw $_
       
    }

    if ($Result.PSobject.Properties.name -match "value") {
        $ReturnValue = $Result.value
    }
    else {
        $ReturnValue = $Result
    }

    return $ReturnValue
}