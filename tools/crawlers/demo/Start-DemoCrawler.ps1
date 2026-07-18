<#
.SYNOPSIS
    Demo dataset crawler — loads the built-in demo company dataset into Identity Atlas.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL.

.PARAMETER ApiKey
    Built-in crawler API key.

.PARAMETER JobId
    Job ID for progress reporting.

.PARAMETER ConfigPath
    Path to a temporary JSON file containing the crawler configuration (unused for demo).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [string]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

$appRoot     = if ($env:IA_APP_ROOT) { $env:IA_APP_ROOT.TrimEnd('/\') } else { '/app' }
$datasetPath = "$appRoot/test/demo-dataset/demo-company.json"
$ingestScript = "$appRoot/test/demo-dataset/Ingest-DemoDataset.ps1"

function Update-DemoProgress {
    param([string]$Step, [int]$Pct = 0)
    try {
        $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $body = @{ jobId = $JobId; step = $Step; pct = $Pct; detail = '' } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post -Headers $headers -Body $body -TimeoutSec 10 | Out-Null
    } catch {
        Write-Host "  Warning: failed to update progress — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Update-DemoProgress -Step 'Loading demo dataset' -Pct 10

# The demo dataset is a gitignored build artifact whose shape tracks the ingest
# script (e.g. metadata.systemKeys, which Ingest-DemoDataset.ps1 indexes to map
# placeholder system ids). A bundled or older on-disk copy can therefore be
# STALE — present but in an out-of-date format — which crashes the ingest with
# "Cannot index into a null array" and leaves a fresh Docker install with only a
# handful of systems loaded. So always regenerate from the deterministic
# generator (same GUIDs every run) so the dataset matches this build's ingest
# format; only fall back to an existing file when the generator isn't shipped.
$genScript = "$appRoot/test/demo-dataset/Generate-DemoDataset.ps1"
if (Test-Path $genScript) {
    Update-DemoProgress -Step 'Generating demo dataset' -Pct 5
    & $genScript -OutputPath $datasetPath
} elseif (-not (Test-Path $datasetPath)) {
    throw "Demo dataset not found at $datasetPath and generator not available"
}

Update-DemoProgress -Step 'Ingesting demo data' -Pct 30

& $ingestScript -ApiBaseUrl $ApiBaseUrl -ApiKey $ApiKey -DatasetPath $datasetPath

Update-DemoProgress -Step 'Refreshing views' -Pct 90

try {
    $headers = @{ 'Authorization' = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post -Headers $headers -Body '{}' -ErrorAction SilentlyContinue
} catch {}

Update-DemoProgress -Step 'Complete' -Pct 100
Write-Host "  Demo data loaded successfully" -ForegroundColor Green
