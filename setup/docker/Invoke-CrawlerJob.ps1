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
    Hashtable parsed from the job's config JSON column, or a JSON string
    (accepted for compatibility with the desktop worker which passes JSON directly).

.PARAMETER ApiKey
    The built-in crawler API key.
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)]
    [int]$JobId,

    [Parameter(Mandatory)]
    [string]$JobType,

    [Parameter(Mandatory = $false)]
    $Config = @{},

    [Parameter(Mandatory)]
    [string]$ApiKey
)

$ErrorActionPreference = 'Stop'

# Accept Config as either a hashtable (scheduler) or a JSON string (desktop worker).
if ($Config -is [string]) {
    $Config = if ($Config -and $Config -ne '{}') {
        $Config | ConvertFrom-Json -AsHashtable
    } else { @{} }
}

$apiBaseUrl = $env:WEB_API_URL
if (-not $apiBaseUrl) { $apiBaseUrl = 'http://web:3001/api' }
$apiBaseUrl = $apiBaseUrl.TrimEnd('/')

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

# ─── Per-job trace log ────────────────────────────────────────────────────────
$traceDir  = if ($env:TRACE_DIR) { $env:TRACE_DIR } else { '/data/uploads/jobs' }
$traceFile = Join-Path $traceDir "$JobId.log"
$transcriptStarted = $false
try {
    New-Item -ItemType Directory -Path $traceDir -Force -ErrorAction SilentlyContinue | Out-Null
    Start-Transcript -Path $traceFile -Force | Out-Null
    $transcriptStarted = $true
} catch {
    Write-Host "  (trace: failed to start transcript: $($_.Exception.Message))" -ForegroundColor Yellow
}

try {
    $keep = 20
    $all = Get-ChildItem -Path $traceDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending
    if ($all -and $all.Count -gt $keep) {
        $all | Select-Object -Skip $keep | Remove-Item -Force -ErrorAction SilentlyContinue
    }
} catch {}

$appRoot = if ($env:IA_APP_ROOT) { $env:IA_APP_ROOT.TrimEnd('/\') } else { '/app' }

try {

    # ─── Module bootstrap ─────────────────────────────────────────────────────
    # Desktop worker spawns a fresh pwsh with no module pre-loaded; Docker's
    # scheduler.ps1 imports the module in the same process before calling here.
    if (-not (Get-Command Get-CrawlerRegistry -ErrorAction SilentlyContinue)) {
        $modulePsd1 = Join-Path $appRoot 'setup' 'IdentityAtlas.psd1'
        if (-not (Test-Path $modulePsd1)) {
            throw "IdentityAtlas module not found at '$modulePsd1'. Is IA_APP_ROOT set correctly?"
        }
        Import-Module $modulePsd1 -Force
    }

    # ─── Registry lookup ──────────────────────────────────────────────────────
    $registry = Get-CrawlerRegistry
    if (-not $registry.ContainsKey($JobType)) {
        $available = ($registry.Keys | Sort-Object) -join ', '
        throw "Unknown job type: '$JobType'. Available: $available"
    }

    $entry      = $registry[$JobType]
    $manifest   = $entry.Manifest
    $crawlerDir = $entry.Dir
    $entryPoint = $manifest['entryPoint']

    if (-not $entryPoint) { throw "crawler.json for '$JobType' is missing 'entryPoint'" }
    $entryPointPath = Join-Path $crawlerDir $entryPoint
    if (-not (Test-Path $entryPointPath)) {
        throw "Crawler entry point not found: $entryPointPath"
    }

    # ─── Load dependencies + crawler code ─────────────────────────────────────
    $resolved = Resolve-CrawlerDependencies -Type $JobType -Registry $registry
    foreach ($layer in $resolved) {
        $layerDir        = $registry[$layer].Dir
        $layerEntryPoint = $registry[$layer].Manifest['entryPoint']
        Get-ChildItem -Path $layerDir -Include '*.ps1' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne $layerEntryPoint -and $_.Name -notlike 'Test-*.ps1' } |
            ForEach-Object { . $_.FullName }
    }

    # ─── Write config + invoke crawler ────────────────────────────────────────
    $configPath = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.json'
    try {
        $Config | ConvertTo-Json -Depth 20 -Compress | Set-Content $configPath -Encoding UTF8

        $displayName = if ($manifest['displayName']) { $manifest['displayName'] } else { $JobType }
        Update-JobProgress -Step "Running $displayName crawler" -Pct 10

        & $entryPointPath -ApiBaseUrl $apiBaseUrl -ApiKey $ApiKey -JobId $JobId -ConfigPath $configPath

    } finally {
        Remove-Item $configPath -Force -ErrorAction SilentlyContinue
    }

    # ─── Post-sync hooks ──────────────────────────────────────────────────────
    $hooks = $manifest['postSyncHooks']
    if ($hooks) {
        foreach ($hook in $hooks) {
            switch ($hook) {
                'buildContexts' {
                    Update-JobProgress -Step 'Building contexts from principal data' -Pct 80
                    try {
                        & "$appRoot/setup/docker/Build-FGContexts.ps1"
                    } catch {
                        Write-Host "  Context build failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
                    }
                }
                'accountCorrelation' {
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
                default {
                    Write-Host "  Unknown post-sync hook: '$hook' — skipping" -ForegroundColor Yellow
                }
            }
        }
    }

    Update-JobProgress -Step 'Complete' -Pct 100
    Set-JobResult @{ status = "$displayName completed successfully" }

} finally {
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch {}
    }
}
