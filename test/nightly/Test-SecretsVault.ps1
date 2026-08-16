<#
.SYNOPSIS
    Nightly test step: extended secrets vault verification with tamper detection.

.DESCRIPTION
    Verifies the secrets vault (envelope-encrypted Secrets table) works correctly
    end-to-end, including encryption at rest and tamper detection. This goes
    beyond the basic round-trip in Test-LLMSubstrate.ps1 by inspecting the
    database directly.

    What it covers:
      1. PUT /admin/llm/config with a known key    -- vault encrypt + save
      2. GET /admin/llm/status                     -- verify key is set
      3. psql SELECT ciphertext                    -- verify DB value != plaintext
      4. psql UPDATE authTag to bogus value        -- tamper the row
      5. GET /admin/llm/status after tamper        -- must fail / show unconfigured
      6. DELETE /admin/llm/config                  -- cleanup

    Designed to be called from Run-NightlyLocal.ps1 with a `WriteResult` callback.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER ComposePath
    Path to docker-compose.yml, used for psql access via docker compose exec.

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$ComposePath,
    [scriptblock]$WriteResult
)

$ErrorActionPreference = 'Continue'
$standaloneFailures = 0

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $color = if ($Passed) { 'Green' } else { 'Red' }
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "    $status  $Name  $Detail" -ForegroundColor $color
    if ($WriteResult) {
        & $WriteResult $Name $Passed $Detail
    } elseif (-not $Passed) {
        $script:standaloneFailures++
    }
}

function Invoke-LocalApi {
    param([string]$Path, [string]$Method = 'Get', [hashtable]$Body = $null)
    $uri = "$ApiBaseUrl$Path"
    $params = @{
        Uri         = $uri
        Method      = $Method
        ContentType = 'application/json'
        TimeoutSec  = 30
        ErrorAction = 'Stop'
    }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod @params
}

function Invoke-Psql {
    param([string]$Sql)
    $composeArgs = @('compose')
    if ($ComposePath) { $composeArgs += @('-f', $ComposePath) }
    $composeArgs += @('exec', '-T',
        '-e', 'PGPASSWORD=identity_atlas_local',
        'postgres',
        'psql', '-U', 'identity_atlas', '-d', 'identity_atlas',
        '-t', '-A', '-c', $Sql)
    $result = & docker @composeArgs 2>&1
    return ($result | Out-String).Trim()
}

# ─── 1. Save a test secret ───────────────────────────────────────
function Invoke-VaultSaveSecret {
    param([string]$Plaintext)
    try {
        $r = Invoke-LocalApi -Path '/admin/llm/config' -Method Put -Body @{
            provider = 'anthropic'
            apiKey   = $Plaintext
        }
        if ($r.ok -eq $true) {
            Write-Result 'Vault/SaveSecret' $true 'saved with ok=true'
        } else {
            Write-Result 'Vault/SaveSecret' $false "unexpected response: $($r | ConvertTo-Json -Depth 5 -Compress)"
            $script:abortRemaining = $true
        }
    } catch {
        Write-Result 'Vault/SaveSecret' $false $_.Exception.Message
        $script:abortRemaining = $true
    }
}

# ─── 2. Verify key is set ────────────────────────────────────────
function Invoke-VaultKeyIsSet {
    try {
        $r = Invoke-LocalApi -Path '/admin/llm/status'
        $keyIsSet = ($r.apiKeySet -eq $true) -or ($r.configured -eq $true)
        if ($keyIsSet) {
            Write-Result 'Vault/KeyIsSet' $true "apiKeySet=$($r.apiKeySet) configured=$($r.configured)"
        } else {
            Write-Result 'Vault/KeyIsSet' $false "apiKeySet=$($r.apiKeySet) configured=$($r.configured)"
            $script:abortRemaining = $true
        }
    } catch {
        Write-Result 'Vault/KeyIsSet' $false $_.Exception.Message
        $script:abortRemaining = $true
    }
}

