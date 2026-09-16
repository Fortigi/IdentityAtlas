<#
.SYNOPSIS
    Local nightly test runner — provisions a full environment from scratch, runs all tests, tears down.

.DESCRIPTION
    Designed to run unattended via Windows Task Scheduler. Spins up Docker SQL + backend,
    initializes tables, runs crawlers, validates data, runs Playwright E2E, and produces a report.

    Exit code 0 = all tests passed. Non-zero = failures (count of failed test groups).

.PARAMETER RepoRoot
    Path to the FortigiGraph repository root. Default: parent of _Test folder.

.PARAMETER CsvDataset
    Optional path to a CSV test dataset folder. The CSV crawler step is skipped
    when this is empty or the folder doesn't exist (the bundled Omada export was
    removed from the repo in April 2026).

.PARAMETER SkipBackendUnit
    Skip backend JS unit tests

.PARAMETER SkipFrontendUnit
    Skip frontend React unit tests

.PARAMETER SkipIntegration
    Skip Docker integration tests (ingest + data verification)

.PARAMETER SkipE2E
    Skip Playwright browser tests

.PARAMETER KeepEnvironment
    Don't tear down Docker after tests (for debugging)

.PARAMETER LogFolder
    Folder for test logs and reports. Default: test/nightly/results/<date>

.EXAMPLE
    pwsh -File test\nightly\Run-NightlyLocal.ps1

.EXAMPLE
    pwsh -File test\nightly\Run-NightlyLocal.ps1 -SkipE2E -KeepEnvironment
#>

[CmdletBinding()]
Param(
    [string]$RepoRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$CsvDataset = '',
    [switch]$SkipStaticChecks,
    [switch]$SkipPowerShellUnit,
    [switch]$SkipBackendUnit,
    [switch]$SkipFrontendUnit,
    [switch]$SkipIntegration,
    [switch]$SkipE2E,
    [switch]$SkipLoadTest,
    [switch]$SkipSoakTest,
    [switch]$KeepEnvironment,
    [string]$LogFolder = ''
)

$ErrorActionPreference = 'Continue'
$startTime = Get-Date

if (-not $LogFolder) { $LogFolder = Join-Path $RepoRoot "test/nightly/results/$($startTime.ToString('yyyy-MM-dd_HHmm'))" }

New-Item -ItemType Directory -Path $LogFolder -Force | Out-Null

$results = @{}
$totalFailed = 0

function Write-Phase {
    param([string]$Name)
    Write-Host "`n╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║  $Name" -ForegroundColor Cyan
    Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
}

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    if ($Passed) {
        Write-Host "  PASS  $Name" -ForegroundColor Green
    } else {
        Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
        $script:totalFailed++
    }
    $script:results[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
}

# ─── Config (v5 — postgres) ──────────────────────────────────────
# v5 dropped SQL Server. The pgUser/pgDatabase below match the defaults in
# docker-compose.yml. All legacy SQL Server variables have been removed.
$pgUser      = 'identity_atlas'
$pgPassword  = 'identity_atlas_local'
$pgDatabase  = 'identity_atlas'

Import-Module (Join-Path $PSScriptRoot '..' 'lib' 'PgQuery.psm1') -Force
Set-PgConnection -User $pgUser -Password $pgPassword -Database $pgDatabase
$apiBaseUrl  = 'http://localhost:3001/api'
$uiBaseUrl   = 'http://localhost:3001'
$backendDir  = Join-Path $RepoRoot 'app/api'
$frontendDir = Join-Path $RepoRoot 'app/ui'
$composePath = Join-Path $RepoRoot 'docker-compose.yml'

# ═══════════════════════════════════════════════════════════════════
# The nightly runner is a long linear orchestration. To keep each unit
# small enough to reason about (and under the complexity budget), every
# phase / sub-phase lives in its own single-responsibility function and
# the script body at the bottom is just the ordered sequence of calls.
# Cross-phase values are threaded as parameters; shared tallies live in
# $script:results / $script:totalFailed (mutated via Write-Result).
# ═══════════════════════════════════════════════════════════════════

function Show-NightlyBanner {
    Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Yellow
    Write-Host "║  FortigiGraph Nightly Test Run                   ║" -ForegroundColor Yellow
    Write-Host "║  $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))                          ║" -ForegroundColor Yellow
    Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Yellow
    Write-Host "Repo:     $RepoRoot"
    Write-Host "Dataset:  $CsvDataset"
    Write-Host "Logs:     $LogFolder"
    Write-Host ""
}

