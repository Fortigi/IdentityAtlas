function Clear-FGSecureConfigValue {
    <#
    .SYNOPSIS
        Clears a stored credential from a JSON configuration file.

    .DESCRIPTION
        Removes both plaintext and encrypted versions of a credential from a JSON configuration file.
        This will cause the next call to Get-FGSecureConfigValue to prompt for the credential again.

        Removes:
        - The plaintext property (if it exists)
        - The encrypted property with _Encrypted suffix (if it exists)

    .PARAMETER ConfigPath
        Path to the JSON configuration file.

    .PARAMETER PropertyPath
        Dot-notation path to the property to clear (e.g., "Azure.AdminUserPassword" or "Graph.ClientSecret").

    .EXAMPLE
        Clear-FGSecureConfigValue -ConfigPath "config.json" -PropertyPath "Azure.AdminUserPassword"
        Clears the SQL admin password from the config file.

    .EXAMPLE
        Clear-FGSecureConfigValue -ConfigPath "config.json" -PropertyPath "Graph.ClientSecret"
        Clears the Graph client secret from the config file.

    .NOTES
        This function modifies the configuration file immediately.
        The next call to Get-FGSecureConfigValue will prompt for the credential.
    #>

    [alias("Clear-SecureConfigValue")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,

        [Parameter(Mandatory = $true)]
        [string]$PropertyPath
    )

    # Load config file
    if (-not (Test-Path $ConfigPath)) {
        Write-Warning "Configuration file not found: $ConfigPath"
        return
    }

    $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json

    # Navigate to the property using dot notation
    $pathParts = $PropertyPath -split '\.'
    $current = $config
    $lastKey = $pathParts[-1]

    # Navigate to parent object
    for ($i = 0; $i -lt $pathParts.Count - 1; $i++) {
        $part = $pathParts[$i]
        if (-not $current.PSObject.Properties[$part]) {
            Write-Warning "Property path not found: $PropertyPath"
            return
        }
        $current = $current.$part
    }

    # Track if anything was removed
    $removed = $false

    # Remove plaintext value
    if ($current.PSObject.Properties[$lastKey]) {
        $current.PSObject.Properties.Remove($lastKey)
        $removed = $true
    }

    # Remove encrypted value
    $encryptedKey = "$lastKey`_Encrypted"
    if ($current.PSObject.Properties[$encryptedKey]) {
        $current.PSObject.Properties.Remove($encryptedKey)
        $removed = $true
    }

    if ($removed) {
        # Save config
        $config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Force
        Write-Verbose "Cleared $PropertyPath from configuration"
    } else {
        Write-Verbose "No stored value found for $PropertyPath"
    }
}
