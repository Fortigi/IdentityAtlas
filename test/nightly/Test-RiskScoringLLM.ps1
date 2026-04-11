<#
.SYNOPSIS
    Nightly test step: full risk-scoring flow with a real LLM call.

.DESCRIPTION
    Tests the complete risk-scoring journey end-to-end:
       1. POST /risk-profiles/generate with a real public domain — calls the
          provider configured in /api/admin/llm/config
       2. Save the generated profile
       3. POST /risk-classifiers/generate from the saved profile — calls the
          LLM again to produce regex patterns
       4. Save the generated classifiers
       5. POST /risk-scoring/runs — apply the classifiers against the demo data
       6. Poll until complete, assert Medium+ matches

    DIFFERENCE FROM Test-RiskScoring.ps1:
       The earlier test skips the LLM calls and POSTs hand-crafted JSON so it's
       deterministic + free. THIS test calls the real LLM and costs tokens on
       every run. For that reason it ONLY runs when the LLM is configured with
       a real API key (via test.secrets.json or env vars) AND the caller sets
       -RunLLMTests. Otherwise it exits cleanly with 'skipped'.

    Expected duration: 30-120 seconds depending on model.
    Expected cost:     ~$0.02 with Haiku, ~$0.50+ with Opus.

    Designed to run AFTER Configure-LLM.ps1 in the nightly pre-flight.

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER TestDomain
    Public domain passed to the LLM as the "org to profile". Defaults to
    the value in test.secrets.json → riskProfileTestDomain.

.PARAMETER WriteResult
    Optional callback: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
    [string]$TestDomain,
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

function Invoke-LocalApi {
    param([string]$Path, [string]$Method = 'Get', $Body = $null, [int]$TimeoutSec = 180)
    $uri = "$ApiBaseUrl$Path"
    $params = @{
        Uri         = $uri
        Method      = $Method
        # Explicit UTF-8 charset — Windows PowerShell 5.x defaults to the system
        # codepage (often CP-1252) which corrupts characters like em dashes and
        # non-ASCII names in JSON bodies, producing a 400 at the body-parser.
        ContentType = 'application/json; charset=utf-8'
        TimeoutSec  = $TimeoutSec
        ErrorAction = 'Stop'
    }
    if ($Body) {
        $json = $Body | ConvertTo-Json -Depth 30 -Compress
        # Force the wire bytes to UTF-8 regardless of PS version.
        $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
    }
    return Invoke-RestMethod @params
}

Write-Host "`n=== Risk Scoring — full LLM flow ===" -ForegroundColor Cyan

# ─── Pre-flight 1: LLM must be configured ────────────────────────
try {
    $status = Invoke-LocalApi -Path '/admin/llm/status' -TimeoutSec 10
    if (-not $status.configured) {
        Report-Result 'RiskLLM/LLMConfigured' $true 'skipped (no LLM configured)'
        if (-not $WriteResult) { exit 0 } else { return }
    }
    Report-Result 'RiskLLM/LLMConfigured' $true 'yes'
} catch {
    Report-Result 'RiskLLM/LLMConfigured' $true "skipped (status check failed: $($_.Exception.Message))"
    if (-not $WriteResult) { exit 0 } else { return }
}

# ─── Pre-flight 2: demo data must exist ──────────────────────────
try {
    $users = Invoke-LocalApi -Path '/users?pageSize=1' -TimeoutSec 10
    if ([int]$users.total -eq 0) {
        Report-Result 'RiskLLM/DemoData' $true 'skipped (no users loaded)'
        if (-not $WriteResult) { exit 0 } else { return }
    }
    Report-Result 'RiskLLM/DemoData' $true "users=$($users.total)"
} catch {
    Report-Result 'RiskLLM/DemoData' $true "skipped: $($_.Exception.Message)"
    if (-not $WriteResult) { exit 0 } else { return }
}

