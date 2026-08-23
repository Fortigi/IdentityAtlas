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
        $icon, $color = if ($r.Passed) { "✓", "Green" } else { "✗", "Red" }
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

function Start-SuiteTranscript {
    param([string]$LogDir)

    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $transcriptFile = Join-Path $LogDir "full-suite-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
    Start-Transcript -Path $transcriptFile -Force | Out-Null
    return $transcriptFile
}

function Get-SuiteHeaderLabels {
    $labels = @{}
    $labels.Config = if ($ConfigFile) { $ConfigFile } else { '(none — offline tests only)' }
    $labels.LLM = if ($LLMProvider) { $LLMProvider } else { '(skip risk scoring)' }
    $labels.UI = if ($UIBaseUrl) { $UIBaseUrl } else { '(skip backend API tests)' }
    $labels.E2E = if ($SkipE2E) { 'SKIP' } else { 'Playwright' }
    $labels.Stop = if ($StopOnFailure) { 'Yes' } else { 'No' }
    return $labels
}

function Get-SuitePhaseLabels {
    $labels = @{}
    $labels.Integration = if ($SkipIntegration) { 'SKIP' } elseif ($FirstRun) { 'Full (first run)' } else { 'Fast (reuse SQL)' }
    $labels.Correlation = if ($SkipAccountCorrelation) { 'SKIP' } elseif ($ConfigFile) { 'Account Correlation' } else { '(no config)' }
    return $labels
}

function Write-SuiteHeader {
    $h = Get-SuiteHeaderLabels
    $p = Get-SuitePhaseLabels

    Write-Host ""
    Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║       FORTIGRAPH FULL TEST SUITE RUNNER          ║" -ForegroundColor Cyan
    Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Config:       $($h.Config)" -ForegroundColor Gray
    Write-Host "  LLM:          $($h.LLM)" -ForegroundColor Gray
    Write-Host "  UI URL:       $($h.UI)" -ForegroundColor Gray
    Write-Host "  Integration:  $($p.Integration)" -ForegroundColor Gray
    Write-Host "  Correlation:  $($p.Correlation)" -ForegroundColor Gray
    Write-Host "  E2E:          $($h.E2E)" -ForegroundColor Gray
    Write-Host "  Stop on fail: $($h.Stop)" -ForegroundColor Gray
}

# ── PHASE 1: Unit Tests (offline, no Azure needed) ──────────────────────
function Invoke-Phase1UnitTests {
    param([string]$TestDir)

    Invoke-TestPhase -Phase "1. Unit Tests" -Script (Join-Path $TestDir "Test-Unit.ps1")
}

# ── PHASE 2: Setup Validation (requires Azure login + config) ───────────
function Invoke-Phase2SetupValidation {
    param([string]$TestDir)

    if ($ConfigFile) {
        Invoke-TestPhase -Phase "2a. Simple Diagnostics" `
            -Script (Join-Path $TestDir "Test-Simple.ps1") `
            -Arguments @("-ConfigFile", $ConfigFile)

        Invoke-TestPhase -Phase "2b. Graph API" `
            -Script (Join-Path $TestDir "Test-GraphAPI.ps1") `
            -Arguments @("-ConfigFile", $ConfigFile)
    } else {
        Write-Host "`n  ○ Phase 2: SKIPPED (no -ConfigFile provided)" -ForegroundColor DarkYellow
    }
}

# ── PHASE 3: SQL + Sync Integration Tests ───────────────────────────────
function Invoke-Phase3Integration {
    param([string]$TestDir)

    if ($ConfigFile -and -not $SkipIntegration) {
        if ($FirstRun) {
            Invoke-TestPhase -Phase "3. Integration (full)" `
                -Script (Join-Path $TestDir "Test-Integration.ps1") `
                -Arguments @("-ConfigFile", $ConfigFile, "-SkipCleanup")
        } else {
            Invoke-TestPhase -Phase "3. Integration (fast)" `
                -Script (Join-Path $TestDir "Test-Integration-Fast.ps1") `
                -Arguments @("-ConfigFile", $ConfigFile)
        }
    } else {
        $reason = if (-not $ConfigFile) { "no -ConfigFile" } else { "-SkipIntegration" }
        Write-Host "`n  ○ Phase 3: SKIPPED ($reason)" -ForegroundColor DarkYellow
    }
}

# ── PHASE 4: Risk Scoring ───────────────────────────────────────────────
function Invoke-Phase4RiskScoring {
    param([string]$TestDir)

    if ($ConfigFile -and $LLMProvider -and $LLMApiKey -and -not $SkipRiskScoring) {
        Invoke-TestPhase -Phase "4. Risk Scoring" `
            -Script (Join-Path $TestDir "Test-RiskScoring.ps1") `
            -Arguments @("-ConfigFile", $ConfigFile, "-LLMProvider", $LLMProvider, "-LLMApiKey", $LLMApiKey)
    } else {
        $reason = if ($SkipRiskScoring) { "-SkipRiskScoring" }
                  elseif (-not $LLMProvider) { "no -LLMProvider" }
                  elseif (-not $LLMApiKey) { "no -LLMApiKey" }
                  else { "no -ConfigFile" }
        Write-Host "`n  ○ Phase 4: SKIPPED ($reason)" -ForegroundColor DarkYellow
    }
}

