# ─── Run-AllTests.ps1 ──────────────────────────────────────────────────────
# Single-command test runner for the entire FortigiGraph test suite.
# Runs all phases sequentially, collects results, and prints a final summary.
#
# Usage:
#   # Minimum (offline + integration + UI E2E):
#   pwsh -File _Test\Run-AllTests.ps1 -ConfigFile _Test\config.test.json
#
#   # Full suite including risk scoring:
#   pwsh -File _Test\Run-AllTests.ps1 -ConfigFile _Test\config.test.json -LLMProvider Anthropic -LLMApiKey "sk-ant-..."
#
#   # Include deployed UI backend tests:
#   pwsh -File _Test\Run-AllTests.ps1 -ConfigFile _Test\config.test.json -UIBaseUrl "https://fg-test.azurewebsites.net"
#
#   # Skip phases you don't need:
#   pwsh -File _Test\Run-AllTests.ps1 -ConfigFile _Test\config.test.json -SkipIntegration -SkipE2E
#
# Prerequisites:
#   - PowerShell 7.2+
#   - Az PowerShell module (for integration tests)
#   - Node.js 20+ (for E2E tests)
#   - Config file with valid Azure + Graph settings (for integration tests)
# ───────────────────────────────────────────────────────────────────────────

param(
    [Parameter(Mandatory = $false)]
    [string]$ConfigFile,

    # Risk scoring options
    [Parameter(Mandatory = $false)]
    [ValidateSet("Anthropic", "OpenAI")]
    [string]$LLMProvider,

    [Parameter(Mandatory = $false)]
    [string]$LLMApiKey,

    # UI backend test options
    [Parameter(Mandatory = $false)]
    [string]$UIBaseUrl,

    [Parameter(Mandatory = $false)]
    [string]$BearerToken,

    # Phase control
    [switch]$FirstRun,               # Use Test-Integration.ps1 instead of Fast
    [switch]$SkipIntegration,        # Skip SQL + sync tests
    [switch]$SkipRiskScoring,        # Skip risk scoring tests
    [switch]$SkipAccountCorrelation, # Skip account correlation tests
    [switch]$SkipE2E,                # Skip Playwright browser tests
    [switch]$SkipUIBackend,          # Skip deployed UI backend tests
    [switch]$StopOnFailure           # Abort entire run on first phase failure
)

$ErrorActionPreference = "Continue"

# ── Phase tracking ─────────────────────────────────────────────────────
$script:PhaseResults = @()
$startTime = Get-Date

function Add-PhaseResult {
    param(
        [string]$Phase,
        [string]$Script,
        [int]$ExitCode,
        [double]$DurationSeconds
    )

    $passed = $ExitCode -eq 0
    $script:PhaseResults += [PSCustomObject]@{
        Phase    = $Phase
        Script   = $Script
        Passed   = $passed
        ExitCode = $ExitCode
        Duration = [math]::Round($DurationSeconds, 1)
    }

    if ($passed) {
        Write-Host "  ✓ $Phase completed ($([math]::Round($DurationSeconds, 1))s)" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $Phase FAILED (exit code $ExitCode, $([math]::Round($DurationSeconds, 1))s)" -ForegroundColor Red
    }

    return $passed
}

function Invoke-TestPhase {
    param(
        [string]$Phase,
        [string]$Script,
        [string[]]$Arguments = @()
    )

    Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host "  Phase: $Phase" -ForegroundColor Yellow
    Write-Host "  Script: $Script $($Arguments -join ' ')" -ForegroundColor Gray
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

    $phaseStart = Get-Date

    if ($Arguments.Count -gt 0) {
        & pwsh -File $Script @Arguments
    } else {
        & pwsh -File $Script
    }
    $exitCode = $LASTEXITCODE

    $duration = ((Get-Date) - $phaseStart).TotalSeconds
    $passed = Add-PhaseResult -Phase $Phase -Script $Script -ExitCode $exitCode -Duration $duration

    if (-not $passed -and $StopOnFailure) {
        Write-Host "`n⛔ StopOnFailure enabled — aborting remaining tests." -ForegroundColor Red
        Show-Summary
        exit 1
    }

    return $passed
}

function Show-Summary {
    $totalDuration = ((Get-Date) - $startTime).TotalSeconds
    $passed = ($script:PhaseResults | Where-Object Passed).Count
    $failed = ($script:PhaseResults | Where-Object { -not $_.Passed }).Count
    $total = $script:PhaseResults.Count

    Write-Host "`n" -NoNewline
    Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║           FORTIGRAPH TEST SUITE RESULTS          ║" -ForegroundColor Cyan
    Write-Host "╠══════════════════════════════════════════════════╣" -ForegroundColor Cyan

    foreach ($r in $script:PhaseResults) {
        $icon = if ($r.Passed) { "✓" } else { "✗" }
        $color = if ($r.Passed) { "Green" } else { "Red" }
        $line = "  $icon $($r.Phase)".PadRight(42) + "$($r.Duration)s"
        Write-Host "║ $line ║" -ForegroundColor $color
    }

    Write-Host "╠══════════════════════════════════════════════════╣" -ForegroundColor Cyan

    $summaryColor = if ($failed -eq 0) { "Green" } else { "Red" }
    $summaryLine = "  Passed: $passed / $total".PadRight(30) + "Total: $([math]::Round($totalDuration, 0))s"
    Write-Host "║ $summaryLine ║" -ForegroundColor $summaryColor
    Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan

    if ($failed -gt 0) {
        Write-Host "`nFailed phases:" -ForegroundColor Red
        $script:PhaseResults | Where-Object { -not $_.Passed } | ForEach-Object {
            Write-Host "  ✗ $($_.Phase) ($($_.Script))" -ForegroundColor Red
        }
        Write-Host "`nCheck logs in _Test/logs/ for details." -ForegroundColor Yellow
    }
}

