<#
.SYNOPSIS
    Run the nightly tests and, if anything failed, ask Claude to investigate +
    fix + re-run. Designed for unattended scheduling at 04:00 daily.

.DESCRIPTION
    Wraps Run-NightlyLocal.ps1 with a post-test review step that's a no-op when
    everything is green and only spends LLM tokens when there's something to
    fix. The flow is:

      1. Run the existing nightly suite (PowerShell unit + backend unit +
         frontend unit + Docker integration + Entra crawler scenarios + LLM
         substrate + Playwright + API doc check). Capture results to a JSON
         file in the nightly results folder.

      2. Parse the result file. Count failures.

      3. If failures == 0:
           - Append a one-line "all green" entry to the rolling summary log
           - Exit 0. No LLM tokens spent.

         If failures > 0:
           - Build a structured prompt with the failing test names, the most
             recent git diff (so Claude understands what changed), and the
             relevant log file paths
           - If the `claude` CLI is available on PATH, invoke it in headless
             mode with --dangerously-skip-permissions (the script runs in a
             dedicated worktree so the blast radius is bounded)
           - Otherwise, fall back to a single Anthropic API call that produces
             a markdown analysis but cannot fix anything (the analysis goes
             into a file and an email/notification is the responsibility of
             the operator)

      4. After Claude finishes (in headless mode), re-run the nightly suite
         once. The result of THAT run is what determines the exit code.

    This script is intended to be invoked by Windows Task Scheduler. The
    accompanying XML manifest is at setup/windows/IdentityAtlas-NightlyReview.xml.

.PARAMETER RepoRoot
    Path to the FortigiGraph repository root.

.PARAMETER LogFolder
    Where to write per-run logs. Default: test/nightly/results/<date>

.PARAMETER ClaudeCli
    Override the path to the `claude` CLI. Default: auto-detect via where.exe.

.PARAMETER NoFix
    Run the review (analysis only) but don't actually invoke Claude in headless
    fix-it mode. Useful for dry runs / first-time setup.

.PARAMETER MaxTokensPerReview
    Cost cap for the review LLM call. Default: 4096. The wrapper itself does
    not honour this — it's passed into the prompt so Claude knows the budget
    when it self-limits.

.EXAMPLE
    pwsh -File test/nightly/Run-NightlyAndReview.ps1
    # The full thing — nightly test + auto-review on failure.

.EXAMPLE
    pwsh -File test/nightly/Run-NightlyAndReview.ps1 -NoFix
    # Runs the nightly tests and the analysis call, but never fix-it mode.
    # Useful when you're not yet comfortable letting Claude touch the repo.

.NOTES
    SECRETS
    -------
    The Anthropic API key is read from (first hit wins):
      1. ANTHROPIC_API_KEY environment variable
      2. test/test.secrets.json → { "AnthropicApiKey": "sk-ant-..." }
      3. The Identity Atlas LLM vault at /api/admin/llm/config (only when
         the local stack is responsive — likely NOT the case at 4 AM if a
         test is failing because of an Identity Atlas regression)

    Key NEVER lives in the repo. test.secrets.json is gitignored.

    BLAST RADIUS
    ------------
    When invoked in fix-it mode, this script gives Claude Code permission to
    edit files and run commands. The mitigations:
      - The Claude prompt explicitly forbids: git push, git reset --hard,
        docker compose down -v, dropping database tables, deleting branches
      - Claude is told to commit fixes on a fresh branch
        `nightly-review/<date>` and stop, NOT push
      - The whole thing runs from your local clone — there is no production
        access
#>

[CmdletBinding()]
Param(
    [string]$RepoRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$LogFolder = '',
    [string]$ClaudeCli = '',
    [switch]$NoFix,
    [int]$MaxTokensPerReview = 4096
)

$ErrorActionPreference = 'Continue'
$startTime = Get-Date

if (-not $LogFolder) {
    $LogFolder = Join-Path $RepoRoot "test/nightly/results/$($startTime.ToString('yyyy-MM-dd_HHmm'))"
}
New-Item -ItemType Directory -Path $LogFolder -Force | Out-Null

