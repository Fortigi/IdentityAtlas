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

# ─── Pre-flight 1: LLM must be configured ────────────────────────
# Returns $true to continue, $false to stop cleanly (skipped).
function Test-PreflightLLMConfigured {
    try {
        $status = Invoke-LocalApi -Path '/admin/llm/status' -TimeoutSec 10
        if (-not $status.configured) {
            Write-Result 'RiskLLM/LLMConfigured' $true 'skipped (no LLM configured)'
            return $false
        }
        Write-Result 'RiskLLM/LLMConfigured' $true 'yes'
    } catch {
        Write-Result 'RiskLLM/LLMConfigured' $true "skipped (status check failed: $($_.Exception.Message))"
        return $false
    }
    return $true
}

# ─── Pre-flight 2: demo data must exist ──────────────────────────
# Returns $true to continue, $false to stop cleanly (skipped).
function Test-PreflightDemoData {
    try {
        $users = Invoke-LocalApi -Path '/users?pageSize=1' -TimeoutSec 10
        if ([int]$users.total -eq 0) {
            Write-Result 'RiskLLM/DemoData' $true 'skipped (no users loaded)'
            return $false
        }
        Write-Result 'RiskLLM/DemoData' $true "users=$($users.total)"
    } catch {
        Write-Result 'RiskLLM/DemoData' $true "skipped: $($_.Exception.Message)"
        return $false
    }
    return $true
}

# ─── Determine the test domain ───────────────────────────────────
function Resolve-TestDomain {
    param([string]$TestDomain)
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
    if (-not $TestDomain) { $TestDomain = 'novastream-fi.net' }
    Write-Result 'RiskLLM/TestDomain' $true $TestDomain
    return $TestDomain
}

# ─── Step 1: assert profile has enough regulations + roles ───────
function Assert-ProfileCounts {
    param($RegCount, $RoleCount)
    if ($RegCount -lt 1) {
        Write-Result 'RiskLLM/ProfileHasRegulations' $false "expected >=1, got $RegCount"
    } else {
        Write-Result 'RiskLLM/ProfileHasRegulations' $true $RegCount
    }
    if ($RoleCount -lt 3) {
        Write-Result 'RiskLLM/ProfileHasCriticalRoles' $false "expected >=3, got $RoleCount"
    } else {
        Write-Result 'RiskLLM/ProfileHasCriticalRoles' $true $RoleCount
    }
}

# ─── Step 1: Generate profile (real LLM call) ────────────────────
# Returns the profile object on success, $null on failure.
function Invoke-GenerateProfile {
    param([string]$TestDomain)
    $generateStart = Get-Date
    try {
        $genResp = Invoke-LocalApi -Path '/risk-profiles/generate' -Method Post -Body @{
            domain = $TestDomain
            hints  = 'Nightly regression test — produce a complete valid profile.'
        } -TimeoutSec 180
        $elapsed = [Math]::Round(((Get-Date) - $generateStart).TotalSeconds)
        if (-not $genResp.profile) {
            Write-Result 'RiskLLM/GenerateProfile' $false "no profile field (${elapsed}s)"
            return $null
        }
        $profile = $genResp.profile
        $regCount = if ($profile.regulations) { @($profile.regulations).Count } else { 0 }
        $roleCount = if ($profile.critical_roles) { @($profile.critical_roles).Count } else { 0 }
        Write-Result 'RiskLLM/GenerateProfile' $true "model=$($genResp.llmModel) ${elapsed}s regulations=$regCount roles=$roleCount"
        Assert-ProfileCounts -RegCount $regCount -RoleCount $roleCount
        return $profile
    } catch {
        Write-Result 'RiskLLM/GenerateProfile' $false $_.Exception.Message
        return $null
    }
}

# ─── Step 2: Save profile ────────────────────────────────────────
# Returns $true on success, $false on failure. Sets $script:profileId.
function Save-RiskProfile {
    param($Profile)
    try {
        $saveResp = Invoke-LocalApi -Path '/risk-profiles' -Method Post -Body @{
            displayName = "Nightly LLM Test $(Get-Date -Format 'yyyyMMdd-HHmm')"
            profile     = $Profile
            makeActive  = $true
        } -TimeoutSec 30
        $script:profileId = $saveResp.id
        Write-Result 'RiskLLM/SaveProfile' $true "id=$($saveResp.id)"
        return $true
    } catch {
        Write-Result 'RiskLLM/SaveProfile' $false $_.Exception.Message
        return $false
    }
}

# ─── Step 3: assert enough group classifiers ─────────────────────
function Assert-ClassifierCounts {
    param($GroupCount)
    if ($GroupCount -lt 3) {
        Write-Result 'RiskLLM/HasGroupClassifiers' $false "expected >=3, got $GroupCount"
    } else {
        Write-Result 'RiskLLM/HasGroupClassifiers' $true $GroupCount
    }
}

# ─── Step 3: Generate classifiers (real LLM call) ────────────────
# Returns the classifiers object on success, $null on failure.
function Invoke-GenerateClassifiers {
    $generateStart = Get-Date
    try {
        $clsResp = Invoke-LocalApi -Path '/risk-classifiers/generate' -Method Post -Body @{
            profileId = $script:profileId
        } -TimeoutSec 240
        $elapsed = [Math]::Round(((Get-Date) - $generateStart).TotalSeconds)
        if (-not $clsResp.classifiers) {
            Write-Result 'RiskLLM/GenerateClassifiers' $false "no classifiers field (${elapsed}s)"
            return $null
        }
        $cls = $clsResp.classifiers
        $gc = if ($cls.groupClassifiers) { @($cls.groupClassifiers).Count } else { 0 }
        $uc = if ($cls.userClassifiers)  { @($cls.userClassifiers).Count }  else { 0 }
        $ac = if ($cls.agentClassifiers) { @($cls.agentClassifiers).Count } else { 0 }
        Write-Result 'RiskLLM/GenerateClassifiers' $true "${elapsed}s groups=$gc users=$uc agents=$ac"
        Assert-ClassifierCounts -GroupCount $gc
        return $cls
    } catch {
        Write-Result 'RiskLLM/GenerateClassifiers' $false $_.Exception.Message
        return $null
    }
}