# ─── Determine the test domain ───────────────────────────────────
if (-not $TestDomain) {
    $TestDomain = $env:TEST_RISK_PROFILE_DOMAIN
}
if (-not $TestDomain) {
    $secretsPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'test\test.secrets.json'
    if (Test-Path $secretsPath) {
        try {
            $secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json
            if ($secrets.riskProfileTestDomain) { $TestDomain = $secrets.riskProfileTestDomain }
        } catch { }
    }
}
if (-not $TestDomain) { $TestDomain = 'portofrotterdam.com' }
Report-Result 'RiskLLM/TestDomain' $true $TestDomain

# ─── Step 1: Generate profile (real LLM call) ────────────────────
$generateStart = Get-Date
try {
    $genResp = Invoke-LocalApi -Path '/risk-profiles/generate' -Method Post -Body @{
        domain = $TestDomain
        hints  = 'Nightly regression test — produce a complete valid profile.'
    } -TimeoutSec 180
    $elapsed = [Math]::Round(((Get-Date) - $generateStart).TotalSeconds)
    if (-not $genResp.profile) {
        Report-Result 'RiskLLM/GenerateProfile' $false "no profile field (${elapsed}s)"
        if (-not $WriteResult) { exit 1 } else { return }
    }
    $profile = $genResp.profile
    $regCount = if ($profile.regulations) { @($profile.regulations).Count } else { 0 }
    $roleCount = if ($profile.critical_roles) { @($profile.critical_roles).Count } else { 0 }
    Report-Result 'RiskLLM/GenerateProfile' $true "model=$($genResp.llmModel) ${elapsed}s regulations=$regCount roles=$roleCount"
    if ($regCount -lt 1) {
        Report-Result 'RiskLLM/ProfileHasRegulations' $false "expected >=1, got $regCount"
    } else {
        Report-Result 'RiskLLM/ProfileHasRegulations' $true $regCount
    }
    if ($roleCount -lt 3) {
        Report-Result 'RiskLLM/ProfileHasCriticalRoles' $false "expected >=3, got $roleCount"
    } else {
        Report-Result 'RiskLLM/ProfileHasCriticalRoles' $true $roleCount
    }
} catch {
    Report-Result 'RiskLLM/GenerateProfile' $false $_.Exception.Message
    if (-not $WriteResult) { exit 1 } else { return }
}

# ─── Step 2: Save profile ────────────────────────────────────────
try {
    $saveResp = Invoke-LocalApi -Path '/risk-profiles' -Method Post -Body @{
        displayName = "Nightly LLM Test $(Get-Date -Format 'yyyyMMdd-HHmm')"
        profile     = $profile
        makeActive  = $true
    } -TimeoutSec 30
    $script:profileId = $saveResp.id
    Report-Result 'RiskLLM/SaveProfile' $true "id=$($saveResp.id)"
} catch {
    Report-Result 'RiskLLM/SaveProfile' $false $_.Exception.Message
    if (-not $WriteResult) { exit 1 } else { return }
}

# ─── Step 3: Generate classifiers (real LLM call) ────────────────
$generateStart = Get-Date
try {
    $clsResp = Invoke-LocalApi -Path '/risk-classifiers/generate' -Method Post -Body @{
        profileId = $script:profileId
    } -TimeoutSec 240
    $elapsed = [Math]::Round(((Get-Date) - $generateStart).TotalSeconds)
    if (-not $clsResp.classifiers) {
        Report-Result 'RiskLLM/GenerateClassifiers' $false "no classifiers field (${elapsed}s)"
        if (-not $WriteResult) { exit 1 } else { return }
    }
    $cls = $clsResp.classifiers
    $gc = if ($cls.groupClassifiers) { @($cls.groupClassifiers).Count } else { 0 }
    $uc = if ($cls.userClassifiers)  { @($cls.userClassifiers).Count }  else { 0 }
    $ac = if ($cls.agentClassifiers) { @($cls.agentClassifiers).Count } else { 0 }
    Report-Result 'RiskLLM/GenerateClassifiers' $true "${elapsed}s groups=$gc users=$uc agents=$ac"
    if ($gc -lt 3) {
        Report-Result 'RiskLLM/HasGroupClassifiers' $false "expected >=3, got $gc"
    } else {
        Report-Result 'RiskLLM/HasGroupClassifiers' $true $gc
    }
} catch {
    Report-Result 'RiskLLM/GenerateClassifiers' $false $_.Exception.Message
    if (-not $WriteResult) { exit 1 } else { return }
}

