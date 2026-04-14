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

function Report-Result {
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

Write-Host "`n=== Configure LLM (pre-flight) ===" -ForegroundColor Cyan

# ─── Load secrets ────────────────────────────────────────────────
if (-not $SecretsPath) {
    $repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $SecretsPath = Join-Path $repoRoot 'test\test.secrets.json'
}

$secrets = $null
if (Test-Path $SecretsPath) {
    try {
        $secrets = Get-Content $SecretsPath -Raw | ConvertFrom-Json
    } catch {
        Report-Result 'LLM-Config/LoadSecrets' $false "failed to parse: $($_.Exception.Message)"
        if (-not $WriteResult) { exit 1 } else { return }
    }
}

# Env-var overrides take precedence over the file for all sensitive fields
$envKey      = $env:TEST_LLM_API_KEY
$envDomain   = $env:TEST_RISK_PROFILE_DOMAIN

$provider    = if ($secrets.llm.provider)   { $secrets.llm.provider }   else { 'anthropic' }
$model       = if ($secrets.llm.model)      { $secrets.llm.model }      else { $null }
$apiKey      = if ($envKey)                 { $envKey }                 else { $secrets.llm.apiKey }
$endpoint    = if ($secrets.llm.endpoint)   { $secrets.llm.endpoint }   else { $null }
$deployment  = if ($secrets.llm.deployment) { $secrets.llm.deployment } else { $null }
$apiVersion  = if ($secrets.llm.apiVersion) { $secrets.llm.apiVersion } else { $null }

# Treat placeholder values as "not configured"
if ($apiKey -eq 'sk-ant-...' -or $apiKey -eq '' -or -not $apiKey) {
    Report-Result 'LLM-Config/Available' $true 'skipped (no API key in secrets or env)'
    if (-not $WriteResult) { exit 0 } else { return }
}

Report-Result 'LLM-Config/Available' $true "provider=$provider model=$model"

# ─── Save config via API ─────────────────────────────────────────
$body = @{
    provider = $provider
    model    = $model
    apiKey   = $apiKey
}
if ($provider -eq 'azure-openai') {
    if (-not $endpoint -or -not $deployment) {
        Report-Result 'LLM-Config/AzureFields' $false 'azure-openai requires endpoint + deployment'
        if (-not $WriteResult) { exit 1 } else { return }
    }
    $body.endpoint   = $endpoint
    $body.deployment = $deployment
    if ($apiVersion) { $body.apiVersion = $apiVersion }
}

# Retry once on failure — Docker Desktop on Windows has a known race where
# postgres reports healthy but the bootstrap hasn't fully committed all
# migration tables yet. A single 5-second retry handles this without
# masking real bugs (a real schema issue would fail both attempts).
$saved = $false
for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
        $resp = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/llm/config" `
            -Method Put -ContentType 'application/json' `
            -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 30
        if ($resp.ok) {
            $suffix = if ($attempt -gt 1) { " (retry $attempt)" } else { '' }
            Report-Result 'LLM-Config/Save' $true "provider=$($resp.config.provider) model=$($resp.config.model)$suffix"
            $saved = $true
            break
        } else {
            throw 'no ok=true in response'
        }
    } catch {
        if ($attempt -lt 2) {
            Write-Host "    LLM-Config/Save failed (attempt $attempt), retrying in 5s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        } else {
            $detail = $_.Exception.Message
            if ($_.ErrorDetails.Message) { $detail += " — $($_.ErrorDetails.Message)" }
            Report-Result 'LLM-Config/Save' $false $detail
            if (-not $WriteResult) { exit 1 } else { return }
        }
    }
}

# ─── Verify with a ping ──────────────────────────────────────────
# This is a single round-trip to the provider with a tiny prompt. Catches
# invalid keys, wrong model names, network issues, etc. before any downstream
# phase tries a real profile generation.
try {
    $testResp = Invoke-RestMethod -Uri "$ApiBaseUrl/admin/llm/test" `
        -Method Post -ContentType 'application/json' `
        -Body '{}' -TimeoutSec 30
    if ($testResp.ok) {
        Report-Result 'LLM-Config/TestConnection' $true "model=$($testResp.model) latency=$($testResp.latencyMs)ms"
    } else {
        Report-Result 'LLM-Config/TestConnection' $false $testResp.error
    }
} catch {
    Report-Result 'LLM-Config/TestConnection' $false $_.Exception.Message
}

if (-not $WriteResult) { exit $standaloneFailures }