# ── Start ──────────────────────────────────────────────────────────────

# Start transcript
$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$transcriptFile = Join-Path $logDir "full-suite-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
Start-Transcript -Path $transcriptFile -Force | Out-Null

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       FORTIGRAPH FULL TEST SUITE RUNNER          ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Config:       $(if ($ConfigFile) { $ConfigFile } else { '(none — offline tests only)' })" -ForegroundColor Gray
Write-Host "  LLM:          $(if ($LLMProvider) { $LLMProvider } else { '(skip risk scoring)' })" -ForegroundColor Gray
Write-Host "  UI URL:       $(if ($UIBaseUrl) { $UIBaseUrl } else { '(skip backend API tests)' })" -ForegroundColor Gray
Write-Host "  Integration:  $(if ($SkipIntegration) { 'SKIP' } elseif ($FirstRun) { 'Full (first run)' } else { 'Fast (reuse SQL)' })" -ForegroundColor Gray
Write-Host "  Correlation:  $(if ($SkipAccountCorrelation) { 'SKIP' } elseif ($ConfigFile) { 'Account Correlation' } else { '(no config)' })" -ForegroundColor Gray
Write-Host "  E2E:          $(if ($SkipE2E) { 'SKIP' } else { 'Playwright' })" -ForegroundColor Gray
Write-Host "  Stop on fail: $(if ($StopOnFailure) { 'Yes' } else { 'No' })" -ForegroundColor Gray

$testDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $testDir

# ══════════════════════════════════════════════════════════════════════
# PHASE 1: Unit Tests (offline, no Azure needed)
# ══════════════════════════════════════════════════════════════════════

Invoke-TestPhase -Phase "1. Unit Tests" -Script (Join-Path $testDir "Test-Unit.ps1")

# ══════════════════════════════════════════════════════════════════════
# PHASE 2: Setup Validation (requires Azure login + config)
# ══════════════════════════════════════════════════════════════════════

if ($ConfigFile) {
    Invoke-TestPhase -Phase "2a. Simple Diagnostics" `
        -Script (Join-Path $testDir "Test-Simple.ps1") `
        -Arguments @("-ConfigFile", $ConfigFile)

    Invoke-TestPhase -Phase "2b. Graph API" `
        -Script (Join-Path $testDir "Test-GraphAPI.ps1") `
        -Arguments @("-ConfigFile", $ConfigFile)
} else {
    Write-Host "`n  ○ Phase 2: SKIPPED (no -ConfigFile provided)" -ForegroundColor DarkYellow
}

# ══════════════════════════════════════════════════════════════════════
# PHASE 3: SQL + Sync Integration Tests
# ══════════════════════════════════════════════════════════════════════

if ($ConfigFile -and -not $SkipIntegration) {
    if ($FirstRun) {
        Invoke-TestPhase -Phase "3. Integration (full)" `
            -Script (Join-Path $testDir "Test-Integration.ps1") `
            -Arguments @("-ConfigFile", $ConfigFile, "-SkipCleanup")
    } else {
        Invoke-TestPhase -Phase "3. Integration (fast)" `
            -Script (Join-Path $testDir "Test-Integration-Fast.ps1") `
            -Arguments @("-ConfigFile", $ConfigFile)
    }
} else {
    $reason = if (-not $ConfigFile) { "no -ConfigFile" } else { "-SkipIntegration" }
    Write-Host "`n  ○ Phase 3: SKIPPED ($reason)" -ForegroundColor DarkYellow
}

# ══════════════════════════════════════════════════════════════════════
# PHASE 4: Risk Scoring
# ══════════════════════════════════════════════════════════════════════

if ($ConfigFile -and $LLMProvider -and $LLMApiKey -and -not $SkipRiskScoring) {
    Invoke-TestPhase -Phase "4. Risk Scoring" `
        -Script (Join-Path $testDir "Test-RiskScoring.ps1") `
        -Arguments @("-ConfigFile", $ConfigFile, "-LLMProvider", $LLMProvider, "-LLMApiKey", $LLMApiKey)
} else {
    $reason = if ($SkipRiskScoring) { "-SkipRiskScoring" }
              elseif (-not $LLMProvider) { "no -LLMProvider" }
              elseif (-not $LLMApiKey) { "no -LLMApiKey" }
              else { "no -ConfigFile" }
    Write-Host "`n  ○ Phase 4: SKIPPED ($reason)" -ForegroundColor DarkYellow
}

