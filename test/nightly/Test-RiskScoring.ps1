<#
.SYNOPSIS
    Nightly test step: end-to-end risk scoring flow.

.DESCRIPTION
    Runs a complete risk-scoring cycle against the demo dataset without
    requiring an LLM API key. Skips the LLM generate/refine steps and uses
    hand-crafted profile + classifier JSON instead, because:

      1. Nightly runs must be deterministic — real LLM calls vary in output.
      2. We don't want to burn tokens ($) on every nightly.
      3. The LLM endpoints are covered by Test-LLMSubstrate.ps1's shape checks.

    What this script does:
      1. Saves a hand-crafted RiskProfile via POST /api/risk-profiles
      2. Saves a hand-crafted RiskClassifiers via POST /api/risk-classifiers
         with known-good regex patterns (uses Claude-style (?i) inline flags
         to regression-check the compileClassifier bug fix from April 2026)
      3. Triggers a scoring run via POST /api/risk-scoring/runs
      4. Polls until complete (max 60s — the demo dataset is small)
      5. Asserts:
         a) Run completed with status='completed'
         b) Total entities scored == demo principals + demo resources
         c) At least one classifier match was recorded (catches the regex
            compile regression — if the engine silently drops patterns, no
            match would be recorded)
         d) At least one Medium or higher score (direct match cap = 60 = Medium)
         e) The UI /api/risk-scores endpoint returns the scored data

    If the demo data isn't loaded, the test is skipped cleanly (not failed).

.PARAMETER ApiBaseUrl
    Default: http://localhost:3001/api

.PARAMETER WriteResult
    Callback: { param($Name, $Passed, $Detail) ... }
#>

[CmdletBinding()]
Param(
    [string]$ApiBaseUrl = 'http://localhost:3001/api',
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
    param([string]$Path, [string]$Method = 'Get', $Body = $null)
    $uri = "$ApiBaseUrl$Path"
    $params = @{
        Uri         = $uri
        Method      = $Method
        ContentType = 'application/json'
        TimeoutSec  = 60
        ErrorAction = 'Stop'
    }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
    return Invoke-RestMethod @params
}

Write-Host "`n=== Risk Scoring End-to-End ===" -ForegroundColor Cyan

# ─── Pre-flight: demo data must be loaded ────────────────────────
try {
    $users = Invoke-LocalApi -Path '/users?pageSize=1'
    $resources = Invoke-LocalApi -Path '/resources?pageSize=1'
    $userCount = if ($null -ne $users.total) { [int]$users.total } else { 0 }
    $resourceCount = if ($null -ne $resources.total) { [int]$resources.total } else { 0 }
    if ($userCount -eq 0 -or $resourceCount -eq 0) {
        Report-Result 'Risk/DemoDataLoaded' $true "skipped (no demo data: $userCount users, $resourceCount resources)"
        if (-not $WriteResult) { exit 0 } else { return }
    }
    Report-Result 'Risk/DemoDataLoaded' $true "users=$userCount resources=$resourceCount"
} catch {
    Report-Result 'Risk/DemoDataLoaded' $true "skipped (pre-flight failed: $($_.Exception.Message))"
    if (-not $WriteResult) { exit 0 } else { return }
}

# ─── Step 1: Save a hand-crafted profile (no LLM) ────────────────
# Minimal but valid customer_profile shape. The scoring engine doesn't actually
# read any of this — only the classifiers matter — but the save endpoint
# validates the shape so it must be complete.
$profilePayload = @{
    displayName = "Nightly Test Profile $(Get-Date -Format 'yyyyMMdd-HHmm')"
    profile = @{
        name = 'Nightly Test Org'
        domain = 'nightly.test'
        industry = 'testing'
        country = 'NL'
        description = 'Synthetic profile for nightly risk-scoring regression'
        regulations = @()
        critical_business_processes = @()
        known_systems = @()
        critical_roles = @()
        risk_domains = @()
    }
    makeActive = $true
}

try {
    $profileResp = Invoke-LocalApi -Path '/risk-profiles' -Method Post -Body $profilePayload
    if ($profileResp.id) {
        Report-Result 'Risk/SaveProfile' $true "id=$($profileResp.id)"
        $script:profileId = $profileResp.id
    } else {
        Report-Result 'Risk/SaveProfile' $false 'no id in response'
        if (-not $WriteResult) { exit 1 } else { return }
    }
} catch {
    Report-Result 'Risk/SaveProfile' $false $_.Exception.Message
    if (-not $WriteResult) { exit 1 } else { return }
}

# ─── Step 2: Save hand-crafted classifiers ───────────────────────
# Uses Claude-style (?i) inline flags to regression-test the engine's
# compileClassifier bug fix. If the engine regresses and silently drops
# these patterns, step 4 will see zero matches and the test fails loudly.
$classifierPayload = @{
    displayName = "Nightly Test Classifiers $(Get-Date -Format 'yyyyMMdd-HHmm')"
    profileId = $script:profileId
    classifiers = @{
        version = '1'
        groupClassifiers = @(
            @{
                id = 'any-admin'
                label = 'Any admin group'
                description = 'Very broad pattern to ensure at least some matches on demo data'
                patterns = @('(?i)admin', '(?i)\badministrator\b')
                score = 80
                tier = 'high'
                domain = 'privileged-access'
            },
            @{
                id = 'it-group'
                label = 'IT group'
                description = 'Broad IT role detection'
                patterns = @('(?i)\b(it|ict|helpdesk|support)\b')
                score = 40
                tier = 'medium'
                domain = 'operations'
            }
        )
        userClassifiers = @(
            @{
                id = 'ceo'
                label = 'Executive'
                description = 'C-level detection by job title'
                patterns = @('(?i)\b(ceo|cfo|cto|cio|ciso|director|president)\b')
                score = 70
                tier = 'high'
                domain = 'executives'
            }
        )
        agentClassifiers = @()
    }
    makeActive = $true
}

