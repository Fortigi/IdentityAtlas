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

    # ── Internal helpers (private to this function) ──────────────────────────

    # Decrypt a SecureString into plaintext, always zeroing the intermediate BSTR.
    function Convert-FGSecureStringToPlainText {
        param([System.Security.SecureString]$SecureValue)
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
        try {
            return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        }
        finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    # Shape the return value based on -AsSecureString.
    function Format-FGSecureConfigResult {
        param([System.Security.SecureString]$SecureValue, [switch]$AsSecureString)
        if ($AsSecureString) {
            return $SecureValue
        }
        return (Convert-FGSecureStringToPlainText $SecureValue)
    }

    # Walk the dot-notation path, creating missing intermediate objects, and
    # return the parent object that holds the final key.
    function Resolve-FGConfigParent {
        param($Config, [string[]]$Parts)
        $current = $Config
        for ($i = 0; $i -lt $Parts.Count - 1; $i++) {
            $part = $Parts[$i]
            if (-not $current.PSObject.Properties[$part]) {
                $current | Add-Member -NotePropertyName $part -NotePropertyValue ([PSCustomObject]@{})
            }
            $current = $current.$part
        }
        return $current
    }

    # Decrypt a stored blob; on failure warn, drop the stale key and return $null.
    function Get-FGDecryptedConfigSecureString {
        param($Current, [string]$EncryptedKey, [string]$PropertyPath)
        try {
            return $Current.$EncryptedKey | ConvertTo-SecureString
        }
        catch {
            Write-Warning "Failed to decrypt $PropertyPath. It may have been encrypted by a different user."
            Write-Warning "Clearing encrypted value and will prompt for new value."
            $Current.PSObject.Properties.Remove($EncryptedKey)
            return $null
        }
    }

    # Migrate a legacy plaintext value to encrypted storage and return the SecureString.
    function Convert-FGPlaintextConfigToEncrypted {
        param($Config, $Current, [string]$LastKey, [string]$EncryptedKey, [string]$ConfigPath, [string]$PropertyPath)
        $plainValue = $Current.$LastKey
        Write-Host "Migrating $PropertyPath to encrypted storage..." -ForegroundColor Yellow

        $secureString = $plainValue | ConvertTo-SecureString -AsPlainText -Force
        $encrypted = $secureString | ConvertFrom-SecureString

        $Current | Add-Member -NotePropertyName $EncryptedKey -NotePropertyValue $encrypted -Force
        $Current.PSObject.Properties.Remove($LastKey)

        $Config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Force
        Write-Host "  Migrated successfully" -ForegroundColor Green
        return $secureString
    }

    # Prompt until a usable SecureString is entered. Returns $null only when the
    # entry is empty and -AllowEmpty is set (an optional, unset credential).
    function Read-FGPromptedSecureValue {
        param([string]$PromptMessage, [switch]$AllowEmpty)
        do {
            $secureValue = Read-Host $PromptMessage -AsSecureString
            $plainValue = Convert-FGSecureStringToPlainText $secureValue

            if (-not [string]::IsNullOrWhiteSpace($plainValue)) {
                return $secureValue
            }
            if ($AllowEmpty) {
                Write-Host "  No value provided (optional credential)" -ForegroundColor Gray
                return $null
            }
            Write-Host "  Value cannot be empty. Please try again." -ForegroundColor Yellow
        } while ($true)
    }

    # Encrypt and persist a freshly-entered value, removing any leftover plaintext key.
    function Save-FGEncryptedConfigValue {
        param($Config, $Current, [string]$LastKey, [string]$EncryptedKey, [string]$ConfigPath, [System.Security.SecureString]$SecureValue)
        $encrypted = $SecureValue | ConvertFrom-SecureString
        $Current | Add-Member -NotePropertyName $EncryptedKey -NotePropertyValue $encrypted -Force

        if ($Current.PSObject.Properties[$LastKey]) {
            $Current.PSObject.Properties.Remove($LastKey)
        }

        $Config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Force
        Write-Host "  Credential stored securely" -ForegroundColor Green
    }

    # ── Main flow ────────────────────────────────────────────────────────────

    # Load config file
    if (-not (Test-Path $ConfigPath)) {
        throw "Configuration file not found: $ConfigPath"
    }

    $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json

    # Navigate to the parent object that holds the target key
    $pathParts = $PropertyPath -split '\.'
    $lastKey = $pathParts[-1]
    $encryptedKey = "$lastKey`_Encrypted"
    $current = Resolve-FGConfigParent -Config $config -Parts $pathParts

    # 1. Encrypted value present -> decrypt and return
    $hasEncrypted = $current.PSObject.Properties[$encryptedKey] -and
                    -not [string]::IsNullOrWhiteSpace($current.$encryptedKey)
    if ($hasEncrypted) {
        $secureString = Get-FGDecryptedConfigSecureString -Current $current -EncryptedKey $encryptedKey -PropertyPath $PropertyPath
        if ($secureString) {
            return (Format-FGSecureConfigResult -SecureValue $secureString -AsSecureString:$AsSecureString)
        }
    }

    # 2. Plaintext value present -> migrate to encrypted storage and return
    $hasPlaintext = $current.PSObject.Properties[$lastKey] -and
                   -not [string]::IsNullOrWhiteSpace($current.$lastKey)
    if ($hasPlaintext) {
        $secureString = Convert-FGPlaintextConfigToEncrypted -Config $config -Current $current `
            -LastKey $lastKey -EncryptedKey $encryptedKey -ConfigPath $ConfigPath -PropertyPath $PropertyPath
        return (Format-FGSecureConfigResult -SecureValue $secureString -AsSecureString:$AsSecureString)
    }

    # 3. Value not found -> prompt, then encrypt and store
    if (-not $PromptMessage) {
        $PromptMessage = "Enter value for $PropertyPath"
    }

    $secureValue = Read-FGPromptedSecureValue -PromptMessage $PromptMessage -AllowEmpty:$AllowEmpty
    if (-not $secureValue) {
        return $null
    }

    Save-FGEncryptedConfigValue -Config $config -Current $current `
        -LastKey $lastKey -EncryptedKey $encryptedKey -ConfigPath $ConfigPath -SecureValue $secureValue
    return (Format-FGSecureConfigResult -SecureValue $secureValue -AsSecureString:$AsSecureString)
}