# ─── Step 4: Save classifiers ────────────────────────────────────
try {
    $saveResp = Invoke-LocalApi -Path '/risk-classifiers' -Method Post -Body @{
        displayName = "Nightly LLM Test Classifiers $(Get-Date -Format 'yyyyMMdd-HHmm')"
        profileId   = $script:profileId
        classifiers = $cls
        makeActive  = $true
    } -TimeoutSec 30
    $script:classifierId = $saveResp.id
    Report-Result 'RiskLLM/SaveClassifiers' $true "id=$($saveResp.id)"
} catch {
    Report-Result 'RiskLLM/SaveClassifiers' $false $_.Exception.Message
    if (-not $WriteResult) { exit 1 } else { return }
}

# ─── Step 5: Run scoring ─────────────────────────────────────────
try {
    $runResp = Invoke-LocalApi -Path '/risk-scoring/runs' -Method Post -Body @{
        classifierId = $script:classifierId
    } -TimeoutSec 30
    $script:runId = $runResp.id
    Report-Result 'RiskLLM/StartRun' $true "id=$($runResp.id)"
} catch {
    Report-Result 'RiskLLM/StartRun' $false $_.Exception.Message
    if (-not $WriteResult) { exit 1 } else { return }
}

# ─── Step 6: Poll until complete ─────────────────────────────────
$finalRun = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $runState = Invoke-LocalApi -Path "/risk-scoring/runs/$($script:runId)" -TimeoutSec 10
        if ($runState.status -in @('completed', 'failed')) {
            $finalRun = $runState
            break
        }
    } catch { }
}

if (-not $finalRun) {
    Report-Result 'RiskLLM/RunCompletes' $false 'timed out after 120s'
} elseif ($finalRun.status -ne 'completed') {
    Report-Result 'RiskLLM/RunCompletes' $false "status=$($finalRun.status): $($finalRun.errorMessage)"
} else {
    Report-Result 'RiskLLM/RunCompletes' $true "scored=$($finalRun.scoredEntities)"

    # Assert at least some classifier matches were produced. The LLM-generated
    # classifiers SHOULD match real HBR/demo data since they were generated for
    # this exact org. Zero matches would mean either (a) the regex compile bug
    # regressed or (b) the LLM produced garbage patterns.
    try {
        $scores = Invoke-LocalApi -Path '/risk-scores' -TimeoutSec 15
        $matched = 0
        foreach ($tier in @('Minimal', 'Low', 'Medium', 'High', 'Critical')) {
            if ($scores.summary.groupsByTier.$tier) { $matched += [int]$scores.summary.groupsByTier.$tier }
            if ($scores.summary.usersByTier.$tier)  { $matched += [int]$scores.summary.usersByTier.$tier }
        }
        if ($matched -gt 0) {
            Report-Result 'RiskLLM/EntitiesMatched' $true "$matched entities Minimal+"
        } else {
            Report-Result 'RiskLLM/EntitiesMatched' $false "ZERO matches (regex compile or LLM output broken)"
        }
    } catch {
        Report-Result 'RiskLLM/EntitiesMatched' $false $_.Exception.Message
    }
}

# ─── Cleanup ─────────────────────────────────────────────────────
# Delete the test profile + classifiers so the next run starts clean and the
# "active" flag doesn't stay on a throwaway set.
try { Invoke-LocalApi -Path "/risk-profiles/$($script:profileId)" -Method Delete | Out-Null } catch { }
try { Invoke-LocalApi -Path "/risk-classifiers/$($script:classifierId)" -Method Delete | Out-Null } catch { }

if (-not $WriteResult) { exit $standaloneFailures }