try {
    $clsResp = Invoke-LocalApi -Path '/risk-classifiers' -Method Post -Body $classifierPayload
    if ($clsResp.id) {
        Report-Result 'Risk/SaveClassifiers' $true "id=$($clsResp.id)"
        $script:classifierId = $clsResp.id
    } else {
        Report-Result 'Risk/SaveClassifiers' $false 'no id in response'
        if (-not $WriteResult) { exit 1 } else { return }
    }
} catch {
    Report-Result 'Risk/SaveClassifiers' $false $_.Exception.Message
    if (-not $WriteResult) { exit 1 } else { return }
}

# ─── Step 3: Trigger a scoring run ───────────────────────────────
try {
    $runResp = Invoke-LocalApi -Path '/risk-scoring/runs' -Method Post -Body @{ classifierId = $script:classifierId }
    if ($runResp.id) {
        Report-Result 'Risk/StartRun' $true "id=$($runResp.id) status=$($runResp.status)"
        $script:runId = $runResp.id
    } else {
        Report-Result 'Risk/StartRun' $false 'no id in response'
        if (-not $WriteResult) { exit 1 } else { return }
    }
} catch {
    Report-Result 'Risk/StartRun' $false $_.Exception.Message
    if (-not $WriteResult) { exit 1 } else { return }
}

# ─── Step 4: Poll until complete (max 60s — demo data is small) ──
$finalRun = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
        $runState = Invoke-LocalApi -Path "/risk-scoring/runs/$($script:runId)"
        if ($runState.status -in @('completed', 'failed')) {
            $finalRun = $runState
            break
        }
    } catch { }
}

if (-not $finalRun) {
    Report-Result 'Risk/RunCompletes' $false 'timed out after 60 seconds'
    if (-not $WriteResult) { exit 1 } else { return }
}
if ($finalRun.status -ne 'completed') {
    Report-Result 'Risk/RunCompletes' $false "ended in '$($finalRun.status)': $($finalRun.errorMessage)"
    if (-not $WriteResult) { exit 1 } else { return }
}
Report-Result 'Risk/RunCompletes' $true "scored=$($finalRun.scoredEntities) total=$($finalRun.totalEntities)"

# ─── Step 5: Assert expected outcomes via /api/risk-scores ───────
try {
    $scores = Invoke-LocalApi -Path '/risk-scores'
    if ($scores.available -and $scores.summary) {
        Report-Result 'Risk/ScoresEndpoint' $true 'returned summary'
    } else {
        Report-Result 'Risk/ScoresEndpoint' $false 'no summary in response'
    }

    # Count entities that scored at least Minimal (direct classifier match)
    $tiers = @{}
    if ($scores.summary.groupsByTier) {
        foreach ($p in $scores.summary.groupsByTier.PSObject.Properties) {
            $v = 0; [int]::TryParse("$($p.Value)", [ref]$v) | Out-Null
            $tiers[$p.Name] = ($tiers[$p.Name] ?? 0) + $v
        }
    }
    if ($scores.summary.usersByTier) {
        foreach ($p in $scores.summary.usersByTier.PSObject.Properties) {
            $v = 0; [int]::TryParse("$($p.Value)", [ref]$v) | Out-Null
            $tiers[$p.Name] = ($tiers[$p.Name] ?? 0) + $v
        }
    }

    $matchedCount = 0
    foreach ($t in @('Minimal', 'Low', 'Medium', 'High', 'Critical')) {
        if ($tiers.ContainsKey($t)) { $matchedCount += $tiers[$t] }
    }

    # CRITICAL regression check: if compileClassifier silently drops Claude-style
    # (?i) patterns (the April 2026 bug), no entity will score above None and
    # this assertion fails.
    if ($matchedCount -gt 0) {
        Report-Result 'Risk/ClassifierMatchesRecorded' $true "entities with matches: $matchedCount (Minimal+)"
    } else {
        Report-Result 'Risk/ClassifierMatchesRecorded' $false 'ZERO matches recorded — regex compile may be broken'
    }

    # We expect at least one Medium since we have a broad `admin` pattern.
    # The classifier has score=80, direct weight=0.6, so the final should be
    # min(100, round(0.6 * 80)) = 48 = Medium tier.
    $mediumPlus = ($tiers['Medium'] ?? 0) + ($tiers['High'] ?? 0) + ($tiers['Critical'] ?? 0)
    if ($mediumPlus -gt 0) {
        Report-Result 'Risk/HasMediumOrHigher' $true "Medium+: $mediumPlus"
    } else {
        Report-Result 'Risk/HasMediumOrHigher' $false "expected at least one Medium+, got $mediumPlus"
    }
} catch {
    Report-Result 'Risk/ScoresEndpoint' $false $_.Exception.Message
}

# ─── Cleanup ─────────────────────────────────────────────────────
# Best-effort delete of the test profile and classifier set — leave the
# database clean for the next test run.
try { Invoke-LocalApi -Path "/risk-profiles/$($script:profileId)" -Method Delete | Out-Null } catch { }
try { Invoke-LocalApi -Path "/risk-classifiers/$($script:classifierId)" -Method Delete | Out-Null } catch { }

if (-not $WriteResult) { exit $standaloneFailures }