$rollingLog = Join-Path $RepoRoot 'test/nightly/results/_rolling-summary.log'
$reviewLog  = Join-Path $LogFolder 'review.log'
$reviewMd   = Join-Path $LogFolder 'review-analysis.md'

function Write-Tee {
    param([string]$Message, [string]$Color = 'White')
    Write-Host $Message -ForegroundColor $Color
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $reviewLog -Value "$stamp $Message"
}

function Append-Rolling {
    param([string]$Line)
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $rollingLog -Value "$stamp $Line"
}

# ─── Helper: analysis-only Anthropic API call ─────────────────────
# Defined early because PowerShell needs functions visible before they're called.
function Invoke-AnalysisOnlyReview {
    param(
        [string]$ApiKey,
        [string]$Prompt,
        [string]$OutputFile,
        [int]$MaxTokens
    )
    $body = @{
        model       = 'claude-sonnet-4-20250514'
        max_tokens  = $MaxTokens
        temperature = 0.2
        system      = 'You are a senior engineer reviewing automated test failures for the Identity Atlas project. Produce a concise markdown analysis: (1) the most likely root cause for each failure, (2) the file/line you would investigate first, (3) a one-line recommended fix, (4) anything that looks like a regression vs an environmental flake. Be terse. No filler.'
        messages    = @(
            @{ role = 'user'; content = $Prompt }
        )
    } | ConvertTo-Json -Depth 10

    try {
        $resp = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/messages' `
            -Method Post `
            -Headers @{
                'x-api-key'         = $ApiKey
                'anthropic-version' = '2023-06-01'
                'Content-Type'      = 'application/json'
            } `
            -Body $body `
            -TimeoutSec 60
        $text = ($resp.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n"
        $text | Set-Content -Path $OutputFile -Encoding UTF8
        Write-Host "Analysis written to $OutputFile" -ForegroundColor Green
    } catch {
        Write-Host "Anthropic API call failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ─── Find the Anthropic API key ───────────────────────────────────
function Get-AnthropicKey {
    if ($env:ANTHROPIC_API_KEY) { return $env:ANTHROPIC_API_KEY }

    $secretsPath = Join-Path $RepoRoot 'test/test.secrets.json'
    if (Test-Path $secretsPath) {
        try {
            $secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json
            if ($secrets.AnthropicApiKey) { return $secrets.AnthropicApiKey }
        } catch { }
    }

    # Last resort: try to read from the Identity Atlas vault. Only works if
    # the stack is up — which is exactly when we DON'T need it (no failures
    # to review). Kept here for completeness.
    try {
        $cfg = Invoke-RestMethod -Uri 'http://localhost:3001/api/admin/llm/config' -TimeoutSec 5 -ErrorAction Stop
        if ($cfg.config.provider -eq 'anthropic' -and $cfg.apiKeySet) {
            Write-Tee 'Note: Identity Atlas vault has a key but the wrapper cannot decrypt it. Set ANTHROPIC_API_KEY directly.' 'Yellow'
        }
    } catch { }

    return $null
}

# ─── Find the Claude Code CLI ─────────────────────────────────────
function Get-ClaudeCli {
    if ($ClaudeCli -and (Test-Path $ClaudeCli)) { return $ClaudeCli }
    $found = Get-Command claude -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    # Check the common npm-global location
    $candidates = @(
        "$env:APPDATA\npm\claude.cmd",
        "$env:LOCALAPPDATA\Programs\claude-code\claude.exe",
        "$env:USERPROFILE\.local\bin\claude"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

# ─── Step 1: Run the nightly tests ────────────────────────────────
Write-Tee "═══ Nightly review run started at $startTime ═══" 'Cyan'
Write-Tee "Log folder: $LogFolder"

$nightlyScript = Join-Path $PSScriptRoot 'Run-NightlyLocal.ps1'
$nightlyOutput = Join-Path $LogFolder 'nightly-output.log'

Write-Tee "Running nightly suite..."
$nightlyExitCode = 0
try {
    & $nightlyScript -LogFolder $LogFolder *>&1 | Tee-Object -FilePath $nightlyOutput
    $nightlyExitCode = $LASTEXITCODE
} catch {
    Write-Tee "Nightly run threw: $($_.Exception.Message)" 'Red'
    $nightlyExitCode = 99
}
Write-Tee "Nightly suite exit code: $nightlyExitCode"

# ─── Step 2: Parse results ────────────────────────────────────────
$resultsJson = Join-Path $LogFolder 'results.json'
$failedTests = @()
if (Test-Path $resultsJson) {
    try {
        $report = Get-Content $resultsJson -Raw | ConvertFrom-Json
        # results.json shape: { timestamp, duration, total, passed, failed,
        #                       results: { <testName>: { Passed, Detail, Timestamp } } }
        if ($report.results) {
            foreach ($prop in $report.results.PSObject.Properties) {
                if (-not $prop.Value.Passed) {
                    $failedTests += [PSCustomObject]@{
                        Name   = $prop.Name
                        Detail = $prop.Value.Detail
                    }
                }
            }
        }
    } catch {
        Write-Tee "Failed to parse results.json: $($_.Exception.Message)" 'Yellow'
    }
}

# Fall back to exit code when results.json is missing
$failureCount = if ($failedTests.Count -gt 0) { $failedTests.Count } else { $nightlyExitCode }

# ─── Step 3a: All green → no-op ───────────────────────────────────
if ($failureCount -eq 0) {
    Write-Tee "All tests passed. No review needed." 'Green'
    Append-Rolling "PASS  exit=0  folder=$LogFolder"
    exit 0
}

Write-Tee "" 'White'
Write-Tee "$failureCount failure(s) detected:" 'Red'
foreach ($f in $failedTests | Select-Object -First 20) {
    Write-Tee "  • $($f.Name)  $($f.Detail)" 'Red'
}
if ($failedTests.Count -gt 20) {
    Write-Tee "  ... and $($failedTests.Count - 20) more" 'Red'
}

# ─── Step 3b: Build the prompt for Claude ────────────────────────
$promptTemplate = Join-Path $PSScriptRoot 'claude-review-prompt.md'
$promptText = if (Test-Path $promptTemplate) { Get-Content $promptTemplate -Raw } else {
    "You are reviewing automated nightly test failures for the Identity Atlas project. Investigate, fix, and re-run."
}

# Pull the git context Claude will need
Push-Location $RepoRoot
$gitBranch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
$gitHead   = (git rev-parse HEAD 2>$null).Trim()
$gitDiff   = (git log -1 --name-status 2>$null) -join "`n"
Pop-Location

$failuresFormatted = ($failedTests | ForEach-Object { "- $($_.Name)`n  $($_.Detail)" }) -join "`n"

$contextBlock = @"

═══ Run context ═══
- Date:           $(Get-Date -Format 'yyyy-MM-dd HH:mm')
- Repo:           $RepoRoot
- Branch:         $gitBranch
- HEAD:           $gitHead
- Log folder:     $LogFolder
- Failures:       $failureCount

═══ Most recent commit ═══
$gitDiff

═══ Failing tests ═══
$failuresFormatted

═══ Available log files ═══
- $nightlyOutput          (full nightly run output)
- $LogFolder/results.json (machine-readable test results)
$(Get-ChildItem $LogFolder -File | ForEach-Object { "- $($_.FullName)" } | Out-String)

═══ Constraints ═══
You may:
  - Read files, run grep/glob, run docker compose ps/logs, run individual tests
  - Edit source files to fix the regression
  - Commit fixes on a NEW branch named 'nightly-review/$(Get-Date -Format yyyy-MM-dd)'
  - Re-run the failing tests to verify the fix

You MUST NOT:
  - git push (anywhere, ever)
  - git reset --hard or any destructive git operation
  - docker compose down -v (would wipe the database)
  - Drop database tables, delete database rows
  - Bypass git hooks (--no-verify, --no-gpg-sign)
  - Modify CI/CD pipelines

If you cannot fix a failure within ~10 minutes of investigation, write a
short analysis of what you found into review-analysis.md and stop. The
operator will pick it up in the morning.

Token budget for this run: $MaxTokensPerReview output tokens. Be concise.
"@

$fullPrompt = "$promptText`n$contextBlock"
$promptFile = Join-Path $LogFolder 'claude-prompt.txt'
$fullPrompt | Set-Content -Path $promptFile -Encoding UTF8

# ─── Step 3c: Pick a path — Claude Code CLI vs API fallback ───────
$claudeCli = Get-ClaudeCli
$anthropicKey = Get-AnthropicKey

if ($NoFix) {
    Write-Tee "Running in -NoFix mode: skipping the fix-it Claude invocation." 'Yellow'
    if ($anthropicKey) {
        Write-Tee "Producing analysis-only review via Anthropic API..."
        Invoke-AnalysisOnlyReview -ApiKey $anthropicKey -Prompt $fullPrompt -OutputFile $reviewMd -MaxTokens $MaxTokensPerReview
    } else {
        Write-Tee "No Anthropic key found. Wrote prompt to $promptFile for manual triage." 'Yellow'
    }
    Append-Rolling "FAIL  failures=$failureCount  noFix=true  folder=$LogFolder"
    exit $failureCount
}

if ($claudeCli) {
    Write-Tee "Invoking Claude Code in headless fix-it mode: $claudeCli"
    # --dangerously-skip-permissions is the official flag for unattended runs.
    # The fix-it constraints are baked into the prompt and the script runs from
    # this clone only — no production access.
    $args = @(
        '-p',  $fullPrompt,
        '--dangerously-skip-permissions',
        '--add-dir', $RepoRoot
    )
    try {
        Push-Location $RepoRoot
        & $claudeCli @args *>&1 | Tee-Object -FilePath $reviewMd
        $claudeExit = $LASTEXITCODE
        Pop-Location
        Write-Tee "Claude Code returned exit code $claudeExit"
    } catch {
        Write-Tee "Claude Code invocation failed: $($_.Exception.Message)" 'Red'
    }

    # Re-run the nightly suite to see if the fix worked. Use a fresh log folder
    # so the second run's results don't overwrite the first.
    $rerunFolder = Join-Path $RepoRoot "test/nightly/results/$($startTime.ToString('yyyy-MM-dd_HHmm'))_rerun"
    Write-Tee "Re-running nightly to validate the fix → $rerunFolder"
    & $nightlyScript -LogFolder $rerunFolder *>&1 | Tee-Object -FilePath (Join-Path $rerunFolder 'rerun-output.log')
    $rerunExit = $LASTEXITCODE
    Write-Tee "Re-run exit code: $rerunExit"

    if ($rerunExit -eq 0) {
        Append-Rolling "FIXED failures=$failureCount  rerun=PASS  folder=$LogFolder"
    } else {
        Append-Rolling "FAIL  failures=$failureCount  rerun=$rerunExit  folder=$LogFolder"
    }
    exit $rerunExit

} elseif ($anthropicKey) {
    Write-Tee "Claude Code CLI not found. Falling back to Anthropic API analysis only." 'Yellow'
    Invoke-AnalysisOnlyReview -ApiKey $anthropicKey -Prompt $fullPrompt -OutputFile $reviewMd -MaxTokens $MaxTokensPerReview
    Append-Rolling "FAIL  failures=$failureCount  analysis-only  folder=$LogFolder"
    exit $failureCount

} else {
    Write-Tee "No Claude Code CLI and no ANTHROPIC_API_KEY. Wrote prompt to $promptFile." 'Yellow'
    Append-Rolling "FAIL  failures=$failureCount  no-llm  folder=$LogFolder"
    exit $failureCount
}

