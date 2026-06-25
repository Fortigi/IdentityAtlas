function Invoke-FGWriteRequest {
    # Private helper: shared body serialisation, debug logging, token refresh, and
    # REST call for Invoke-FGPostRequest and Invoke-FGPutRequest. Both functions are
    # identical except for the HTTP method — this helper takes it as a parameter.
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Post', 'Put', 'Patch', 'Delete')]
        [string]$Method,
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

    If ($Global:DebugMode) {
        If ($Global:DebugMode.Contains('P')) {
            Write-Host "++++++++++++++++++++++++++++++++++++++++++++++++ Debug Message ++++++++++++++++++++++++++++++++++++++++++++++++++++++++" -ForegroundColor Blue
            Write-Host "Invoke-FG${Method}Request" -ForegroundColor Blue
            Write-Host $URI -ForegroundColor Blue
            Write-Host $Body -ForegroundColor Blue
        }
    }

    Update-FGAccessTokenIfExpired -DebugFlag 'P'

    Try {
        $Result = Invoke-RestMethod -Method $Method -Uri $URI -Headers @{"Authorization" = "Bearer $AccessToken" } -Body $Body -ContentType "application/json"
    }
    Catch {
        Throw $_
    }

    if ($Result.PSobject.Properties.name -match "value") {
        return $Result.value
    }
    return $Result
}