# ══════════════════════════════════════════════════════════════════════
# PHASE 5: Account Correlation Tests
# ══════════════════════════════════════════════════════════════════════

if ($ConfigFile -and -not $SkipAccountCorrelation) {
    $corrArgs = @("-ConfigFile", $ConfigFile)
    if ($LLMProvider -and $LLMApiKey) {
        $corrArgs += @("-LLMProvider", $LLMProvider, "-LLMApiKey", $LLMApiKey)
    } else {
        $corrArgs += @("-SkipLLM")
    }

    Invoke-TestPhase -Phase "5. Account Correlation" `
        -Script (Join-Path $testDir "Test-AccountCorrelation.ps1") `
        -Arguments $corrArgs
} else {
    $reason = if (-not $ConfigFile) { "no -ConfigFile" } else { "-SkipAccountCorrelation" }
    Write-Host "`n  ○ Phase 5: SKIPPED ($reason)" -ForegroundColor DarkYellow
}

# ══════════════════════════════════════════════════════════════════════
# PHASE 6a: UI Backend API Tests (against deployed app)
# ══════════════════════════════════════════════════════════════════════

if ($UIBaseUrl -and -not $SkipUIBackend) {
    $apiArgs = @("-BaseUrl", $UIBaseUrl)
    if ($BearerToken) {
        $apiArgs += @("-BearerToken", $BearerToken)
    }

    Invoke-TestPhase -Phase "6a. UI Backend API" `
        -Script (Join-Path $testDir "Test-UIBackend.ps1") `
        -Arguments $apiArgs
} else {
    $reason = if ($SkipUIBackend) { "-SkipUIBackend" } else { "no -UIBaseUrl" }
    Write-Host "`n  ○ Phase 6a: SKIPPED ($reason)" -ForegroundColor DarkYellow
}

# ══════════════════════════════════════════════════════════════════════
# PHASE 6b: Playwright E2E Browser Tests (against mock backend)
# ══════════════════════════════════════════════════════════════════════

if (-not $SkipE2E) {
    Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host "  Phase: 6b. UI E2E Browser Tests" -ForegroundColor Yellow
    Write-Host "  Script: npx playwright test" -ForegroundColor Gray
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

    $e2eStart = Get-Date
    $frontendDir = Join-Path $repoRoot "UI" "frontend"

    # Check Node.js is available
    $nodeAvailable = $null -ne (Get-Command "node" -ErrorAction SilentlyContinue)
    if (-not $nodeAvailable) {
        Write-Host "  ✗ Node.js not found — install Node.js 20+ to run E2E tests" -ForegroundColor Red
        Add-PhaseResult -Phase "6b. UI E2E Browser Tests" -Script "npx playwright test" -ExitCode 1 -Duration 0
    } else {
        # Ensure dependencies are installed
        Write-Host "  → Installing dependencies..." -ForegroundColor Cyan
        Push-Location $frontendDir
        try {
            & npm install --silent 2>&1 | Out-Null

            # Check if Playwright browsers are installed
            $playwrightCheck = & npx playwright install --dry-run 2>&1
            if ($playwrightCheck -match "not installed") {
                Write-Host "  → Installing Playwright browsers..." -ForegroundColor Cyan
                & npx playwright install chromium 2>&1 | Out-Null
            }

            # Run tests
            Write-Host "  → Running Playwright tests..." -ForegroundColor Cyan
            & npx playwright test 2>&1 | ForEach-Object { Write-Host "    $_" }
            $e2eExitCode = $LASTEXITCODE

            $e2eDuration = ((Get-Date) - $e2eStart).TotalSeconds
            $e2ePassed = Add-PhaseResult -Phase "6b. UI E2E Browser Tests" -Script "npx playwright test" -ExitCode $e2eExitCode -Duration $e2eDuration

            if (-not $e2ePassed) {
                Write-Host "  → Report: $frontendDir/playwright-report/index.html" -ForegroundColor Yellow
            }
        } catch {
            $e2eDuration = ((Get-Date) - $e2eStart).TotalSeconds
            Add-PhaseResult -Phase "6b. UI E2E Browser Tests" -Script "npx playwright test" -ExitCode 1 -Duration $e2eDuration
            Write-Host "  ✗ E2E test error: $($_.Exception.Message)" -ForegroundColor Red
        } finally {
            Pop-Location
        }
    }

    if (-not $e2ePassed -and $StopOnFailure) {
        Show-Summary
        Stop-Transcript | Out-Null
        exit 1
    }
} else {
    Write-Host "`n  ○ Phase 6b: SKIPPED (-SkipE2E)" -ForegroundColor DarkYellow
}

# ══════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════

Show-Summary

Stop-Transcript | Out-Null
Write-Host "`nFull transcript: $transcriptFile" -ForegroundColor Gray

# Exit with failure code if any phase failed
$failedCount = ($script:PhaseResults | Where-Object { -not $_.Passed }).Count
exit $(if ($failedCount -gt 0) { 1 } else { 0 })
