#Requires -Version 7
<#
.SYNOPSIS
    Starts the Identity Atlas portable server and opens it in the default browser.

.DESCRIPTION
    Launches node.exe with bootstrap.mjs, waits for the API health endpoint to
    respond (up to 90 seconds), then opens http://localhost:3001 in the browser.

    Run with:
        pwsh -ExecutionPolicy Bypass -File .\Start-IdentityAtlas.ps1
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$NodeExe   = Join-Path $ScriptDir 'node.exe'
$Bootstrap = Join-Path $ScriptDir 'bootstrap.mjs'
$Port      = 3001
$HealthUrl = "http://localhost:$Port/api/health"
$TimeoutSec = 90

Write-Host "Starting Identity Atlas..."

$proc = Start-Process -FilePath $NodeExe `
    -ArgumentList $Bootstrap `
    -WorkingDirectory $ScriptDir `
    -PassThru `
    -WindowStyle Hidden

Write-Host "Server process started (PID $($proc.Id)), waiting for health check..."

$deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
$ready    = $false
while ([DateTime]::Now -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch { <# not ready yet #> }
}

if (-not $ready) {
    Write-Error "Identity Atlas did not start within $TimeoutSec seconds. Check console output for errors."
    exit 1
}

Write-Host "Identity Atlas is ready. Opening browser..."
Start-Process "http://localhost:$Port"