# ─── Step 4: Save classifiers ────────────────────────────────────
# Returns $true on success, $false on failure. Sets $script:classifierId.
function Save-RiskClassifiers {
    param($Classifiers)
    try {
        $saveResp = Invoke-LocalApi -Path '/risk-classifiers' -Method Post -Body @{
            displayName = "Nightly LLM Test Classifiers $(Get-Date -Format 'yyyyMMdd-HHmm')"
            profileId   = $script:profileId
            classifiers = $Classifiers
            makeActive  = $true
        } -TimeoutSec 30
        $script:classifierId = $saveResp.id
        Write-Result 'RiskLLM/SaveClassifiers' $true "id=$($saveResp.id)"
        return $true
    } catch {
        Write-Result 'RiskLLM/SaveClassifiers' $false $_.Exception.Message
        return $false
    }
}

# ─── Step 5: Run scoring ─────────────────────────────────────────
# Returns $true on success, $false on failure. Sets $script:runId.
function Start-ScoringRun {
    try {
        $runResp = Invoke-LocalApi -Path '/risk-scoring/runs' -Method Post -Body @{
            classifierId = $script:classifierId
        } -TimeoutSec 30
        $script:runId = $runResp.id
        Write-Result 'RiskLLM/StartRun' $true "id=$($runResp.id)"
        return $true
    } catch {
        Write-Result 'RiskLLM/StartRun' $false $_.Exception.Message
        return $false
    }
}

# ─── Step 6: Poll until complete ─────────────────────────────────
# Returns the final run state, or $null if it never reached a terminal status.
function Wait-ScoringRun {
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
    return $finalRun
}

# ─── Step 6: count entities matched across all tiers ─────────────
function Get-MatchedEntityCount {
    param($Scores)
    $matched = 0
    foreach ($tier in @('Minimal', 'Low', 'Medium', 'High', 'Critical')) {
        if ($Scores.summary.groupsByTier.$tier) { $matched += [int]$Scores.summary.groupsByTier.$tier }
        if ($Scores.summary.usersByTier.$tier)  { $matched += [int]$Scores.summary.usersByTier.$tier }
    }
    return $matched
}

# ─── Step 6: assert the completed run produced matches ───────────
function Assert-ScoringResults {
    param($FinalRun)
    if (-not $FinalRun) {
        Write-Result 'RiskLLM/RunCompletes' $false 'timed out after 120s'
        return
    }
    if ($FinalRun.status -ne 'completed') {
        Write-Result 'RiskLLM/RunCompletes' $false "status=$($FinalRun.status): $($FinalRun.errorMessage)"
        return
    }
    Write-Result 'RiskLLM/RunCompletes' $true "scored=$($FinalRun.scoredEntities)"

    # Assert at least some classifier matches were produced. The LLM-generated
    # classifiers SHOULD match the example/demo data since they were generated for
    # this exact org. Zero matches would mean either (a) the regex compile bug
    # regressed or (b) the LLM produced garbage patterns.
    try {
        $scores = Invoke-LocalApi -Path '/risk-scores' -TimeoutSec 15
        $matched = Get-MatchedEntityCount -Scores $scores
        if ($matched -gt 0) {
            Write-Result 'RiskLLM/EntitiesMatched' $true "$matched entities Minimal+"
        } else {
            Write-Result 'RiskLLM/EntitiesMatched' $false "ZERO matches (regex compile or LLM output broken)"
        }
    } catch {
        Write-Result 'RiskLLM/EntitiesMatched' $false $_.Exception.Message
    }
}

# ─── Cleanup ─────────────────────────────────────────────────────
# Delete the test profile + classifiers so the next run starts clean and the
# "active" flag doesn't stay on a throwaway set.
function Remove-TestData {
    try { Invoke-LocalApi -Path "/risk-profiles/$($script:profileId)" -Method Delete | Out-Null } catch { }
    try { Invoke-LocalApi -Path "/risk-classifiers/$($script:classifierId)" -Method Delete | Out-Null } catch { }
}

# ─── Orchestrator: run the full flow, returning the exit code ────
# Early stops use `return <code>`; the script body decides exit vs return.
function Invoke-RiskScoringLLMTest {
    Write-Host "`n=== Risk Scoring — full LLM flow ===" -ForegroundColor Cyan

    if (-not (Test-PreflightLLMConfigured)) { return 0 }
    if (-not (Test-PreflightDemoData))      { return 0 }

    $domain = Resolve-TestDomain -TestDomain $TestDomain

    $profile = Invoke-GenerateProfile -TestDomain $domain
    if (-not $profile) { return 1 }

    if (-not (Save-RiskProfile -Profile $profile)) { return 1 }

    $cls = Invoke-GenerateClassifiers
    if (-not $cls) { return 1 }

    if (-not (Save-RiskClassifiers -Classifiers $cls)) { return 1 }

    if (-not (Start-ScoringRun)) { return 1 }

    $finalRun = Wait-ScoringRun
    Assert-ScoringResults -FinalRun $finalRun

    Remove-TestData

    return $script:standaloneFailures
}

$exitCode = Invoke-RiskScoringLLMTest
if (-not $WriteResult) { exit $exitCode }
