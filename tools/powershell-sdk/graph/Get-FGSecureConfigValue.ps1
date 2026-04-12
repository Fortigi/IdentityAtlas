function Get-FGSecureConfigValue {
    <#
    .SYNOPSIS
        Gets a configuration value from a JSON config file, with support for encrypted credentials.

    .DESCRIPTION
        Retrieves a configuration value from a JSON file, supporting:
        - Plain text values
        - DPAPI-encrypted credentials (stored with _Encrypted suffix)
        - Automatic prompting for missing credentials
        - Automatic migration from plaintext to encrypted storage
        - Dot-notation property paths (e.g., "Azure.AdminUserPassword")

        If a credential is not stored, prompts the user and encrypts it using Windows DPAPI.
        Encrypted values are user-specific and can only be decrypted by the same user account.

    .PARAMETER ConfigPath
        Path to the JSON configuration file.

    .PARAMETER PropertyPath
        Dot-notation path to the property (e.g., "Azure.AdminUserPassword" or "Graph.ClientSecret").

    .PARAMETER PromptMessage
        Optional custom message to display when prompting for the credential.
        Default: "Enter value for {PropertyPath}"

    .PARAMETER AsSecureString
        If specified, returns the value as a SecureString instead of plain text.

    .PARAMETER AllowEmpty
        If specified, allows empty values for optional credentials.
        Default: Requires non-empty values.

    .EXAMPLE
        $password = Get-FGSecureConfigValue -ConfigPath "config.json" -PropertyPath "Azure.AdminUserPassword"
        Gets the SQL admin password, prompting if not stored.

    .EXAMPLE
        $secret = Get-FGSecureConfigValue -ConfigPath "config.json" -PropertyPath "Graph.ClientSecret" -AllowEmpty
        Gets the client secret, allowing it to be empty (for interactive auth scenarios).

    .EXAMPLE
        $securePassword = Get-FGSecureConfigValue -ConfigPath "config.json" -PropertyPath "Azure.AdminUserPassword" -AsSecureString
        Gets the password as a SecureString object.

    .NOTES
        - Uses Windows DPAPI (Data Protection API) for encryption
        - Encrypted values are user-specific and machine-specific
        - Plaintext values are automatically migrated to encrypted storage
        - Config file is updated with encrypted values automatically
    #>

    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSAvoidUsingConvertToSecureStringWithPlainText', '',
        Justification = 'Migrating existing plaintext config values to DPAPI-encrypted storage requires converting the in-memory string to SecureString')]
    [alias("Get-SecureConfigValue")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,

        [Parameter(Mandatory = $true)]
        [string]$PropertyPath,

        [Parameter(Mandatory = $false)]
        [string]$PromptMessage,

        [Parameter(Mandatory = $false)]
        [switch]$AsSecureString,

        [Parameter(Mandatory = $false)]
        [switch]$AllowEmpty
    )

    # Load config file
    if (-not (Test-Path $ConfigPath)) {
        throw "Configuration file not found: $ConfigPath"
    }

    $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json

    # Navigate to the property using dot notation
    $pathParts = $PropertyPath -split '\.'
    $current = $config
    $parent = $null
    $lastKey = $pathParts[-1]

    # Navigate to parent object
    for ($i = 0; $i -lt $pathParts.Count - 1; $i++) {
        $part = $pathParts[$i]
        if (-not $current.PSObject.Properties[$part]) {
            # Create missing intermediate objects
            $current | Add-Member -NotePropertyName $part -NotePropertyValue ([PSCustomObject]@{})
        }
        $parent = $current
        $current = $current.$part
    }

    # Check for encrypted value first
    $encryptedKey = "$lastKey`_Encrypted"
    $hasEncrypted = $current.PSObject.Properties[$encryptedKey] -and
                    -not [string]::IsNullOrWhiteSpace($current.$encryptedKey)

    if ($hasEncrypted) {
        # Decrypt and return
        try {
            $secureString = $current.$encryptedKey | ConvertTo-SecureString
            if ($AsSecureString) {
                return $secureString
            } else {
                $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureString)
                try {
                    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
                } finally {
                    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
                }
            }
        }
        catch {
            Write-Warning "Failed to decrypt $PropertyPath. It may have been encrypted by a different user."
            Write-Warning "Clearing encrypted value and will prompt for new value."
            $current.PSObject.Properties.Remove($encryptedKey)
        }
    }

    # Check for plaintext value
    $hasPlaintext = $current.PSObject.Properties[$lastKey] -and
                   -not [string]::IsNullOrWhiteSpace($current.$lastKey)

    if ($hasPlaintext) {
        $plainValue = $current.$lastKey

        # Migrate to encrypted storage
        Write-Host "Migrating $PropertyPath to encrypted storage..." -ForegroundColor Yellow

        $secureString = $plainValue | ConvertTo-SecureString -AsPlainText -Force
        $encrypted = $secureString | ConvertFrom-SecureString

        # Store encrypted and remove plaintext
        $current | Add-Member -NotePropertyName $encryptedKey -NotePropertyValue $encrypted -Force
        $current.PSObject.Properties.Remove($lastKey)

        # Save config
        $config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Force
        Write-Host "  Migrated successfully" -ForegroundColor Green

        if ($AsSecureString) {
            return $secureString
        } else {
            return $plainValue
        }
    }

    # Value not found - prompt user
    if (-not $PromptMessage) {
        $PromptMessage = "Enter value for $PropertyPath"
    }

    do {
        $secureValue = Read-Host $PromptMessage -AsSecureString

        # Check if empty
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        try {
            $plainValue = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }

        if ([string]::IsNullOrWhiteSpace($plainValue)) {
            if ($AllowEmpty) {
                Write-Host "  No value provided (optional credential)" -ForegroundColor Gray
                return $null
            } else {
                Write-Host "  Value cannot be empty. Please try again." -ForegroundColor Yellow
                continue
            }
        }

        break
    } while ($true)

    # Encrypt and store
    $encrypted = $secureValue | ConvertFrom-SecureString
    $current | Add-Member -NotePropertyName $encryptedKey -NotePropertyValue $encrypted -Force

    # Ensure plaintext is removed
    if ($current.PSObject.Properties[$lastKey]) {
        $current.PSObject.Properties.Remove($lastKey)
    }

    # Save config
    $config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Force
    Write-Host "  Credential stored securely" -ForegroundColor Green

    if ($AsSecureString) {
        return $secureValue
    } else {
        return $plainValue
    }
}
