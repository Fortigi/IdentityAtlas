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
      3. Dispatch the job to Invoke-CrawlerJob.ps1 (passing the API key)
      4. Mark complete via /api/crawlers/jobs/:id/complete (or .../fail)

    Also runs a cron-style schedule from /app/setup/docker/crontab if present.

    The container stays alive for ad-hoc commands:
        docker exec -it identityatlas-worker-1 pwsh
#>

$ErrorActionPreference = 'Continue'

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

# Pre-load the module so it's ready for any job
try {
    Import-Module /app/setup/IdentityAtlas.psd1 -Force
    Write-Host "  Module loaded successfully" -ForegroundColor Green
} catch {
    Write-Host "  Module load failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ── Discover the built-in API key ─────────────────────────────────────────────
# Read priority: env var → shared volume file → poll until file appears.
$Global:BuiltinApiKey = $null
if ($env:CRAWLER_API_KEY) {
    $Global:BuiltinApiKey = $env:CRAWLER_API_KEY
    Write-Host "  API key: from environment variable" -ForegroundColor Green
} else {
    Write-Host "  Discovering API key from $WorkerKeyFile..." -ForegroundColor Gray
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-Path $WorkerKeyFile) {
            try {
                $key = (Get-Content $WorkerKeyFile -Raw -ErrorAction Stop).Trim()
                if ($key) {
                    $Global:BuiltinApiKey = $key
                    Write-Host "  API key: discovered (prefix: $($key.Substring(0, [Math]::Min(8, $key.Length))))" -ForegroundColor Green
                    break
                }
            } catch { }
        }
        if ($i -lt 59) { Start-Sleep -Seconds 5 }
    }
    if (-not $Global:BuiltinApiKey) {
        Write-Host "  API key: not found after 5 minutes (job queue will not work)" -ForegroundColor Yellow
    }
}

# ── Crontab parsing ───────────────────────────────────────────────────────────
$crontabPath = '/app/setup/docker/crontab'
$cronJobs = @()
if (Test-Path $crontabPath) {
    $lines = Get-Content $crontabPath | Where-Object { $_ -and $_ -notmatch '^\s*#' -and $_.Trim() -ne '' }
    foreach ($line in $lines) {
        $parts = $line.Trim() -split '\s+', 6
        if ($parts.Count -ge 6) {
            $cronJobs += @{
                Minute = $parts[0]; Hour = $parts[1]; DayOfMonth = $parts[2]
                Month = $parts[3]; DayOfWeek = $parts[4]; Command = $parts[5]
            }
        }
    }
    Write-Host "  Loaded $($cronJobs.Count) scheduled job(s) from crontab" -ForegroundColor Green
}
Write-Host ""

function Test-CronMatch {
    param([string]$CronValue, [int]$CurrentValue)
    if ($CronValue -eq '*') { return $true }
    return [int]$CronValue -eq $CurrentValue
}

# ── Job queue poller ──────────────────────────────────────────────────────────

function Invoke-PendingJob {
    if (-not $Global:BuiltinApiKey) { return }

    $headers = @{ 'Authorization' = "Bearer $Global:BuiltinApiKey" }

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

    # 2. Dispatch to job runner
    try {
        & /app/setup/docker/Invoke-CrawlerJob.ps1 `
            -JobId  $jobId `
            -JobType $jobType `
            -Config  $config `
            -ApiKey  $Global:BuiltinApiKey

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

$lastMinute = -1
while ($true) {
    $now = Get-Date

    # Cron tick — once per minute
    if ($now.Minute -ne $lastMinute) {
        $lastMinute = $now.Minute
        foreach ($cron in $cronJobs) {
            if ((Test-CronMatch $cron.Minute $now.Minute) -and
                (Test-CronMatch $cron.Hour $now.Hour) -and
                (Test-CronMatch $cron.DayOfMonth $now.Day) -and
                (Test-CronMatch $cron.Month $now.Month) -and
                (Test-CronMatch $cron.DayOfWeek ([int]$now.DayOfWeek))) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Cron: $($cron.Command)" -ForegroundColor Cyan
                try { Invoke-Expression $cron.Command }
                catch { Write-Host "  Cron job failed: $($_.Exception.Message)" -ForegroundColor Red }
            }
        }
    }

    # Job queue every loop
    Invoke-PendingJob

    Start-Sleep -Seconds 30
}
