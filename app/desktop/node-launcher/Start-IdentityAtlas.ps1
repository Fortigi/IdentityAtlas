#Requires -Version 7
<#
.SYNOPSIS
    Starts Identity Atlas using the bundled Node.js runtime.
.DESCRIPTION
    Launches node.exe bootstrap.mjs, waits for the API to become healthy,
    then opens the browser. Ctrl+C stops the app.
#>
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$nodeExe   = Join-Path $scriptDir 'node.exe'
$bootstrap = Join-Path $scriptDir 'bootstrap.mjs'

if (-not (Test-Path $nodeExe)) {
    Write-Error "node.exe not found in $scriptDir. The portable package may be incomplete."
    exit 1
}

Write-Host 'Starting Identity Atlas...' -ForegroundColor Cyan

$proc = Start-Process -FilePath $nodeExe `
    -ArgumentList $bootstrap `
    -WorkingDirectory $scriptDir `
    -NoNewWindow -PassThru

# Poll health endpoint — first run takes ~10s (PGlite init + migrations)
$timeout = [DateTime]::Now.AddSeconds(90)
$ready   = $false
while ([DateTime]::Now -lt $timeout) {
    try {
        $null = Invoke-WebRequest -Uri 'http://localhost:3001/api/health' `
            -UseBasicParsing -ErrorAction Stop
        $ready = $true
        break
    } catch {}
    Start-Sleep -Milliseconds 500
}

if (-not $ready) {
    $proc | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Error 'Identity Atlas did not become healthy within 90 seconds.'
    exit 1
}

Write-Host 'Identity Atlas is running at http://localhost:3001' -ForegroundColor Green
Start-Process 'http://localhost:3001'
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor Gray

try {
    $proc.WaitForExit()
} finally {
    if (-not $proc.HasExited) {
        $proc | Stop-Process -Force -ErrorAction SilentlyContinue
    }
}
