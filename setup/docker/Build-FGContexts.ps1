<#
.SYNOPSIS
    Refresh derived OrgUnit contexts after a sync (v5).

.DESCRIPTION
    The worker has no direct database access in v5. Context calculation lives
    in `POST /api/admin/refresh-contexts` (app/api/src/routes/admin.js). This
    script just calls that endpoint with the built-in worker API key.

    The endpoint reads `Principals` and rebuilds the `Contexts` table from
    department information. Idempotent — safe to call after every sync.
#>

# WEB_API_URL is what the worker, the dispatcher and the desktop launcher set.
# API_BASE_URL is still honoured for anyone who configured the old name.
$ApiBaseUrl = if ($env:WEB_API_URL) { $env:WEB_API_URL } elseif ($env:API_BASE_URL) { $env:API_BASE_URL } else { 'http://web:3001/api' }
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

# Same override the scheduler uses for the key file location.
$keyFile = if ($env:WORKER_KEY_FILE) { $env:WORKER_KEY_FILE } else { '/data/uploads/.builtin-worker-key' }
if (-not (Test-Path $keyFile)) {
    Write-Host '  Build-FGContexts: built-in worker key file not found — skipping' -ForegroundColor Yellow
    return
}

$apiKey = (Get-Content $keyFile -Raw).Trim()
if (-not $apiKey) {
    Write-Host '  Build-FGContexts: empty key file — skipping' -ForegroundColor Yellow
    return
}

try {
    $headers = @{ 'Authorization' = "Bearer $apiKey"; 'Content-Type' = 'application/json' }
    $resp = Invoke-RestMethod -Method Post -Uri "$ApiBaseUrl/ingest/refresh-contexts" -Headers $headers -Body '{}' -TimeoutSec 60
    Write-Host "  Contexts refreshed: $($resp.contextsCreated) row(s) in $($resp.durationMs)ms" -ForegroundColor Green
}
catch {
    Write-Host "  Build-FGContexts: refresh failed: $($_.Exception.Message)" -ForegroundColor Yellow
}
