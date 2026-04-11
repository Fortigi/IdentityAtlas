function Test-FGSecureConfigValue {
    <#
    .SYNOPSIS
        Tests whether a credential is stored in a JSON configuration file.

    .DESCRIPTION
        Checks if a credential exists in a JSON configuration file, either as:
        - An encrypted value (with _Encrypted suffix)
        - A plaintext value (non-empty string)

        Returns $true if the credential exists, $false otherwise.
        Does not decrypt or retrieve the value, only checks for existence.

    .PARAMETER ConfigPath
        Path to the JSON configuration file.

    .PARAMETER PropertyPath
        Dot-notation path to the property to check (e.g., "Azure.AdminUserPassword" or "Graph.ClientSecret").

    .EXAMPLE
        if (Test-FGSecureConfigValue -ConfigPath "config.json" -PropertyPath "Azure.AdminUserPassword") {
            Write-Host "SQL password is configured"
        } else {
            Write-Host "SQL password needs to be set"
        }

    .EXAMPLE
        $hasSecret = Test-FGSecureConfigValue -ConfigPath "config.json" -PropertyPath "Graph.ClientSecret"
        Checks if the Graph client secret is stored.

    .NOTES
        This function does not decrypt values, so it's safe to call without triggering
        user prompts or decryption operations.
    #>

    [alias("Test-SecureConfigAvailable")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,

        [Parameter(Mandatory = $true)]
        [string]$PropertyPath
    )

    # Check if config file exists
    if (-not (Test-Path $ConfigPath)) {
        Write-Verbose "Configuration file not found: $ConfigPath"
        return $false
    }

    try {
        $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        Write-Warning "Failed to parse configuration file: $ConfigPath"
        return $false
    }

    # Navigate to the property using dot notation
    $pathParts = $PropertyPath -split '\.'
    $current = $config
    $lastKey = $pathParts[-1]

    # Navigate to parent object
    for ($i = 0; $i -lt $pathParts.Count - 1; $i++) {
        $part = $pathParts[$i]
        if (-not $current.PSObject.Properties[$part]) {
            Write-Verbose "Property path not found: $PropertyPath"
            return $false
        }
        $current = $current.$part
    }

    # Check for encrypted value
    $encryptedKey = "$lastKey`_Encrypted"
    $hasEncrypted = $current.PSObject.Properties[$encryptedKey] -and
                    -not [string]::IsNullOrWhiteSpace($current.$encryptedKey)

    if ($hasEncrypted) {
        Write-Verbose "Found encrypted value for $PropertyPath"
        return $true
    }

    # Check for plaintext value
    $hasPlaintext = $current.PSObject.Properties[$lastKey] -and
                   -not [string]::IsNullOrWhiteSpace($current.$lastKey)

    if ($hasPlaintext) {
        Write-Verbose "Found plaintext value for $PropertyPath"
        return $true
    }

    Write-Verbose "No value found for $PropertyPath"
    return $false
}