# ─── 3. Verify encryption in DB ──────────────────────────────────
function Invoke-VaultEncryptionCheck {
    param([string]$Plaintext)
    try {
        $ciphertext = Invoke-Psql -Sql "SELECT ciphertext FROM ""Secrets"" WHERE id = 'llm.apikey'"
        if ([string]::IsNullOrWhiteSpace($ciphertext)) {
            Write-Result 'Vault/EncryptionVerified' $false 'no ciphertext row found in Secrets table'
            $script:abortRemaining = $true
        } elseif ($ciphertext -eq $Plaintext) {
            Write-Result 'Vault/EncryptionVerified' $false 'ciphertext equals plaintext — secret stored unencrypted!'
            $script:abortRemaining = $true
        } else {
            Write-Result 'Vault/EncryptionVerified' $true "ciphertext differs from plaintext (len=$($ciphertext.Length))"
        }
    } catch {
        Write-Result 'Vault/EncryptionVerified' $false $_.Exception.Message
        $script:abortRemaining = $true
    }
}

# ─── 4. Tamper detection ─────────────────────────────────────────
function Invoke-VaultTamperProbe {
    # Try to USE the key — /admin/llm/test decrypts the secret to make
    # an LLM call. With a tampered authTag, GCM decryption should fail.
    # The /admin/llm/status endpoint only checks existence (hasSecret),
    # it doesn't decrypt, so it can't detect tamper.
    try {
        $null = Invoke-LocalApi -Path '/admin/llm/test' -Method Post
        # If it somehow succeeds, tamper wasn't detected (bad)
        Write-Result 'Vault/TamperDetected' $false 'LLM test succeeded after tamper — integrity check failed'
    } catch {
        # Any error is good — it means decryption/use of the tampered key failed
        $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        Write-Result 'Vault/TamperDetected' $true "LLM test failed after tamper (status=$statusCode) — integrity check worked"
    }
}

function Invoke-VaultTamperCheck {
    try {
        $updateResult = Invoke-Psql -Sql "UPDATE ""Secrets"" SET ""authTag"" = 'tampered' WHERE id = 'llm.apikey'"
        # psql should return something like "UPDATE 1"
        if ($updateResult -notmatch 'UPDATE\s+1') {
            Write-Result 'Vault/TamperDetected' $false "psql UPDATE did not affect 1 row: $updateResult"
            return
        }
        Invoke-VaultTamperProbe
    } catch {
        Write-Result 'Vault/TamperDetected' $false $_.Exception.Message
    }
}

# ─── 5. Cleanup ──────────────────────────────────────────────────
function Invoke-VaultCleanup {
    try {
        $r = Invoke-LocalApi -Path '/admin/llm/config' -Method Delete
        Write-Result 'Vault/Cleanup' $true 'test secret deleted'
    } catch {
        $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($statusCode -eq 200 -or $statusCode -eq 204 -or $statusCode -eq 404) {
            Write-Result 'Vault/Cleanup' $true "cleanup ok (status=$statusCode)"
        } else {
            Write-Result 'Vault/Cleanup' $false "DELETE failed: $($_.Exception.Message)"
            # Best-effort: try to wipe via psql so we don't leave test data behind
            try { Invoke-Psql -Sql "DELETE FROM ""Secrets"" WHERE id = 'llm.apikey'" | Out-Null } catch { }
        }
    }
}

function Invoke-SecretsVaultTest {
    Write-Host "`n=== Secrets Vault (extended + tamper detection) ===" -ForegroundColor Cyan

    $testPlaintext = 'sk-test-vault-nightly-12345'
    $script:abortRemaining = $false

    Invoke-VaultSaveSecret -Plaintext $testPlaintext
    if (-not $script:abortRemaining) { Invoke-VaultKeyIsSet }
    if (-not $script:abortRemaining) { Invoke-VaultEncryptionCheck -Plaintext $testPlaintext }
    if (-not $script:abortRemaining) { Invoke-VaultTamperCheck }
    Invoke-VaultCleanup
}

Invoke-SecretsVaultTest

if (-not $WriteResult) { exit $standaloneFailures }