# ── PHASE 5: Account Correlation Tests ──────────────────────────────────
function Invoke-Phase5AccountCorrelation {
    param([string]$TestDir)

    if ($ConfigFile -and -not $SkipAccountCorrelation) {
        $corrArgs = @("-ConfigFile", $ConfigFile)
        if ($LLMProvider -and $LLMApiKey) {
            $corrArgs += @("-LLMProvider", $LLMProvider, "-LLMApiKey", $LLMApiKey)
        } else {
            $corrArgs += @("-SkipLLM")
        }

        Invoke-TestPhase -Phase "5. Account Correlation" `
            -Script (Join-Path $TestDir "Test-AccountCorrelation.ps1") `
            -Arguments $corrArgs
    } else {
        $reason = if (-not $ConfigFile) { "no -ConfigFile" } else { "-SkipAccountCorrelation" }
        Write-Host "`n  ○ Phase 5: SKIPPED ($reason)" -ForegroundColor DarkYellow
    }
}

# ── PHASE 6a: UI Backend API Tests (against deployed app) ────────────────
function Invoke-Phase6aUIBackend {
    param([string]$TestDir)

    if ($UIBaseUrl -and -not $SkipUIBackend) {
        $apiArgs = @("-BaseUrl", $UIBaseUrl)
        if ($BearerToken) {
            $apiArgs += @("-BearerToken", $BearerToken)
        }

        Invoke-TestPhase -Phase "6a. UI Backend API" `
            -Script (Join-Path $TestDir "Test-UIBackend.ps1") `
            -Arguments $apiArgs
    } else {
        $reason = if ($SkipUIBackend) { "-SkipUIBackend" } else { "no -UIBaseUrl" }
        Write-Host "`n  ○ Phase 6a: SKIPPED ($reason)" -ForegroundColor DarkYellow
    }
}

# ── PHASE 6b: Playwright E2E, dependency install + test run ──────────────
function Invoke-PlaywrightTests {
    param(
        [string]$FrontendDir,
        [datetime]$E2eStart
    )

    Write-Host "  → Installing dependencies..." -ForegroundColor Cyan
    Push-Location $FrontendDir
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

        $e2eDuration = ((Get-Date) - $E2eStart).TotalSeconds
        $script:E2ePassed = Add-PhaseResult -Phase "6b. UI E2E Browser Tests" -Script "npx playwright test" -ExitCode $e2eExitCode -Duration $e2eDuration

        if (-not $script:E2ePassed) {
            Write-Host "  → Report: $FrontendDir/playwright-report/index.html" -ForegroundColor Yellow
        }
    } catch {
        $e2eDuration = ((Get-Date) - $E2eStart).TotalSeconds
        Add-PhaseResult -Phase "6b. UI E2E Browser Tests" -Script "npx playwright test" -ExitCode 1 -Duration $e2eDuration
        Write-Host "  ✗ E2E test error: $($_.Exception.Message)" -ForegroundColor Red
    } finally {
        Pop-Location
    }
}

# ── PHASE 6b: Playwright E2E Browser Tests (against mock backend) ────────
function Invoke-Phase6bE2E {
    param([string]$RepoRoot)

    if ($SkipE2E) {
        Write-Host "`n  ○ Phase 6b: SKIPPED (-SkipE2E)" -ForegroundColor DarkYellow
        return
    }

    Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host "  Phase: 6b. UI E2E Browser Tests" -ForegroundColor Yellow
    Write-Host "  Script: npx playwright test" -ForegroundColor Gray
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

    $e2eStart = Get-Date
    $frontendDir = Join-Path $RepoRoot "UI" "frontend"
    $script:E2ePassed = $null

    # Check Node.js is available
    $nodeAvailable = $null -ne (Get-Command "node" -ErrorAction SilentlyContinue)
    if (-not $nodeAvailable) {
        Write-Host "  ✗ Node.js not found — install Node.js 20+ to run E2E tests" -ForegroundColor Red
        Add-PhaseResult -Phase "6b. UI E2E Browser Tests" -Script "npx playwright test" -ExitCode 1 -Duration 0
    } else {
        # Ensure dependencies are installed
        Invoke-PlaywrightTests -FrontendDir $frontendDir -E2eStart $e2eStart
    }

    if (-not $script:E2ePassed -and $StopOnFailure) {
        Show-Summary
        Stop-Transcript | Out-Null
        exit 1
    }
}

function Invoke-AllTests {
    # Start transcript
    $logDir = Join-Path $PSScriptRoot "logs"
    $transcriptFile = Start-SuiteTranscript -LogDir $logDir

    Write-SuiteHeader

    $testDir = $PSScriptRoot
    $repoRoot = Split-Path -Parent $testDir

    Invoke-Phase1UnitTests -TestDir $testDir
    Invoke-Phase2SetupValidation -TestDir $testDir
    Invoke-Phase3Integration -TestDir $testDir
    Invoke-Phase4RiskScoring -TestDir $testDir
    Invoke-Phase5AccountCorrelation -TestDir $testDir
    Invoke-Phase6aUIBackend -TestDir $testDir
    Invoke-Phase6bE2E -RepoRoot $repoRoot

    # ── SUMMARY ─────────────────────────────────────────────────────────
    Show-Summary

    Stop-Transcript | Out-Null
    Write-Host "`nFull transcript: $transcriptFile" -ForegroundColor Gray

    # Exit with failure code if any phase failed
    $failedCount = ($script:PhaseResults | Where-Object { -not $_.Passed }).Count
    exit $(if ($failedCount -gt 0) { 1 } else { 0 })
}

# ── Start ──────────────────────────────────────────────────────────────
Invoke-AllTests
