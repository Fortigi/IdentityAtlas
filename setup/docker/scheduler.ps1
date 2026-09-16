<#
.SYNOPSIS
    PowerShell scheduler / job runner for the Identity Atlas worker container.

.DESCRIPTION
    In v5 (postgres) the worker has NO direct database access. Everything goes
    through the REST API:

      1. Discover the built-in crawler API key from the shared volume file
         /data/uploads/.builtin-worker-key (written by the web container's
         bootstrap routine)
      2. Poll /api/crawlers/jobs/claim every 30s to pick up queued jobs
         atomically
      3. Run the job in its own pwsh process (Invoke-CrawlerJobProcess.ps1 →
         Invoke-CrawlerJob.ps1), so no credential or token outlives its job
      4. Mark complete via /api/crawlers/jobs/:id/complete (or .../fail)

    Scheduling lives in the API (scheduler.js); the worker only runs claimed jobs.

    The container stays alive for ad-hoc commands:
        docker exec -it identityatlas-worker-1 pwsh
#>

$ErrorActionPreference = 'Continue'

. (Join-Path $PSScriptRoot 'Invoke-CrawlerJobProcess.ps1')

$ApiBaseUrl = $env:WEB_API_URL
if (-not $ApiBaseUrl) { $ApiBaseUrl = 'http://web:3001/api' }
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

$WorkerKeyFile = $env:WORKER_KEY_FILE
if (-not $WorkerKeyFile) { $WorkerKeyFile = '/data/uploads/.builtin-worker-key' }

Write-Host "Identity Atlas Worker Container (v5)" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan
Write-Host "  API URL: $ApiBaseUrl"               -ForegroundColor Gray
Write-Host "  Time:    $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss UTC')" -ForegroundColor Gray
Write-Host ""

# The image runs as uid 1000; repair a job trace directory an older root worker
# left behind on the shared volume, so job logs keep being written.
. (Join-Path $PSScriptRoot 'WorkerVolume.ps1')
$null = Repair-WorkerTraceDirectory -TraceDir $(if ($env:TRACE_DIR) { $env:TRACE_DIR } else { '/data/uploads/jobs' })

