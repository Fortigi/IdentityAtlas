<#
.SYNOPSIS
    Dispatches a CrawlerJob to the appropriate crawler script.

.DESCRIPTION
    Called by the scheduler when a job is picked up from CrawlerJobs.
    Dispatches based on jobType using the crawler manifest registry
    (built at module load by Get-CrawlerRegistry in IdentityAtlas.psm1).

    Each crawler lives in tools/crawlers/<type>/ with a crawler.json manifest.
    Adding a new crawler requires no changes here — drop in the folder and restart.

.PARAMETER JobId
    The CrawlerJobs.id for progress reporting.

.PARAMETER JobType
    The crawler type key (matches the "type" field in crawler.json).

.PARAMETER Config
    Hashtable parsed from the job's config JSON column, or a JSON string. Only for
    in-process callers: the config holds decrypted credentials, so a separate
    process must never receive it on its command line — use -ConfigFromStdin.

.PARAMETER ApiKey
    The crawler API key, for in-process callers. A separate process receives it
    through the IA_JOB_API_KEY environment variable instead, never as an argument.

.PARAMETER ConfigFromStdin
    Read the job config JSON from standard input (the worker and the desktop
    launcher run each job as its own pwsh process this way).

.PARAMETER ResultPath
    Optional file the failure message is written to, so the parent process can
    report why the job failed.
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)]
    [int]$JobId,

    [Parameter(Mandatory)]
    [string]$JobType,

    [Parameter(Mandatory = $false)]
    $Config = @{},

    [Parameter(Mandatory = $false)]
    [string]$ApiKey,

    [switch]$ConfigFromStdin,

    [string]$ResultPath
)

$ErrorActionPreference = 'Stop'

# The API key: an explicit -ApiKey (in-process caller) or the IA_JOB_API_KEY
# environment variable (child process). The variable is removed once read so
# nothing the crawler starts inherits it. (SEC-2026-09 L-06)
function Resolve-JobApiKey {
    param([string]$ApiKey)
    $fromEnv = $env:IA_JOB_API_KEY
    Remove-Item Env:IA_JOB_API_KEY -ErrorAction SilentlyContinue
    if ($ApiKey) { return $ApiKey }
    if ($fromEnv) { return $fromEnv }
    throw 'No crawler API key: pass -ApiKey or set IA_JOB_API_KEY'
}

# The job config from standard input (child process) — never from the command line.
function Read-JobConfigInput {
    param([System.IO.TextReader]$Reader = [Console]::In)
    return $Reader.ReadToEnd()
}

# The job config as a hashtable: from stdin when -ConfigFromStdin, else -Config.
function Resolve-JobConfig {
    param($Config, [bool]$FromStdin)
    if ($FromStdin) { $Config = Read-JobConfigInput }
    return (ConvertTo-JobConfigHashtable -Config $Config)
}

# Hand the failure message to the parent process when it asked for one.
function Write-JobFailureResult {
    param([string]$ResultPath, [string]$Message)
    if (-not $ResultPath) { return }
    Set-Content -Path $ResultPath -Value $Message -Encoding UTF8 -ErrorAction SilentlyContinue
}

# Accept Config as either a hashtable (scheduler) or a JSON string (desktop worker).
function ConvertTo-JobConfigHashtable {
    param($Config)
    if ($Config -isnot [string]) { return $Config }
    if ($Config -and $Config -ne '{}') {
        return ($Config | ConvertFrom-Json -AsHashtable)
    }
    return @{}
}