# ─── Git pull (fetch latest code before building images) ──────────
# On a dedicated test VM the working tree should be clean. On a dev machine
# this is a no-op (already on the latest commit). If there are local changes
# the pull will fast-forward only and refuse to merge — that's the safe
# default for unattended operation.
function Invoke-GitPull {
    try {
        Push-Location $RepoRoot
        $branch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
        Write-Host "Git: branch '$branch', pulling latest..." -ForegroundColor Gray
        $pullOutput = git pull --ff-only 2>&1
        $pullExit = $LASTEXITCODE
        if ($pullExit -eq 0) {
            $head = (git rev-parse --short HEAD 2>$null).Trim()
            Write-Host "Git: up to date at $head" -ForegroundColor Green
        } else {
            Write-Host "Git: pull --ff-only failed (exit $pullExit). Continuing with current HEAD." -ForegroundColor Yellow
            Write-Host "     $pullOutput" -ForegroundColor Yellow
        }
        Pop-Location
    } catch {
        Write-Host "Git pull skipped: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 0: STATIC CHECKS (linting + dependency audit + spec lint)
# ═══════════════════════════════════════════════════════════════════
# Mirrors the pr.yml GitHub Actions checks so we catch the same issues
# locally before pushing. Fast fail gate — all four checks together run
# in well under a minute on a machine that has PSScriptAnalyzer + npm,
# and cleanly skip (marked PASS with "skipped: …") when a tool is missing.
#
# When npm is missing on the host we fall back to a one-shot
# `node:24-slim` container (same pattern as Phase 2 / Phase 3).

# ── 0a: PSScriptAnalyzer ────────────────────────────────────────
# Error-severity only. Write-Host / global vars are intentional
# patterns in the PowerShell SDK and would drown out real issues.
function Invoke-StaticPSSA {
    try {
        $hasPSSA = $null -ne (Get-Module -ListAvailable PSScriptAnalyzer)
        if (-not $hasPSSA) {
            Write-Result 'Static-PSScriptAnalyzer' $true 'skipped: PSScriptAnalyzer not installed'
        } else {
            Import-Module PSScriptAnalyzer -Force
            $scanPaths = @(
                'tools/powershell-sdk/graph',
                'tools/powershell-sdk/helpers',
                'tools/riskscoring',
                'app/db'
            ) | ForEach-Object { Join-Path $RepoRoot $_ } |
                Where-Object { Test-Path $_ }

            $pssaResults = @()
            foreach ($p in $scanPaths) {
                $pssaResults += Invoke-ScriptAnalyzer -Path $p -Recurse -Severity Error
            }
            $pssaLog = Join-Path $LogFolder 'static-psscriptanalyzer.log'
            if ($pssaResults) {
                $pssaResults | Format-Table RuleName, Severity, ScriptName, Line, Message -AutoSize |
                    Out-String | Out-File -FilePath $pssaLog -Encoding UTF8
                Write-Result 'Static-PSScriptAnalyzer' $false "$($pssaResults.Count) error(s) — see static-psscriptanalyzer.log"
            } else {
                "PSScriptAnalyzer: 0 errors across $($scanPaths.Count) scan paths" |
                    Out-File -FilePath $pssaLog -Encoding UTF8
                Write-Result 'Static-PSScriptAnalyzer' $true "0 errors across $($scanPaths.Count) paths"
            }
        }
    } catch {
        Write-Result 'Static-PSScriptAnalyzer' $false $_.Exception.Message
    }
}

# ── 0b: ESLint on app/ui ───────────────────────────────────────
function Invoke-StaticESLint {
    param([bool]$HasNpm)
    try {
        $eslintLog = Join-Path $LogFolder 'static-eslint.log'
        if ($HasNpm) {
            Push-Location $frontendDir
            $null = & npm run lint 2>&1 | Tee-Object -FilePath $eslintLog
            $eslintExit = $LASTEXITCODE
            Pop-Location
        } else {
            $uiPath = $frontendDir -replace '\\','/' -replace '^([A-Za-z]):','/$1'
            $null = & docker run --rm -v "${uiPath}:/work" -w /work node:24-slim sh -c "npm ci >/dev/null 2>&1; npm run lint" 2>&1 |
                Tee-Object -FilePath $eslintLog
            $eslintExit = $LASTEXITCODE
        }
        Write-Result 'Static-ESLint' ($eslintExit -eq 0) $(if ($eslintExit -ne 0) { "exit code $eslintExit — see static-eslint.log" })
    } catch {
        Write-Result 'Static-ESLint' $false $_.Exception.Message
        try { Pop-Location } catch {}
    }
}

# ── 0c: Spectral lint on openapi.yaml ──────────────────────────
# Static lint of the spec file itself, not a runtime check. Phase 6
# already hits /openapi.json on the running API but only verifies it
# returns valid JSON — a broken spec that happens to still serialise
# would slip through. This catches schema errors at the source.
function Invoke-StaticSpectral {
    param([bool]$HasNpm)
    try {
        $specFile = Join-Path $RepoRoot 'app/api/src/openapi.yaml'
        $spectralLog = Join-Path $LogFolder 'static-spectral.log'
        if (-not (Test-Path $specFile)) {
            Write-Result 'Static-Spectral' $false "spec file not found: $specFile"
        } elseif ($HasNpm) {
            # `npx -y` fetches @stoplight/spectral-cli on demand. The oas
            # ruleset ships with the CLI so no extra config file is needed.
            $null = & npx -y @stoplight/spectral-cli lint $specFile --ruleset @stoplight/spectral-oas 2>&1 |
                Tee-Object -FilePath $spectralLog
            $spectralExit = $LASTEXITCODE
            Write-Result 'Static-Spectral' ($spectralExit -eq 0) $(if ($spectralExit -ne 0) { "exit code $spectralExit — see static-spectral.log" })
        } else {
            # Docker fallback: mount the whole repo read-only so the spec
            # file and any $ref targets remain resolvable.
            $repoPath = $RepoRoot -replace '\\','/' -replace '^([A-Za-z]):','/$1'
            $null = & docker run --rm -v "${repoPath}:/work:ro" -w /work node:24-slim sh -c "npx -y @stoplight/spectral-cli lint app/api/src/openapi.yaml" 2>&1 |
                Tee-Object -FilePath $spectralLog
            $spectralExit = $LASTEXITCODE
            Write-Result 'Static-Spectral' ($spectralExit -eq 0) $(if ($spectralExit -ne 0) { "exit code $spectralExit (via docker)" })
        }
    } catch {
        Write-Result 'Static-Spectral' $false $_.Exception.Message
    }
}

# ── 0d: npm audit (one package) ────────────────────────────────
# --audit-level=high matches pr.yml: we only fail on high/critical
# CVEs so that a new moderate advisory doesn't flip the whole
# nightly run red overnight. The full audit output is logged so
# lower-severity findings are still visible for review.
function Invoke-SingleNpmAudit {
    param($Pkg, [bool]$HasNpm)
    try {
        $auditLog = Join-Path $LogFolder "static-npm-audit-$($Pkg.Name.ToLower()).log"
        if ($HasNpm) {
            Push-Location $Pkg.Dir
            $null = & npm audit --audit-level=high 2>&1 | Tee-Object -FilePath $auditLog
            $auditExit = $LASTEXITCODE
            Pop-Location
        } else {
            $pkgPath = $Pkg.Dir -replace '\\','/' -replace '^([A-Za-z]):','/$1'
            $null = & docker run --rm -v "${pkgPath}:/work" -w /work node:24-slim sh -c "npm ci --omit=dev >/dev/null 2>&1; npm audit --audit-level=high" 2>&1 |
                Tee-Object -FilePath $auditLog
            $auditExit = $LASTEXITCODE
        }
        Write-Result $Pkg.TestName ($auditExit -eq 0) $(if ($auditExit -ne 0) { "exit code $auditExit — see $(Split-Path $auditLog -Leaf)" })
    } catch {
        Write-Result $Pkg.TestName $false $_.Exception.Message
        try { Pop-Location } catch {}
    }
}

function Invoke-StaticNpmAudit {
    param([bool]$HasNpm)
    foreach ($pkg in @(
        @{ Name = 'UI';  Dir = $frontendDir; TestName = 'Static-NpmAudit-UI' },
        @{ Name = 'API'; Dir = $backendDir;  TestName = 'Static-NpmAudit-API' }
    )) {
        Invoke-SingleNpmAudit $pkg $HasNpm
    }
}

function Invoke-Phase0StaticChecks {
    if ($SkipStaticChecks) { return }
    Write-Phase "Phase 0: Static Checks"

    $hasNpm = $null -ne (Get-Command npm -ErrorAction SilentlyContinue)

    Invoke-StaticPSSA
    Invoke-StaticESLint $hasNpm
    Invoke-StaticSpectral $hasNpm
    Invoke-StaticNpmAudit $hasNpm
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 1: POWERSHELL UNIT TESTS (no dependencies)
# ═══════════════════════════════════════════════════════════════════

# In v5 the unit tests are Pester. We invoke them via Invoke-Pester so we
# get a proper pass/fail count instead of relying on a wrapper script.
function Invoke-PesterUnitTests {
    try {
        $pesterFile = Join-Path $RepoRoot 'test/unit/IdentityAtlas.Tests.ps1'
        if (Test-Path $pesterFile) {
            $hasPester = $null -ne (Get-Module -ListAvailable Pester | Where-Object { $_.Version -ge [Version]'5.0.0' })
            if (-not $hasPester) {
                Write-Result 'PS-Unit-Tests' $true 'skipped: Pester 5+ not installed'
            } else {
                Import-Module Pester -MinimumVersion 5.0.0 -Force
                $cfg = New-PesterConfiguration
                $cfg.Run.Path = $pesterFile
                $cfg.Run.PassThru = $true
                $cfg.Output.Verbosity = 'Minimal'
                $pesterResult = Invoke-Pester -Configuration $cfg 2>&1 |
                    Tee-Object -FilePath (Join-Path $LogFolder 'ps-unit.log')
                $passed = $pesterResult.FailedCount -eq 0
                Write-Result 'PS-Unit-Tests' $passed `
                    "$($pesterResult.PassedCount) passed, $($pesterResult.FailedCount) failed"
            }
        } else {
            Write-Result 'PS-Unit-Tests' $false 'IdentityAtlas.Tests.ps1 not found'
        }
    }
    catch {
        Write-Result 'PS-Unit-Tests' $false $_.Exception.Message
    }
}

# Additional: verify no references to deleted sync functions.
# In v5 the function folders moved from Functions/ to tools/powershell-sdk/
# and tools/riskscoring/. This check now searches the new locations.
function Test-DeletedFunctionRefs {
    Write-Phase "Phase 1b: Verify Deleted Functions Not Referenced"
    $deletedFunctions = @('Start-FGSync', 'Start-FGCSVSync', 'Sync-FGPrincipal', 'Sync-FGGroup',
                          'Sync-FGGroupMember', 'Sync-FGUser', 'Connect-FGSQLServer',
                          'Initialize-FGSQLTable', 'Invoke-FGSQLQuery')
    $searchRoots = @(
        (Join-Path $RepoRoot 'tools'),
        (Join-Path $RepoRoot 'setup'),
        (Join-Path $RepoRoot 'app\db')
    )
    $psFiles = $searchRoots |
        Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem -Path $_ -Include '*.ps1' -Recurse -ErrorAction SilentlyContinue }
    $badRefs = @()
    # Files we deliberately allow to mention removed functions (legacy help
    # text or migration notes that explain what was removed).
    $allowedLegacyFiles = @(
        'Start-EntraIDCrawler.ps1',   # docstring mentions "replaces Start-FGSync"
        'Start-CSVCrawler.ps1'        # docstring mentions "replaces Start-FGCSVSync"
    )
    foreach ($file in $psFiles) {
        if ($allowedLegacyFiles -contains $file.Name) { continue }
        if ($file.Name -match '^Test-') { continue }
        $content = Get-Content $file.FullName -Raw
        if ($content -match 'not yet implemented in v5') { continue }
        foreach ($fn in $deletedFunctions) {
            if ($content -match "\b$fn\b") {
                $badRefs += "$($file.Name) references deleted function $fn"
            }
        }
    }
    Write-Result 'No-Deleted-Function-Refs' ($badRefs.Count -eq 0) ($badRefs -join '; ')
}

function Invoke-Phase1PowerShellUnit {
    if ($SkipPowerShellUnit) { return }
    Write-Phase "Phase 1: PowerShell Unit Tests"
    Invoke-PesterUnitTests
    Test-DeletedFunctionRefs
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 2: BACKEND JS UNIT TESTS
# ═══════════════════════════════════════════════════════════════════

function Invoke-Phase2BackendUnit {
    if ($SkipBackendUnit) { return }
    Write-Phase "Phase 2: Backend Unit Tests"

    # When npm isn't on the PATH (common on a Docker-only host) we run vitest
    # inside a one-shot node:24-slim container that mounts the api source.
    $hasNpm = $null -ne (Get-Command npm -ErrorAction SilentlyContinue)
    try {
        if ($hasNpm) {
            Push-Location $backendDir
            $null = & npm test -- --reporter=verbose 2>&1 | Tee-Object -FilePath (Join-Path $LogFolder 'backend-unit.log')
            Write-Result 'Backend-Unit-Tests' ($LASTEXITCODE -eq 0) $(if ($LASTEXITCODE -ne 0) { "exit code $LASTEXITCODE" })
            Pop-Location
        } else {
            $apiPath = $backendDir -replace '\\','/' -replace '^([A-Za-z]):','/$1'
            $null = & docker run --rm -v "${apiPath}:/work" -w /work node:24-slim sh -c "npm ci >/dev/null 2>&1; npm test -- --reporter=verbose" 2>&1 |
                Tee-Object -FilePath (Join-Path $LogFolder 'backend-unit.log')
            Write-Result 'Backend-Unit-Tests' ($LASTEXITCODE -eq 0) $(if ($LASTEXITCODE -ne 0) { "exit code $LASTEXITCODE (via docker)" })
        }
    }
    catch {
        Write-Result 'Backend-Unit-Tests' $false $_.Exception.Message
        try { Pop-Location } catch {}
    }
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 3: FRONTEND UNIT TESTS
# ═══════════════════════════════════════════════════════════════════

function Invoke-Phase3FrontendUnit {
    if ($SkipFrontendUnit) { return }
    Write-Phase "Phase 3: Frontend Unit Tests"

    # Same docker-fallback as the backend phase: when npm is missing on the
    # host, run the frontend test command inside a one-shot node container.
    $hasNpm = $null -ne (Get-Command npm -ErrorAction SilentlyContinue)
    try {
        if ($hasNpm) {
            Push-Location $frontendDir
            $null = & npm test -- --reporter=verbose 2>&1 | Tee-Object -FilePath (Join-Path $LogFolder 'frontend-unit.log')
            Write-Result 'Frontend-Unit-Tests' ($LASTEXITCODE -eq 0) $(if ($LASTEXITCODE -ne 0) { "exit code $LASTEXITCODE" })
            Pop-Location
        } else {
            # The UI doesn't currently have a `test` script in package.json
            # (only test:e2e for Playwright), so we skip cleanly when running
            # inside docker fallback.
            Write-Host "  No frontend unit tests defined (only Playwright E2E exists, run with -SkipE2E to disable)" -ForegroundColor Gray
            Write-Result 'Frontend-Unit-Tests' $true 'no test script defined'
        }
    }
    catch {
        Write-Result 'Frontend-Unit-Tests' $false $_.Exception.Message
        try { Pop-Location } catch {}
    }
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 4: DOCKER INTEGRATION TESTS
# ═══════════════════════════════════════════════════════════════════

function Invoke-Phase4aProvision {
    Write-Phase "Phase 4a: Provision Docker Environment"

    # Tear down any existing containers
    Write-Host "  Cleaning up previous containers..." -ForegroundColor Gray
    & docker compose -f $composePath down -v 2>&1 | Out-Null

    # Start fresh
    Write-Host "  Starting Docker Compose..." -ForegroundColor Gray
    & docker compose -f $composePath up -d --build 2>&1 | Tee-Object -FilePath (Join-Path $LogFolder 'docker-up.log')
    Write-Result 'Docker-Compose-Up' ($LASTEXITCODE -eq 0)
}

# ── Wait for postgres + table migrations + API readiness ────────
# In v5 the docker-compose healthcheck waits for postgres, then the web
# container runs migrations on startup. The web container starts listening
# BEFORE migrations finish (migrations run from inside the listener
# callback), so /auth-config can return 200 while the database is still
# being set up. We hit /admin/status which depends on the Crawlers table
# — if that returns 200, bootstrap has fully completed.
function Wait-Phase4bApiReady {
    Write-Phase "Phase 4b: Wait for stack readiness (postgres + migrations + API)"

    $apiReady = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $status = Invoke-RestMethod -Uri "$apiBaseUrl/admin/status" -TimeoutSec 5
            if ($null -ne $status -and $null -ne $status.hasCrawlers) {
                $apiReady = $true
                break
            }
        } catch {
            # 500 = bootstrap still running; 401 = auth on; both retry
        }
        Start-Sleep -Seconds 2
    }
    Write-Result 'API-Ready' $apiReady $(if (-not $apiReady) { 'Timed out after 120 seconds' })
    return $apiReady
}

# ── Phase 4b2: Configure LLM (pre-flight for Phase 4j) ────────
# Reads credentials from test.secrets.json and POSTs them to
# /api/admin/llm/config. Runs BEFORE the data-dependent phases so any
# later phase can rely on LLM being available. Skips cleanly when no
# credentials are present.
function Invoke-Phase4b2ConfigureLLM {
    Write-Phase "Phase 4b2: Configure LLM (pre-flight)"
    $llmConfigScript = Join-Path $PSScriptRoot 'Configure-LLM.ps1'
    if (Test-Path $llmConfigScript) {
        $llmRunnerResults = $script:results
        $llmFailedRef = @{ Count = 0 }
        $llmConfigCallback = {
            param($Name, $Passed, $Detail)
            $llmRunnerResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
            if (-not $Passed) {
                $llmFailedRef.Count++
                Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
            } else {
                Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green
            }
        }.GetNewClosure()
        try {
            & $llmConfigScript -ApiBaseUrl $apiBaseUrl -WriteResult $llmConfigCallback
            $script:totalFailed += $llmFailedRef.Count
        } catch {
            Write-Result 'LLM-Config' $false $_.Exception.Message
        }
    } else {
        Write-Result 'LLM-Config' $true 'skipped (script missing)'
    }
}

# ── Verify all expected postgres relations exist ────────────────
# Query goes through test/lib/PgQuery.psm1, the single postgres transport for
# PowerShell (see nativePg.guard.test.js Tier 3). It replaces ~50 lines of
# inline psql + hand-rolled output filtering that used to live here.
function Invoke-Phase4cSchema {
    Write-Phase "Phase 4c: Verify Postgres Schema"

    # information_schema.tables covers base tables AND views. pg_tables lists only
    # base tables, so it reported GraphTags missing every night — since the v6
    # context redesign that's a backward-compat VIEW over Contexts, not a table.
    $expectedTables = @('Systems', 'Resources', 'Principals', 'ResourceAssignments', 'ResourceRelationships',
                        'Identities', 'IdentityMembers', 'Contexts', 'GovernanceCatalogs', 'AssignmentPolicies',
                        'AssignmentRequests', 'CertificationDecisions', 'Crawlers', 'CrawlerAuditLog',
                        'CrawlerConfigs', 'CrawlerJobs', 'WorkerConfig', 'GraphSyncLog',
                        'GraphTags', 'GovernanceCategories', 'GraphRiskProfiles', 'GraphRiskClassifiers',
                        'RiskScores', 'AccountLinkingConfig', 'AccountLinkingRuns',
                        # Added by migration 009 (history) and 010 (secrets + risk v2)
                        '_history', 'Secrets', 'RiskProfiles', 'RiskClassifiers', 'ScoringRuns')
    # GraphResourceClusters is deliberately absent: the v6 context redesign
    # dropped it (clustering is a context-algorithm plugin now) with no
    # compatibility view, so asserting on it failed every run.
    try {
        $existingTables = Invoke-PgQuery -Query @'
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
'@
        if ($existingTables.Count -eq 0) {
            # Report one failure rather than 30 not-found lines that bury the cause.
            Write-Result 'Schema-Check' $false 'postgres returned no relations (is the container up? check docker-up.log)'
        } else {
            foreach ($table in $expectedTables) {
                $exists = $existingTables -contains $table
                Write-Result "Table-$table" $exists $(if (-not $exists) { "Not found in information_schema.tables" })
            }
        }
    } catch {
        Write-Result 'Schema-Check' $false $_.Exception.Message
    }
}

# ── Phase 4d: Queue a demo job and let the built-in worker run it ──
# In v5 the built-in worker is auto-created at bootstrap and the worker
# container picks up jobs from the queue every 30s. We POST a demo job
# via the admin API and then poll until it completes (or times out).
function Wait-DemoJobFinal {
    param($JobId)
    # Poll for completion. Worker scheduler ticks every 30s + ~10s of
    # ingest work — we give it 5 minutes total before giving up.
    $deadline = (Get-Date).AddMinutes(5)
    $finalStatus = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        try {
            $status = Invoke-RestMethod -Uri "$apiBaseUrl/admin/crawler-jobs/$JobId" -TimeoutSec 10
            if ($status.status -in @('completed', 'failed', 'cancelled')) {
                $finalStatus = $status
                break
            }
        } catch { }
    }
    return $finalStatus
}

function Invoke-Phase4dDemoJob {
    Write-Phase "Phase 4d: Demo Job (queued via API, run by built-in worker)"

    $jobId = $null
    try {
        $job = Invoke-RestMethod -Uri "$apiBaseUrl/admin/crawler-jobs" -Method Post `
            -ContentType 'application/json' -Body '{"jobType":"demo"}'
        $jobId = $job.id
        Write-Result 'Demo-Job-Queued' ($null -ne $jobId) "id=$jobId"
    } catch {
        Write-Result 'Demo-Job-Queued' $false $_.Exception.Message
    }

    if ($jobId) {
        $finalStatus = Wait-DemoJobFinal $jobId
        if ($null -eq $finalStatus) {
            Write-Result 'Demo-Job-Completed' $false 'timed out after 5 min'
        } else {
            $msg = "ended in $($finalStatus.status)"
            if ($finalStatus.errorMessage) { $msg += ": $($finalStatus.errorMessage)" }
            Write-Result 'Demo-Job-Completed' ($finalStatus.status -eq 'completed') $msg
        }

        Invoke-Phase4eVerifyDemoData
    }
}

# ── Phase 4e: Verify the data was actually loaded ────────────
function Invoke-Phase4eVerifyDemoData {
    Write-Phase "Phase 4e: Verify Demo Data (row counts via API)"

    $checks = @(
        @{ name = 'Systems';      path = '/systems';      minCount = 1 },
        @{ name = 'Principals';   path = '/users';        minCount = 10 },
        @{ name = 'Resources';    path = '/resources';    minCount = 5 },
        @{ name = 'Permissions';  path = '/permissions';  minCount = 5 }
    )
    foreach ($check in $checks) {
        try {
            $r = Invoke-RestMethod -Uri "$apiBaseUrl$($check.path)" -TimeoutSec 30
            # Endpoints return either an array, { data: [] }, or { totalUsers, data: [] }
            $count = 0
            if ($r -is [array]) { $count = $r.Count }
            elseif ($r.data -is [array]) { $count = $r.data.Count }
            elseif ($r.totalUsers) { $count = $r.totalUsers }
            $passed = $count -ge $check.minCount
            Write-Result "Verify-$($check.name)" $passed "got $count, expected >= $($check.minCount)"
        } catch {
            Write-Result "Verify-$($check.name)" $false $_.Exception.Message
        }
    }
}

# ── Phase 4e2: Clean database and verify it's empty ─────────
# This caught a real bug in April 2026 where the clean-database
# endpoint used T-SQL (INFORMATION_SCHEMA with dbo schema, sys.tables,
# SYSTEM_VERSIONING) that silently returned "does not exist" for every
# table in postgres. The data appeared to wipe but actually didn't.
function Invoke-Phase4e2CleanDatabase {
    Write-Phase "Phase 4e2: Clean Database (wipe + verify empty)"

    try {
        $cleanResp = Invoke-RestMethod -Uri "$apiBaseUrl/admin/clean-database" `
            -Method Post -ContentType 'application/json' -TimeoutSec 30
        $wipedCount = @($cleanResp.wiped).Count
        $wipedRows  = ($cleanResp.wiped | Measure-Object -Property rowsAffected -Sum).Sum
        Write-Result 'Clean-Database-API' ($wipedCount -gt 0) "wiped $wipedCount tables, $wipedRows rows"

        # Verify the important tables are actually empty now
        $postCleanChecks = @(
            @{ name = 'Principals-Empty';  path = '/users';     maxCount = 0 },
            @{ name = 'Resources-Empty';   path = '/resources'; maxCount = 0 },
            @{ name = 'Systems-Empty';     path = '/systems';   maxCount = 0 }
        )
        foreach ($check in $postCleanChecks) {
            try {
                $r = Invoke-RestMethod -Uri "$apiBaseUrl$($check.path)" -TimeoutSec 30
                $count = 0
                if ($r -is [array]) { $count = $r.Count }
                elseif ($r.data -is [array]) { $count = $r.data.Count }
                elseif ($r.totalUsers) { $count = $r.totalUsers }
                $passed = $count -le $check.maxCount
                Write-Result "Verify-$($check.name)" $passed "got $count, expected 0"
            } catch {
                Write-Result "Verify-$($check.name)" $false $_.Exception.Message
            }
        }
    } catch {
        Write-Result 'Clean-Database-API' $false $_.Exception.Message
    }
}

# Reload demo data for the rest of the test phases (smoke tests,
# crawler scenarios) that expect a populated database.
function Invoke-DemoDataReload {
    Write-Host "  Reloading demo data after clean..." -ForegroundColor Gray
    try {
        $reloadJob = Invoke-RestMethod -Uri "$apiBaseUrl/admin/crawler-jobs" `
            -Method Post -ContentType 'application/json' -Body '{"jobType":"demo"}' -TimeoutSec 30
        $reloadId = $reloadJob.id
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 3
            try {
                $st = Invoke-RestMethod -Uri "$apiBaseUrl/admin/crawler-jobs/$reloadId" -TimeoutSec 10
                if ($st.status -eq 'completed') { break }
            } catch {}
        }
    } catch {
        Write-Host "  Demo reload failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ── Phase 4f: Smoke-test all read endpoints ──────────────────
function Invoke-Phase4fSmoke {
    Write-Phase "Phase 4f: Read endpoint smoke test"

    $smokeEndpoints = @(
        '/auth-config', '/features', '/admin/status', '/admin/auth-settings',
        '/admin/risk-profile', '/admin/classifiers', '/account-linking/config',
        '/admin/crawlers', '/admin/crawler-configs', '/admin/crawler-jobs',
        '/admin/container-stats', '/systems', '/users', '/resources',
        '/contexts', '/identities', '/access-package-groups', '/permissions',
        '/sync-log', '/preferences', '/perf', '/tags', '/categories',
        '/risk-scores', '/risk-scores/users', '/risk-scores/groups',
        '/risk-scores/business-roles', '/risk-scores/contexts',
        '/risk-scores/identities', '/risk-scores/clusters',
        '/risk-scores/cluster-summary', '/org-chart'
    )
    foreach ($ep in $smokeEndpoints) {
        try {
            $resp = Invoke-WebRequest -Uri "$apiBaseUrl$ep" -TimeoutSec 30 -UseBasicParsing
            Write-Result "Smoke-$ep" ($resp.StatusCode -eq 200) "HTTP $($resp.StatusCode)"
        } catch {
            $code = $null
            try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
            Write-Result "Smoke-$ep" $false "HTTP $code"
        }
    }
}

# ── Read the built-in worker API key from the shared volume ────
# Needed by all phases that call ingest or crawler endpoints.
function Get-BuiltinWorkerKey {
    $builtinApiKey = $null
    try {
        $env:MSYS_NO_PATHCONV = '1'
        $rawKey = & docker compose -f $composePath exec -T worker cat /data/uploads/.builtin-worker-key 2>$null
        if ($rawKey) { $builtinApiKey = ([string]$rawKey).Trim() }
        Remove-Item Env:MSYS_NO_PATHCONV -ErrorAction SilentlyContinue
    } catch { }
    if (-not $builtinApiKey) {
        Write-Host "  WARNING: Could not read built-in worker API key — ingest tests will skip auth" -ForegroundColor Yellow
    }
    return $builtinApiKey
}

# ── Phase 4f2: Ingest API direct tests ────────────────────────
function Invoke-Phase4f2Ingest {
    param($ApiKey)
    Write-Phase "Phase 4f2: Ingest API Direct Tests"
    $ingestTestScript = Join-Path $PSScriptRoot 'Test-IngestAPI.ps1'
    if (Test-Path $ingestTestScript) {
        try {
            $ingestResults = $script:results
            $ingestFailedRef = @{ Count = 0 }
            $ingestCallback = {
                param($Name, $Passed, $Detail)
                $ingestResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
                if (-not $Passed) { $ingestFailedRef.Count++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
                else { Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green }
            }.GetNewClosure()
            & $ingestTestScript -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey -WriteResult $ingestCallback
            $script:totalFailed += $ingestFailedRef.Count
        } catch {
            Write-Result 'Ingest-API-Tests' $false $_.Exception.Message
        }
    }
}

# ── Phase 4f3: CSV edge case tests ────────────────────────────
function Invoke-Phase4f3CsvEdge {
    param($ApiKey)
    Write-Phase "Phase 4f3: CSV Edge Case Tests"
    $csvEdgeScript = Join-Path $PSScriptRoot '..' '..' 'tools' 'crawlers' 'csv' 'Test-CSVCrawler.ps1'
    $csvEdgeScript = [System.IO.Path]::GetFullPath($csvEdgeScript)
    if (Test-Path $csvEdgeScript) {
        try {
            $csvResults = $script:results
            $csvFailedRef = @{ Count = 0 }
            $csvCallback = {
                param($Name, $Passed, $Detail)
                $csvResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
                if (-not $Passed) { $csvFailedRef.Count++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
                else { Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green }
            }.GetNewClosure()
            & $csvEdgeScript -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey -LogFolder $LogFolder -WriteResult $csvCallback
            $script:totalFailed += $csvFailedRef.Count
        } catch {
            Write-Result 'CSV-Edge-Cases' $false $_.Exception.Message
        }
    }
}

# ── Phase 4f3b: Detail-page counts + totalUsers regression ──────
function Invoke-Phase4f3bDetailCounts {
    param($ApiKey)
    Write-Phase "Phase 4f3b: Detail Page Counts + Permissions totalUsers"
    $dpcScript = Join-Path $PSScriptRoot 'Test-DetailPageCounts.ps1'
    if (Test-Path $dpcScript) {
        try {
            $dpcResults = $script:results
            $dpcFailedRef = @{ Count = 0 }
            $dpcCallback = {
                param($Name, $Passed, $Detail)
                $dpcResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
                if (-not $Passed) { $dpcFailedRef.Count++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
                else { Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green }
            }.GetNewClosure()
            & $dpcScript -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey -WriteResult $dpcCallback
            $script:totalFailed += $dpcFailedRef.Count
        } catch {
            Write-Result 'Detail-Page-Counts' $false $_.Exception.Message
        }
    }
}

# ── Phase 4f4: Account correlation ────────────────────────────
function Invoke-Phase4f4Correlation {
    param($ApiKey)
    Write-Phase "Phase 4f4: Account Correlation Tests"
    $corrScript = Join-Path $PSScriptRoot 'Test-AccountCorrelation.ps1'
    if (Test-Path $corrScript) {
        try {
            $corrResults = $script:results
            $corrFailedRef = @{ Count = 0 }
            $corrCallback = {
                param($Name, $Passed, $Detail)
                $corrResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
                if (-not $Passed) { $corrFailedRef.Count++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
                else { Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green }
            }.GetNewClosure()
            & $corrScript -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey -WriteResult $corrCallback
            $script:totalFailed += $corrFailedRef.Count
        } catch {
            Write-Result 'Account-Correlation' $false $_.Exception.Message
        }
    }
}

# ── Phase 4f5: Secrets vault deep test ────────────────────────
function Invoke-Phase4f5Vault {
    Write-Phase "Phase 4f5: Secrets Vault Deep Tests"
    $vaultScript = Join-Path $PSScriptRoot 'Test-SecretsVault.ps1'
    if (Test-Path $vaultScript) {
        try {
            $vaultResults = $script:results
            $vaultFailedRef = @{ Count = 0 }
            $vaultCallback = {
                param($Name, $Passed, $Detail)
                $vaultResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
                if (-not $Passed) { $vaultFailedRef.Count++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
                else { Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green }
            }.GetNewClosure()
            & $vaultScript -ApiBaseUrl $apiBaseUrl -ComposePath $composePath -WriteResult $vaultCallback
            $script:totalFailed += $vaultFailedRef.Count
        } catch {
            Write-Result 'Secrets-Vault' $false $_.Exception.Message
        }
    }
}

# ── Phase 4f6: Container stats live ───────────────────────────
function Write-ContainerServiceStats {
    param($Containers)
    foreach ($svc in @('web', 'worker', 'postgres')) {
        $c = $Containers | Where-Object { $_.service -eq $svc }
        if ($c) {
            Write-Result "Container-Stats/$svc/Running" ($c.state -eq 'running') "state=$($c.state)"
            Write-Result "Container-Stats/$svc/HasCPU" ($c.cpuPercent -ge 0) "cpu=$([math]::Round($c.cpuPercent, 1))%"
            Write-Result "Container-Stats/$svc/HasMem" ($c.memUsageBytes -gt 0) "mem=$([math]::Round($c.memUsageBytes / 1MB, 1))MB"
        } else {
            Write-Result "Container-Stats/$svc/Running" $false 'not found in response'
        }
    }
}

function Invoke-Phase4f6ContainerStats {
    Write-Phase "Phase 4f6: Container Stats Live"
    try {
        $stats = Invoke-RestMethod -Uri "$apiBaseUrl/admin/container-stats" -TimeoutSec 30
        if ($stats.unavailable) {
            Write-Result 'Container-Stats-Live' $false "Docker socket not accessible: $($stats.reason)"
        } else {
            $hasContainers = $stats.containers -and $stats.containers.Count -gt 0
            Write-Result 'Container-Stats-Live' $hasContainers "containers=$($stats.containers.Count)"
            if ($hasContainers) {
                Write-ContainerServiceStats $stats.containers
            }
        }
    } catch {
        Write-Result 'Container-Stats-Live' $false $_.Exception.Message
    }
}

# ── Phase 4f7: Custom Connector round-trip ─────────────────────
function Invoke-Phase4f7CustomConnector {
    Write-Phase "Phase 4f7: Custom Connector Round-Trip"
    $customConnScript = Join-Path $PSScriptRoot '..' '..' 'tools' 'crawlers' 'custom-connector' 'Test-CustomConnectorCrawler.ps1'
    $customConnScript = [System.IO.Path]::GetFullPath($customConnScript)
    if (Test-Path $customConnScript) {
        $ccRunnerResults = $script:results
        $ccFailedRef = @{ Count = 0 }
        $ccCallback = {
            param($Name, $Passed, $Detail)
            $ccRunnerResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
            if (-not $Passed) {
                $ccFailedRef.Count++
                Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
            } else {
                Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green
            }
        }.GetNewClosure()
        try {
            & $customConnScript -ApiBaseUrl $apiBaseUrl -WriteResult $ccCallback
            $script:totalFailed += $ccFailedRef.Count
        } catch {
            Write-Result 'Custom-Connector-Tests' $false $_.Exception.Message
        }
    }
}

# ── Phase 4g: Entra ID crawler scenarios (optional) ──────────
# Reads credentials from test/test.secrets.json. Skips itself when
# creds are missing. In v5 we read the built-in worker key from the
# shared volume that the web container wrote it to.
function Get-WorkerKeyForEntra {
    $workerKey = $null
    try {
        $keyPath = '/data/uploads/.builtin-worker-key'
        $env:MSYS_NO_PATHCONV = '1'
        # Same coercion as the schema check — be defensive against
        # docker exec returning ErrorRecord objects when the container
        # isn't ready yet.
        $rawKey = & docker compose exec -T worker cat $keyPath 2>$null
        if ($rawKey) {
            $workerKey = ([string]$rawKey).Trim()
        }
        Remove-Item Env:MSYS_NO_PATHCONV -ErrorAction SilentlyContinue
    } catch { }
    return $workerKey
}

function Invoke-Phase4gEntra {
    Write-Phase "Phase 4g: Entra ID Crawler Scenarios"

    $workerKey = Get-WorkerKeyForEntra

    $entraTestScript = Join-Path $PSScriptRoot '..' '..' 'tools' 'crawlers' 'entra-id' 'Test-EntraIdCrawler.ps1'
    $entraTestScript = [System.IO.Path]::GetFullPath($entraTestScript)
    if ((Test-Path $entraTestScript) -and $workerKey) {
        # Capture the runner's results hashtable by reference. The closure
        # body runs in the test script's scope but $runnerResults still
        # points at the same Hashtable object, so writes are visible.
        # totalFailed is a value type, so we use a small wrapper hashtable
        # to allow shared incrementing.
        $runnerResults = $script:results
        $failedRef = @{ Count = 0 }
        $resultsCallback = {
            param($Name, $Passed, $Detail)
            $runnerResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
            if (-not $Passed) {
                $failedRef.Count++
                Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
            } else {
                Write-Host "  PASS  $Name" -ForegroundColor Green
            }
        }.GetNewClosure()

        try {
            & $entraTestScript `
                -ApiBaseUrl  $apiBaseUrl `
                -ApiKey      $workerKey `
                -LogFolder   $LogFolder `
                -WriteResult $resultsCallback
            $script:totalFailed += $failedRef.Count
        } catch {
            Write-Result 'EntraID-Crawler-Tests' $false $_.Exception.Message
        }
    } else {
        Write-Result 'EntraID-Crawler-Tests' $true 'skipped (script or key missing)'
    }
}

# ── Phase 4h: LLM / risk-scoring substrate smoke test ──────
# Runs regardless of whether the Entra crawler ran. Doesn't require
# an LLM API key — verifies the routes/secrets vault are wired up.
function Invoke-Phase4hLlmSubstrate {
    Write-Phase "Phase 4h: LLM / Risk-scoring substrate"
    $llmTestScript = Join-Path $PSScriptRoot 'Test-LLMSubstrate.ps1'
    if (Test-Path $llmTestScript) {
        $runnerResults2 = $script:results
        $failedRef2 = @{ Count = 0 }
        $llmCallback = {
            param($Name, $Passed, $Detail)
            $runnerResults2[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
            if (-not $Passed) {
                $failedRef2.Count++
                Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
            } else {
                Write-Host "  PASS  $Name" -ForegroundColor Green
            }
        }.GetNewClosure()

        try {
            & $llmTestScript -ApiBaseUrl $apiBaseUrl -WriteResult $llmCallback
            $script:totalFailed += $failedRef2.Count
        } catch {
            Write-Result 'LLM-Substrate-Tests' $false $_.Exception.Message
        }
    } else {
        Write-Result 'LLM-Substrate-Tests' $true 'skipped (script missing)'
    }
}

# ── Phase 4i: Risk scoring end-to-end ──────────────────────
# Saves a hand-crafted profile + classifiers, triggers a scoring run,
# asserts the tier distribution. Skips the LLM generate/refine steps
# so it runs deterministically without burning tokens on every nightly.
# Doubles as a regression check for the regex-compile bug (April 2026).
function Invoke-Phase4iRiskScoring {
    Write-Phase "Phase 4i: Risk Scoring end-to-end"
    $riskTestScript = Join-Path $PSScriptRoot 'Test-RiskScoring.ps1'
    if (Test-Path $riskTestScript) {
        $runnerResults3 = $script:results
        $failedRef3 = @{ Count = 0 }
        $riskCallback = {
            param($Name, $Passed, $Detail)
            $runnerResults3[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
            if (-not $Passed) {
                $failedRef3.Count++
                Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
            } else {
                Write-Host "  PASS  $Name" -ForegroundColor Green
            }
        }.GetNewClosure()

        try {
            & $riskTestScript -ApiBaseUrl $apiBaseUrl -WriteResult $riskCallback
            $script:totalFailed += $failedRef3.Count
        } catch {
            Write-Result 'Risk-Scoring-Tests' $false $_.Exception.Message
        }
    } else {
        Write-Result 'Risk-Scoring-Tests' $true 'skipped (script missing)'
    }
}

# ── Phase 4j: Risk scoring with a REAL LLM call ─────────────
# Full end-to-end with profile + classifier generation hitting the
# actual provider configured by Phase 4b2. Costs real tokens on every
# run (~$0.02 with Haiku, ~$0.50+ with Opus), so test.secrets.json
# should default to a cheap model. Skips cleanly when the LLM isn't
# configured — Phase 4i still runs regardless.
function Invoke-Phase4jRiskScoringLLM {
    Write-Phase "Phase 4j: Risk Scoring with real LLM"
    $riskLLMScript = Join-Path $PSScriptRoot 'Test-RiskScoringLLM.ps1'
    if (Test-Path $riskLLMScript) {
        $runnerResults4 = $script:results
        $failedRef4 = @{ Count = 0 }
        $riskLLMCallback = {
            param($Name, $Passed, $Detail)
            $runnerResults4[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
            if (-not $Passed) {
                $failedRef4.Count++
                Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red
            } else {
                Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green
            }
        }.GetNewClosure()

        try {
            & $riskLLMScript -ApiBaseUrl $apiBaseUrl -WriteResult $riskLLMCallback
            $script:totalFailed += $failedRef4.Count
        } catch {
            Write-Result 'Risk-Scoring-LLM-Tests' $false $_.Exception.Message
        }
    } else {
        Write-Result 'Risk-Scoring-LLM-Tests' $true 'skipped (script missing)'
    }
}

# ── Phase 4k: API benchmark + regression check ────────────
# Hits the key read endpoints a few times, compares p95 against the
# stored baseline, and writes test/benchmark/results/BENCHMARK.md.
# Fails the phase if any endpoint regresses more than 25%.
function Invoke-Phase4kBenchmark {
    Write-Phase "Phase 4k: API Benchmark (regression check)"
    $benchScript = Join-Path $RepoRoot 'test/benchmark/Run-Benchmark.ps1'
    if (Test-Path $benchScript) {
        try {
            & $benchScript -ApiBaseUrl $apiBaseUrl `
                -OutputFolder (Join-Path $LogFolder 'benchmark') `
                -BaselineFile (Join-Path $RepoRoot 'test/benchmark/baseline.json') `
                -Runs 5 -RegressionPct 25 -FailOnRegression 2>&1 |
                Tee-Object -FilePath (Join-Path $LogFolder 'benchmark.log') | Out-Host
            $benchExit = $LASTEXITCODE
            Write-Result 'API-Benchmark' ($benchExit -eq 0) $(if ($benchExit -ne 0) { "regression detected (exit $benchExit)" })
        } catch {
            Write-Result 'API-Benchmark' $false $_.Exception.Message
        }
    } else {
        Write-Result 'API-Benchmark' $true 'skipped (script missing)'
    }
}

# ── Phase 4l: Full-scale load test (1.5M rows) ────────────────
# Generates the synthetic 1.5M-row dataset, ingests via CSV crawler,
# benchmarks, and asserts performance. Runs LAST in integration because
# it takes 15-30 min and transforms the database.
function Invoke-Phase4lLoadTest {
    param($ApiKey)
    if ($SkipLoadTest) {
        Write-Result 'LoadTest' $true 'skipped (-SkipLoadTest)'
        return
    }
    Write-Phase "Phase 4l: Full-Scale Load Test (1.5M rows)"
    $loadTestScript = Join-Path $PSScriptRoot 'Test-LoadAndBenchmark.ps1'
    if (Test-Path $loadTestScript) {
        $loadResults = $script:results
        $loadFailedRef = @{ Count = 0 }
        $loadCallback = {
            param($Name, $Passed, $Detail)
            $loadResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
            if (-not $Passed) { $loadFailedRef.Count++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
            else { Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green }
        }.GetNewClosure()
        try {
            & $loadTestScript -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey `
                -RepoRoot $RepoRoot -LogFolder $LogFolder -WriteResult $loadCallback
            $script:totalFailed += $loadFailedRef.Count
        } catch {
            Write-Result 'LoadTest' $false $_.Exception.Message
        }
    } else {
        Write-Result 'LoadTest' $true 'skipped (script missing)'
    }
}

function Invoke-Phase4Integration {
    if ($SkipIntegration) { return }

    $builtinApiKey = $null

    Invoke-Phase4aProvision
    $apiReady = Wait-Phase4bApiReady

    if ($apiReady) { Invoke-Phase4b2ConfigureLLM }

    Invoke-Phase4cSchema

    if (-not $apiReady) {
        Write-Host "  API never became ready — skipping ingest phases" -ForegroundColor Yellow
    }

    if ($apiReady) {
        Invoke-Phase4dDemoJob
        Invoke-Phase4e2CleanDatabase
        Invoke-DemoDataReload
        Invoke-Phase4fSmoke
        $builtinApiKey = Get-BuiltinWorkerKey
        Invoke-Phase4f2Ingest $builtinApiKey
        Invoke-Phase4f3CsvEdge $builtinApiKey
        Invoke-Phase4f3bDetailCounts $builtinApiKey
        Invoke-Phase4f4Correlation $builtinApiKey
        Invoke-Phase4f5Vault
        Invoke-Phase4f6ContainerStats
        Invoke-Phase4f7CustomConnector
        Invoke-Phase4gEntra
        Invoke-Phase4hLlmSubstrate
        Invoke-Phase4iRiskScoring
        Invoke-Phase4jRiskScoringLLM
        Invoke-Phase4kBenchmark
    }

    Invoke-Phase4lLoadTest $builtinApiKey
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 5: PLAYWRIGHT E2E BROWSER TESTS
# ═══════════════════════════════════════════════════════════════════

function Invoke-Phase5E2E {
    if ($SkipE2E) { return }
    Write-Phase "Phase 5: Playwright E2E Browser Tests"

    $hasNpm = $null -ne (Get-Command npx -ErrorAction SilentlyContinue)
    if (-not $hasNpm) {
        Write-Result 'Playwright-E2E' $true 'skipped: npx not on PATH'
        return
    }

    try {
        Push-Location $frontendDir

        # Check if running against Docker (real data) or mock
        if (-not $SkipIntegration) {
            # Real data mode — point Playwright at Docker backend
            $env:E2E_BASE_URL = $uiBaseUrl
            Write-Host "  Running against Docker backend ($uiBaseUrl)" -ForegroundColor Gray
        }
        else {
            Write-Host "  Running against mock backend" -ForegroundColor Gray
        }

        & npx playwright test --reporter=html 2>&1 | Tee-Object -FilePath (Join-Path $LogFolder 'playwright.log')
        Write-Result 'Playwright-E2E' ($LASTEXITCODE -eq 0) $(if ($LASTEXITCODE -ne 0) { "exit code $LASTEXITCODE" })

        # Copy Playwright report to log folder
        $reportDir = Join-Path $frontendDir 'playwright-report'
        if (Test-Path $reportDir) {
            Copy-Item -Path $reportDir -Destination (Join-Path $LogFolder 'playwright-report') -Recurse -Force
        }

        Pop-Location
    }
    catch {
        Write-Result 'Playwright-E2E' $false $_.Exception.Message
        Pop-Location
    }
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 6: SWAGGER / OPENAPI VALIDATION
# ═══════════════════════════════════════════════════════════════════

function Invoke-Phase6ApiDocs {
    if ($SkipIntegration) { return }
    Write-Phase "Phase 6: API Documentation"

    try {
        $swaggerResponse = Invoke-WebRequest -Uri "$uiBaseUrl/api/docs" -TimeoutSec 10 -UseBasicParsing
        Write-Result 'Swagger-UI-Loads' ($swaggerResponse.StatusCode -eq 200)
    }
    catch {
        Write-Result 'Swagger-UI-Loads' $false $_.Exception.Message
    }

    try {
        $specResponse = Invoke-RestMethod -Uri "$apiBaseUrl/openapi.json" -TimeoutSec 10
        Write-Result 'OpenAPI-Spec-Valid' ($null -ne $specResponse.openapi)
    }
    catch {
        Write-Result 'OpenAPI-Spec-Valid' $false $_.Exception.Message
    }
}

# ═══════════════════════════════════════════════════════════════════
# PHASE 7: SOAK TEST (sustained API load, memory leak detection)
# ═══════════════════════════════════════════════════════════════════

function Invoke-Phase7Soak {
    if ($SkipIntegration -or $SkipSoakTest) { return }
    Write-Phase "Phase 7: Soak Test (15 min sustained load)"
    $soakScript = Join-Path $PSScriptRoot 'Test-SoakTest.ps1'
    if (Test-Path $soakScript) {
        $soakResults = $script:results
        $soakFailedRef = @{ Count = 0 }
        $soakCallback = {
            param($Name, $Passed, $Detail)
            $soakResults[$Name] = @{ Passed = $Passed; Detail = $Detail; Timestamp = Get-Date }
            if (-not $Passed) { $soakFailedRef.Count++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
            else { Write-Host "  PASS  $Name  $Detail" -ForegroundColor Green }
        }.GetNewClosure()
        try {
            & $soakScript -ApiBaseUrl $apiBaseUrl -DurationMinutes 15 -WriteResult $soakCallback
            $script:totalFailed += $soakFailedRef.Count
        } catch {
            Write-Result 'Soak-Test' $false $_.Exception.Message
        }
    } else {
        Write-Result 'Soak-Test' $true 'skipped (script missing)'
    }
}

# ═══════════════════════════════════════════════════════════════════
# TEARDOWN
# ═══════════════════════════════════════════════════════════════════

function Invoke-Teardown {
    if ($KeepEnvironment -or $SkipIntegration) { return }
    Write-Phase "Teardown: Docker Environment"
    & docker compose -f $composePath down -v 2>&1 | Out-Null
    Write-Host "  Docker environment removed" -ForegroundColor Gray
}

# ═══════════════════════════════════════════════════════════════════
# REPORT
# ═══════════════════════════════════════════════════════════════════

function Write-ReportConsoleSummary {
    param([int]$FailedTests, [int]$PassedTests, [int]$TotalTests, $Elapsed)
    Write-Host "`n"
    Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor $(if ($FailedTests -eq 0) { 'Green' } else { 'Red' })
    Write-Host "║  NIGHTLY TEST RESULTS                            ║" -ForegroundColor $(if ($FailedTests -eq 0) { 'Green' } else { 'Red' })
    Write-Host "╠══════════════════════════════════════════════════╣" -ForegroundColor $(if ($FailedTests -eq 0) { 'Green' } else { 'Red' })
    Write-Host "║  Total:    $TotalTests" -ForegroundColor White
    Write-Host "║  Passed:   $PassedTests" -ForegroundColor Green
    Write-Host "║  Failed:   $FailedTests" -ForegroundColor $(if ($FailedTests -eq 0) { 'Green' } else { 'Red' })
    Write-Host "║  Duration: $([Math]::Round($Elapsed.TotalMinutes, 1)) minutes" -ForegroundColor White
    Write-Host "║  Report:   $LogFolder\report.md" -ForegroundColor White
    Write-Host "║  Latest:   test\nightly\results\latest.md" -ForegroundColor White
    Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor $(if ($FailedTests -eq 0) { 'Green' } else { 'Red' })
}

function Write-ReportJson {
    param([int]$FailedTests, [int]$PassedTests, [int]$TotalTests, $Elapsed)
    $reportJson = @{
        timestamp  = $startTime.ToString('o')
        duration   = [Math]::Round($Elapsed.TotalSeconds)
        total      = $TotalTests
        passed     = $PassedTests
        failed     = $FailedTests
        results    = $script:results
    } | ConvertTo-Json -Depth 5
    $reportJson | Out-File -FilePath (Join-Path $LogFolder 'results.json') -Encoding UTF8
}

function Write-ReportSummaryText {
    param([int]$FailedTests, [int]$PassedTests, [int]$TotalTests, $Elapsed)
    $summaryLines = @("FortigiGraph Nightly Test Results — $($startTime.ToString('yyyy-MM-dd HH:mm'))", "")
    foreach ($name in ($script:results.Keys | Sort-Object)) {
        $r = $script:results[$name]
        $status = if ($r.Passed) { 'PASS' } else { 'FAIL' }
        $line = "$status  $name"
        if ($r.Detail) { $line += "  ($($r.Detail))" }
        $summaryLines += $line
    }
    $summaryLines += ""
    $summaryLines += "Total: $TotalTests | Passed: $PassedTests | Failed: $FailedTests | Duration: $([Math]::Round($Elapsed.TotalMinutes, 1)) min"
    $summaryLines | Out-File -FilePath (Join-Path $LogFolder 'summary.txt') -Encoding UTF8
}

function Add-ReportFailuresSection {
    param($MdLines, [int]$FailedTests)
    if ($FailedTests -gt 0) {
        $MdLines.Add('## ❌ Failures')
        $MdLines.Add('')
        foreach ($name in ($script:results.Keys | Sort-Object)) {
            $r = $script:results[$name]
            if (-not $r.Passed) {
                $MdLines.Add("### $name")
                if ($r.Detail) {
                    $MdLines.Add('')
                    $MdLines.Add('```')
                    $MdLines.Add($r.Detail)
                    $MdLines.Add('```')
                }
                $MdLines.Add('')
            }
        }
    } else {
        $MdLines.Add('## ✅ All checks passed')
        $MdLines.Add('')
    }
}

function Add-ReportResultsTable {
    param($MdLines)
    $MdLines.Add('## All Results')
    $MdLines.Add('')
    $MdLines.Add('| Status | Test | Detail |')
    $MdLines.Add('|---|---|---|')
    foreach ($name in ($script:results.Keys | Sort-Object)) {
        $r = $script:results[$name]
        $icon = if ($r.Passed) { '✅' } else { '❌' }
        # Pipe-escape the detail so the markdown table doesn't get mangled
        $detail = if ($r.Detail) { $r.Detail -replace '\|','\|' -replace '\r?\n',' ' } else { '' }
        if ($detail.Length -gt 200) { $detail = $detail.Substring(0, 197) + '...' }
        $MdLines.Add("| $icon | $name | $detail |")
    }
}

# ─── Markdown report (for morning review) ────────────────────────
# Designed to be skimmable: status badge at the top, big PASS/FAIL counts,
# all failures up front with their detail messages, then full results table
# at the bottom for completeness. Open it in any markdown viewer.
function Write-ReportMarkdown {
    param([int]$FailedTests, [int]$PassedTests, [int]$TotalTests, $Elapsed)
    $mdLines = [System.Collections.Generic.List[string]]::new()
    $badge = if ($FailedTests -eq 0) { '🟢 ALL PASS' } else { "🔴 $FailedTests FAILED" }

    $mdLines.Add("# Nightly Test Run — $($startTime.ToString('yyyy-MM-dd HH:mm'))")
    $mdLines.Add('')
    $mdLines.Add("**Status:** $badge")
    $mdLines.Add('')
    $mdLines.Add('| Metric | Value |')
    $mdLines.Add('|---|---|')
    $mdLines.Add("| Total | $TotalTests |")
    $mdLines.Add("| Passed | $PassedTests |")
    $mdLines.Add("| Failed | $FailedTests |")
    $mdLines.Add("| Duration | $([Math]::Round($Elapsed.TotalMinutes, 1)) min |")
    $mdLines.Add("| Started | $($startTime.ToString('yyyy-MM-dd HH:mm:ss')) |")
    $mdLines.Add("| Finished | $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) |")
    $mdLines.Add("| Log folder | ``$LogFolder`` |")
    $mdLines.Add('')

    Add-ReportFailuresSection $mdLines $FailedTests
    Add-ReportResultsTable $mdLines

    $mdLines.Add('')
    $mdLines.Add('---')
    $mdLines.Add('')
    $mdLines.Add("Generated by ``test/nightly/Run-NightlyLocal.ps1``. Full per-test logs are alongside this file in ``$LogFolder``.")

    $mdPath = Join-Path $LogFolder 'report.md'
    $mdLines | Out-File -FilePath $mdPath -Encoding UTF8

    # Also write/overwrite a "latest" pointer at a fixed location so you can always
    # bookmark the same path in your editor / file explorer.
    $latestPath = Join-Path (Split-Path $LogFolder -Parent) 'latest.md'
    try {
        Copy-Item -Path $mdPath -Destination $latestPath -Force
    } catch {
        # Non-fatal — the dated copy is the source of truth
    }
}

function Write-ReportFailuresConsole {
    param([int]$FailedTests)
    if ($FailedTests -gt 0) {
        Write-Host "`nFailed tests:" -ForegroundColor Red
        foreach ($name in ($script:results.Keys | Sort-Object)) {
            $r = $script:results[$name]
            if (-not $r.Passed) {
                Write-Host "  - ${name}: $($r.Detail)" -ForegroundColor Red
            }
        }
    }
}

function Write-NightlyReport {
    $elapsed = (Get-Date) - $startTime
    $totalTests = $script:results.Count
    $passedTests = ($script:results.Values | Where-Object { $_.Passed }).Count
    $failedTests = $totalTests - $passedTests

    Write-ReportConsoleSummary $failedTests $passedTests $totalTests $elapsed
    Write-ReportJson $failedTests $passedTests $totalTests $elapsed
    Write-ReportSummaryText $failedTests $passedTests $totalTests $elapsed
    Write-ReportMarkdown $failedTests $passedTests $totalTests $elapsed
    Write-ReportFailuresConsole $failedTests

    return $failedTests
}

# ═══════════════════════════════════════════════════════════════════
# MAIN FLOW — ordered sequence of phases (exit code = failed test count)
# ═══════════════════════════════════════════════════════════════════

Show-NightlyBanner
Invoke-GitPull
Invoke-Phase0StaticChecks
Invoke-Phase1PowerShellUnit
Invoke-Phase2BackendUnit
Invoke-Phase3FrontendUnit
Invoke-Phase4Integration
Invoke-Phase5E2E
Invoke-Phase6ApiDocs
Invoke-Phase7Soak
Invoke-Teardown

exit (Write-NightlyReport)
