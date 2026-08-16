<#
.SYNOPSIS
    Configure the Identity Atlas LLM settings from test.secrets.json.

.DESCRIPTION
    Reads the `llm` section of test/test.secrets.json (or environment variables)
    and POSTs it to /api/admin/llm/config. Used as a pre-flight step by the
    nightly runner before any test that actually calls the LLM.

    When both the secrets file and the env vars are missing, this exits cleanly
    with a "skipped" result — nightly runs on machines without LLM credentials
    still work, they just skip the LLM-dependent phases.

    After saving, it runs POST /api/admin/llm/test with the live config to
    verify the credentials actually work. The test step catches the most common
    problems (wrong key, wrong model name, network) before anything downstream
    blames the wrong layer.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER SecretsPath
    Default: test/test.secrets.json relative to the repo root

.PARAMETER WriteResult
    Callback signature: { param($Name, $Passed, $Detail) ... }
    Optional — standalone runs just print and exit.

.OUTPUTS
    Exit code 0 = LLM configured (or skipped cleanly)
    Exit code 1 = configuration attempted but failed (hard error)
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$SecretsPath,
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

# ─── Load secrets ────────────────────────────────────────────────
# Returns $true to continue, $false to stop with a hard error (bad JSON).
function Read-LlmSecrets {
    if (-not $SecretsPath) {
        $repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        $script:SecretsPath = Join-Path $repoRoot 'test\test.secrets.json'
    }

    $script:secrets = $null
    if (Test-Path $script:SecretsPath) {
        try {
            $script:secrets = Get-Content $script:SecretsPath -Raw | ConvertFrom-Json
        } catch {
            Write-Result 'LLM-Config/LoadSecrets' $false "failed to parse: $($_.Exception.Message)"
            return $false
        }
    }
    return $true
}

# ─── Resolve config fields ───────────────────────────────────────
# Env-var overrides take precedence over the file for all sensitive fields.
function Resolve-LlmConfig {
    $envKey      = $env:TEST_LLM_API_KEY
    $envDomain   = $env:TEST_RISK_PROFILE_DOMAIN

    $script:provider    = if ($secrets.llm.provider)   { $secrets.llm.provider }   else { 'anthropic' }
    $script:model       = if ($secrets.llm.model)      { $secrets.llm.model }      else { $null }
    $script:apiKey      = if ($envKey)                 { $envKey }                 else { $secrets.llm.apiKey }
    $script:endpoint    = if ($secrets.llm.endpoint)   { $secrets.llm.endpoint }   else { $null }
    $script:deployment  = if ($secrets.llm.deployment) { $secrets.llm.deployment } else { $null }
    $script:apiVersion  = if ($secrets.llm.apiVersion) { $secrets.llm.apiVersion } else { $null }
}

# ─── Availability check ──────────────────────────────────────────
# Treat placeholder values as "not configured". Returns $true to continue,
# $false to stop cleanly (skipped).
function Test-LlmConfigured {
    if ($apiKey -eq 'sk-ant-...' -or $apiKey -eq '' -or -not $apiKey) {
        Write-Result 'LLM-Config/Available' $true 'skipped (no API key in secrets or env)'
        return $false
    }
    Write-Result 'LLM-Config/Available' $true "provider=$provider model=$model"
    return $true
}

# ─── Build request body ──────────────────────────────────────────
# Returns the body hashtable, or $null when azure-openai fields are missing.
function Build-LlmBody {
    $body = @{
        provider = $provider
        model    = $model
        apiKey   = $apiKey
    }
    if ($provider -eq 'azure-openai') {
        if (-not $endpoint -or -not $deployment) {
            Write-Result 'LLM-Config/AzureFields' $false 'azure-openai requires endpoint + deployment'
            return $null
        }
        $body.endpoint   = $endpoint
        $body.deployment = $deployment
        if ($apiVersion) { $body.apiVersion = $apiVersion }
    }
    return $body
}

# Flatten a REST error record into a single detail string.
function Get-SaveFailureDetail {
    param($ErrorRecord)
    $detail = $ErrorRecord.Exception.Message
    if ($ErrorRecord.ErrorDetails.Message) { $detail += " — $($ErrorRecord.ErrorDetails.Message)" }
    return $detail
}

# ─── Save config via API ─────────────────────────────────────────
# Retry once on failure — Docker Desktop on Windows has a known race where
# postgres reports healthy but the bootstrap hasn't fully committed all
# migration tables yet. A single 5-second retry handles this without
# masking real bugs (a real schema issue would fail both attempts).
# Returns $true on success, $false on hard failure.
function Save-LlmConfig {
    param([hashtable]$Body)

    $saved = $false
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        try {
            $resp = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/llm/config" `
                -Method Put -ContentType 'application/json' `
                -Body ($Body | ConvertTo-Json -Compress) -TimeoutSec 30
            if (-not $resp.ok) { throw 'no ok=true in response' }
            $suffix = if ($attempt -gt 1) { " (retry $attempt)" } else { '' }
            Write-Result 'LLM-Config/Save' $true "provider=$($resp.config.provider) model=$($resp.config.model)$suffix"
            $saved = $true
            break
        } catch {
            if ($attempt -ge 2) {
                Write-Result 'LLM-Config/Save' $false (Get-SaveFailureDetail $_)
                return $false
            }
            Write-Host "    LLM-Config/Save failed (attempt $attempt), retrying in 5s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
    }
    return $true
}

# ─── Verify with a ping ──────────────────────────────────────────
# This is a single round-trip to the provider with a tiny prompt. Catches
# invalid keys, wrong model names, network issues, etc. before any downstream
# phase tries a real profile generation.
function Test-LlmConnection {
    try {
        $testResp = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/llm/test" `
            -Method Post -ContentType 'application/json' `
            -Body '{}' -TimeoutSec 30
        if ($testResp.ok) {
            Write-Result 'LLM-Config/TestConnection' $true "model=$($testResp.model) latency=$($testResp.latencyMs)ms"
        } else {
            Write-Result 'LLM-Config/TestConnection' $false $testResp.error
        }
    } catch {
        Write-Result 'LLM-Config/TestConnection' $false $_.Exception.Message
    }
}

# ─── Orchestrator: run the full flow, returning the exit code ────
# Early stops use `return <code>`; the script body decides exit vs return.
function Invoke-ConfigureLlm {
    Write-Host "`n=== Configure LLM (pre-flight) ===" -ForegroundColor Cyan

    if (-not (Read-LlmSecrets)) { return 1 }

    Resolve-LlmConfig
    if (-not (Test-LlmConfigured)) { return 0 }

    $body = Build-LlmBody
    if (-not $body) { return 1 }

    if (-not (Save-LlmConfig -Body $body)) { return 1 }

    Test-LlmConnection

    return $script:standaloneFailures
}

$exitCode = Invoke-ConfigureLlm
if (-not $WriteResult) { exit $exitCode }