function Update-JobProgress {
    param([string]$Step, [int]$Pct = 0, [string]$Detail = '')
    try {
        $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $body = @{ jobId = $JobId; step = $Step; pct = $Pct; detail = $Detail } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$apiBaseUrl/crawlers/job-progress" -Method Post -Headers $headers -Body $body -TimeoutSec 10 | Out-Null
    }
    catch {
        Write-Host "  Warning: failed to update progress — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Set-JobResult {
    param([hashtable]$Result)
    Write-Host "  Job result: $($Result | ConvertTo-Json -Compress)" -ForegroundColor Gray
}

# ─── DFS dependency resolver ─────────────────────────────────────────────────
# Returns a list of crawler types in topological order (dependencies first).
# Throws a clear error when a circular dependency is detected.
function Resolve-CrawlerDependencies {
    param([string]$Type, [hashtable]$Registry)

    $result     = [System.Collections.Generic.List[string]]::new()
    $inProgress = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $done       = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    function Visit ([string]$T, [string[]]$CallPath) {
        if ($done.Contains($T)) { return }
        if (-not $inProgress.Add($T)) {
            throw "Circular crawler dependency: $(($CallPath + $T) -join ' → ')"
        }
        if (-not $Registry.ContainsKey($T)) {
            $from = if ($CallPath) { " (required by: $($CallPath[-1]))" } else { '' }
            throw "Crawler dependency '$T' not found in registry$from"
        }
        $deps = $Registry[$T].Manifest['dependsOn']
        if ($deps) {
            foreach ($dep in $deps) { Visit $dep ($CallPath + $T) }
        }
        [void]$inProgress.Remove($T)
        [void]$done.Add($T)
        [void]$result.Add($T)
    }

    Visit $Type @()
    return $result
}

# ─── Per-job trace log helpers ────────────────────────────────────────────────
function Start-JobTranscript {
    param([string]$TraceDir, [string]$TraceFile)
    try {
        New-Item -ItemType Directory -Path $TraceDir -Force -ErrorAction SilentlyContinue | Out-Null
        # Minimal header: the full header records the host command line, which must
        # never carry job credentials into a log that the API serves. (SEC-2026-09 L-06)
        Start-Transcript -Path $TraceFile -Force -UseMinimalHeader | Out-Null
        return $true
    } catch {
        Write-Host "  (trace: failed to start transcript: $($_.Exception.Message))" -ForegroundColor Yellow
        return $false
    }
}

function Stop-JobTranscript {
    param([bool]$Started)
    if (-not $Started) { return }
    try { Stop-Transcript | Out-Null } catch {}
}

function Remove-OldTraceLogs {
    param([string]$TraceDir, [int]$Keep = 20)
    try {
        $all = Get-ChildItem -Path $TraceDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
            Sort-Object -Property LastWriteTime -Descending
        if ($all -and $all.Count -gt $Keep) {
            $all | Select-Object -Skip $Keep | Remove-Item -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

# ─── Module bootstrap ─────────────────────────────────────────────────────────
# Both the Docker scheduler and the desktop worker start a fresh pwsh per job, so
# the module is normally imported here; an in-process caller may have loaded it.
function Import-IdentityAtlasModule {
    param([string]$AppRoot)
    if (Get-Command Get-CrawlerRegistry -ErrorAction SilentlyContinue) { return }
    $modulePsd1 = Join-Path $AppRoot 'setup' 'IdentityAtlas.psd1'
    if (-not (Test-Path $modulePsd1)) {
        throw "IdentityAtlas module not found at '$modulePsd1'. Is IA_APP_ROOT set correctly?"
    }
    Import-Module $modulePsd1 -Force
}

# ─── Registry lookup + entry point resolution ─────────────────────────────────
function Resolve-CrawlerEntryPoint {
    param([hashtable]$Registry, [string]$JobType)
    if (-not $Registry.ContainsKey($JobType)) {
        $available = ($Registry.Keys | Sort-Object) -join ', '
        throw "Unknown job type: '$JobType'. Available: $available"
    }

    $entry      = $Registry[$JobType]
    $manifest   = $entry.Manifest
    $entryPoint = $manifest['entryPoint']

    if (-not $entryPoint) { throw "crawler.json for '$JobType' is missing 'entryPoint'" }
    $entryPointPath = Join-Path $entry.Dir $entryPoint
    if (-not (Test-Path $entryPointPath)) {
        throw "Crawler entry point not found: $entryPointPath"
    }

    return [pscustomobject]@{
        Manifest       = $manifest
        EntryPointPath = $entryPointPath
    }
}

# ─── Post-sync hooks ──────────────────────────────────────────────────────────
function Invoke-BuildContextsHook {
    param([string]$AppRoot)
    Update-JobProgress -Step 'Building contexts from principal data' -Pct 80
    try {
        & "$AppRoot/setup/docker/Build-FGContexts.ps1"
    } catch {
        Write-Host "  Context build failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Invoke-AccountCorrelationHook {
    Update-JobProgress -Step 'Linking accounts to identities' -Pct 90
    try {
        if (Get-Command Invoke-FGAccountCorrelation -ErrorAction SilentlyContinue) {
            Invoke-FGAccountCorrelation
        } else {
            Write-Host "  Invoke-FGAccountCorrelation not available — skipping" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  Account correlation failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Invoke-CrawlerPostSyncHooks {
    param($Hooks, [string]$AppRoot)
    if (-not $Hooks) { return }
    foreach ($hook in $Hooks) {
        switch ($hook) {
            'buildContexts'      { Invoke-BuildContextsHook -AppRoot $AppRoot }
            'accountCorrelation' { Invoke-AccountCorrelationHook }
            default              { Write-Host "  Unknown post-sync hook: '$hook' — skipping" -ForegroundColor Yellow }
        }
    }
}

# ─── Matrix view refresh ──────────────────────────────────────────────────────
# Crawlers ask the API for a matrix-view refresh at the end of a sync, and the API
# now runs it in the background (app/api/src/ingest/viewRefresh.js) instead of
# inside a request that timed out and was retried. The job waits for it here and
# reports what actually happened: a failed refresh fails the job, instead of being
# logged as "non-critical" while the job said success.
function Get-MatrixViewRefreshStatus {
    param([string]$ApiBaseUrl, [string]$ApiKey)
    try {
        return Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Get `
            -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 30
    } catch {
        return $null   # an API without the status endpoint: nothing to wait for
    }
}

function Wait-MatrixViewRefresh {
    param(
        [string]$ApiBaseUrl,
        [string]$ApiKey,
        $Before,
        [int]$TimeoutSeconds = 7200,
        [int]$PollSeconds = 10
    )
    if ($null -eq $Before) { return }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $status = Get-MatrixViewRefreshStatus -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey
    while ($status -and $status.pending) {
        if ((Get-Date) -gt $deadline) {
            throw "Data loaded, but the matrix views were still refreshing after $TimeoutSeconds s — the matrix may show the previous data until it finishes"
        }
        Update-JobProgress -Step "Refreshing matrix views ($($status.state))" -Pct 95
        Start-Sleep -Seconds $PollSeconds
        $status = Get-MatrixViewRefreshStatus -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey
    }
    if (-not $status -or $status.runs -le $Before.runs -or -not $status.last) { return }
    $seconds = [Math]::Round($status.last.durationMs / 1000)
    if (-not $status.last.ok) {
        throw "Data loaded, but the matrix view refresh failed after $seconds s: $($status.last.error)"
    }
    Write-Host "  Matrix views refreshed in $seconds s" -ForegroundColor Green
}

# ─── Job dispatch ─────────────────────────────────────────────────────────────
$apiBaseUrl = $env:WEB_API_URL
if (-not $apiBaseUrl) { $apiBaseUrl = 'http://web:3001/api' }
$apiBaseUrl = $apiBaseUrl.TrimEnd('/')

# ─── Per-job trace log ────────────────────────────────────────────────────────
$traceDir  = if ($env:TRACE_DIR) { $env:TRACE_DIR } else { '/data/uploads/jobs' }
$traceFile = Join-Path $traceDir "$JobId.log"
$transcriptStarted = Start-JobTranscript -TraceDir $traceDir -TraceFile $traceFile
Remove-OldTraceLogs -TraceDir $traceDir -Keep 20

$appRoot = if ($env:IA_APP_ROOT) { $env:IA_APP_ROOT.TrimEnd('/\') } else { '/app' }

try {
    $ApiKey = Resolve-JobApiKey -ApiKey $ApiKey
    $Config = Resolve-JobConfig -Config $Config -FromStdin $ConfigFromStdin.IsPresent

    # ─── Module bootstrap ─────────────────────────────────────────────────────
    Import-IdentityAtlasModule -AppRoot $appRoot

    # ─── Registry lookup ──────────────────────────────────────────────────────
    $registry = Get-CrawlerRegistry
    $entryInfo      = Resolve-CrawlerEntryPoint -Registry $registry -JobType $JobType
    $manifest       = $entryInfo.Manifest
    $entryPointPath = $entryInfo.EntryPointPath

    # ─── Load dependencies + crawler code ─────────────────────────────────────
    $resolved = Resolve-CrawlerDependencies -Type $JobType -Registry $registry
    foreach ($layer in $resolved) {
        $layerDir        = $registry[$layer].Dir
        $layerEntryPoint = $registry[$layer].Manifest['entryPoint']
        # Dot-source the crawler's library files, but never the entry point, tests, or anything under
        # a `dev/` subfolder (load-test seeders, parity harnesses) — those are standalone scripts with
        # their own Param() blocks; dot-sourcing one would bind/prompt for its mandatory parameters and
        # abort the job. This matches the documented contract that nothing in dev/ runs at runtime.
        Get-ChildItem -Path $layerDir -Include '*.ps1' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne $layerEntryPoint -and $_.Name -notlike 'Test-*.ps1' -and $_.FullName -notmatch '[\\/]dev[\\/]' } |
            ForEach-Object { . $_.FullName }
    }

    # ─── Write config + invoke crawler ────────────────────────────────────────
    $configPath = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.json'
    try {
        $Config | ConvertTo-Json -Depth 20 -Compress | Set-Content $configPath -Encoding UTF8

        $displayName = if ($manifest['displayName']) { $manifest['displayName'] } else { $JobType }
        $refreshBefore = Get-MatrixViewRefreshStatus -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey
        Update-JobProgress -Step "Running $displayName crawler" -Pct 10

        & $entryPointPath -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey -JobId $JobId -ConfigPath $configPath

    } finally {
        Remove-Item $configPath -Force -ErrorAction SilentlyContinue
    }

    # ─── Post-sync hooks ──────────────────────────────────────────────────────
    Invoke-CrawlerPostSyncHooks -Hooks $manifest['postSyncHooks'] -AppRoot $appRoot
    Wait-MatrixViewRefresh -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey -Before $refreshBefore

    Update-JobProgress -Step 'Complete' -Pct 100
    Set-JobResult @{ status = "$displayName completed successfully" }

} catch {
    Write-JobFailureResult -ResultPath $ResultPath -Message $_.Exception.Message
    throw
} finally {
    Stop-JobTranscript -Started $transcriptStarted
}
