function Update-FGAccessTokenIfExpired {
    <#
    .SYNOPSIS
    Checks if the current access token is expired and refreshes it if needed.

    .DESCRIPTION
    Validates the current access token and, if expired, refreshes it using
    either the client secret (service principal) or refresh token (interactive).
    This is a shared helper used by all Invoke-FG*Request functions to avoid
    duplicating token refresh logic.

    .PARAMETER DebugFlag
    The debug flag character to check (e.g., 'G' for GET, 'P' for POST/PATCH, 'D' for DELETE).
    If $Global:DebugMode contains this character, debug output will be written.

    .EXAMPLE
    Update-FGAccessTokenIfExpired -DebugFlag 'G'
    #>
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $false)]
        [string]$DebugFlag
    )

    $TokenIsStillValid = Confirm-FGAccessTokenValidity
    if (!($TokenIsStillValid)) {

        If ($Global:DebugMode -and $DebugFlag) {
            If ($Global:DebugMode.Contains($DebugFlag)) {
                Write-Host "Access Token Expired, getting new one" -ForegroundColor Blue
            }
        }

        If ($global:ClientSecret) {
            Get-FGAccessToken -ClientID $Global:ClientID -TenantId $Global:TenantId -ClientSecret $global:ClientSecret
        }
        Elseif ($global:RefreshToken) {
            Get-FGAccessTokenWithRefreshToken -ClientID $Global:ClientID -TenantId $Global:TenantId -RefreshToken $global:RefreshToken
        }
        Else {
            Throw "Access Token expired and no ClientSecret or RefreshToken available for renewal."
        }
    }
}