# Pre-load the module so it's ready for any job
try {
    Import-Module /app/setup/IdentityAtlas.psd1 -Force
    Write-Host "  Module loaded successfully" -ForegroundColor Green
} catch {
    Write-Host "  Module load failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

# Resolve this worker's version so it can report it to the API on every poll
# (the web container has no way to know the worker's version otherwise — it's
# what powers web/worker skew detection on Admin → Updates). Prefer a baked env
# var if a published image ever sets one; fall back to the imported module's
# ModuleVersion (from setup/IdentityAtlas.psd1, bumped at build time — the same
# source the web container's version.js falls back to).
function Get-WorkerVersion {
    $v = $env:MODULE_VERSION
    if (-not $v) {
        try {
            $mod = Get-Module IdentityAtlas
            if ($mod) { $v = $mod.Version.ToString() }
        } catch { }
    }
    if ($v) { Write-Host "  Worker version: $v" -ForegroundColor Gray }
    return $v
}
$Global:WorkerVersion = Get-WorkerVersion

# ── Discover the built-in API key ─────────────────────────────────────────────
# Read priority: env var → shared volume file. Startup polls for 5 minutes so
# the common case (volume mount missing) surfaces a loud warning quickly. If
# the key still isn't there after that, the main loop keeps re-checking on
# every tick — the queue self-heals once web's bootstrap eventually writes it.

function Get-BuiltinApiKey {
    if (-not (Test-Path $WorkerKeyFile)) { return $null }
    try {
        $key = (Get-Content $WorkerKeyFile -Raw -ErrorAction Stop).Trim()
        if ($key) { return $key }
    } catch { }
    return $null
}

# Resolve the key at startup: env var wins; otherwise poll the volume file for
# up to 5 minutes, then warn and let the main loop keep retrying. Sets the
# $Global:BuiltinApiKey the poller reads.
function Initialize-BuiltinApiKey {
    if ($env:CRAWLER_API_KEY) {
        $Global:BuiltinApiKey = $env:CRAWLER_API_KEY
        Write-Host "  API key: from environment variable" -ForegroundColor Green
        return
    }

    Write-Host "  Discovering API key from $WorkerKeyFile..." -ForegroundColor Gray
    for ($i = 0; $i -lt 60; $i++) {
        $key = Get-BuiltinApiKey
        if ($key) {
            $Global:BuiltinApiKey = $key
            Write-Host "  API key: discovered (prefix: $($key.Substring(0, [Math]::Min(8, $key.Length))))" -ForegroundColor Green
            break
        }
        if ($i -lt 59) { Start-Sleep -Seconds 5 }
    }
    if (-not $Global:BuiltinApiKey) {
        Write-Host "  API key: not found after 5 minutes — will keep retrying on every poll tick." -ForegroundColor Yellow
        Write-Host "           Check that web's bootstrap completed (it writes the key file) and that the" -ForegroundColor Yellow
        Write-Host "           job_data volume is shared between web and worker." -ForegroundColor Yellow
    }
}

$Global:BuiltinApiKey = $null
Initialize-BuiltinApiKey

# ── Job queue poller ──────────────────────────────────────────────────────────

function Invoke-PendingJob {
    # Self-heal: if the key wasn't there at startup (web bootstrap slow, volume
    # populated late, master key fixed and web restarted, etc.) keep checking
    # the volume file. Once it shows up the queue starts running on the next tick.
    if (-not $Global:BuiltinApiKey) {
        $key = Get-BuiltinApiKey
        if ($key) {
            $Global:BuiltinApiKey = $key
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] API key: discovered late (prefix: $($key.Substring(0, [Math]::Min(8, $key.Length)))) — job queue resuming" -ForegroundColor Green
        }
    }
    if (-not $Global:BuiltinApiKey) { return }

    $headers = @{ 'Authorization' = "Bearer $Global:BuiltinApiKey" }
    # Report the worker's version on every poll (~30s) so the API can detect
    # web/worker version skew after a partial update. Best-effort — the header is
    # simply absent if the version couldn't be resolved.
    if ($Global:WorkerVersion) { $headers['X-Worker-Version'] = $Global:WorkerVersion }

    # 1. Atomically claim next job
    $resp = $null
    try {
        $resp = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/jobs/claim" `
            -Method Post -Headers $headers -TimeoutSec 10 -ErrorAction Stop
    } catch {
        return
    }
    if (-not $resp -or -not $resp.job) { return }

    $job = $resp.job
    $jobId = $job.id
    $jobType = $job.jobType
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Job $jobId ($jobType): starting..." -ForegroundColor Cyan

    # Parse config. The crawler dispatcher uses .ContainsKey() on hashtables,
    # so we need a *recursive* conversion — top-level object → hashtable AND
    # all nested objects → hashtables. Re-serialising to JSON and parsing with
    # -AsHashtable is the simplest path that handles every shape Invoke-RestMethod
    # might produce.
    $config = @{}
    if ($job.config) {
        try {
            $config = ($job.config | ConvertTo-Json -Depth 100 -Compress) | ConvertFrom-Json -AsHashtable
        } catch {
            Write-Host "  Warning: failed to parse job config — $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    # 2. Run the job in its own process (credentials never outlive the job)
    try {
        Invoke-CrawlerJobProcess -JobId $jobId -JobType $jobType -Config $config `
            -ApiKey $Global:BuiltinApiKey -DispatcherPath (Join-Path $PSScriptRoot 'Invoke-CrawlerJob.ps1')

        # 3. Mark complete
        try {
            Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/jobs/$jobId/complete" `
                -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' `
                -TimeoutSec 10 | Out-Null
        } catch {
            Write-Host "  Warning: failed to mark complete: $($_.Exception.Message)" -ForegroundColor Yellow
        }
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Job $jobId ($jobType): completed" -ForegroundColor Green
    } catch {
        $errMsg = $_.Exception.Message
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Job $jobId ($jobType): FAILED — $errMsg" -ForegroundColor Red
        try {
            $body = @{ errorMessage = $errMsg } | ConvertTo-Json -Compress
            Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/jobs/$jobId/fail" `
                -Method Post -Headers $headers -Body $body -ContentType 'application/json' `
                -TimeoutSec 10 | Out-Null
        } catch { }
    }
}

# ── Main loop ─────────────────────────────────────────────────────────────────

# The job queue is polled every 30s. Runs forever.
function Start-SchedulerLoop {
    while ($true) {
        Invoke-PendingJob
        Start-Sleep -Seconds 30
    }
}

Start-SchedulerLoop
