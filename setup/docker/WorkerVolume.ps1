<#
.SYNOPSIS
    Startup repair of the job trace directory for the non-root worker (SEC-2026-09 M-14).

.DESCRIPTION
    Worker images before this change ran as root, so on an existing Docker volume the
    per-job trace directory (/data/uploads/jobs) is owned by root and the worker, now
    uid 1000, can no longer write job logs into it. The parent volume is owned by uid
    1000 (the web container's `node` user), so the directory can be renamed out of the
    way and recreated. The existing *.log files are copied into the new directory so
    the job-log view keeps showing them. Nothing happens when the directory is
    writable or does not exist yet.

    Dot-sourced by scheduler.ps1.
#>

function Test-WorkerDirectoryWritable {
    param([Parameter(Mandatory)][string]$Path)
    $probe = Join-Path $Path ".write-probe-$([guid]::NewGuid().ToString('N'))"
    try {
        [System.IO.File]::WriteAllText($probe, '')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Repair-WorkerTraceDirectory {
    <#
    .OUTPUTS
        'absent' | 'ok' | 'repaired' | 'unwritable'
    #>
    param([Parameter(Mandatory)][string]$TraceDir)

    if (-not (Test-Path -LiteralPath $TraceDir -PathType Container)) { return 'absent' }
    if (Test-WorkerDirectoryWritable -Path $TraceDir) { return 'ok' }

    $staleName = '{0}.root-owned-{1}' -f (Split-Path $TraceDir -Leaf), (Get-Date -Format 'yyyyMMddHHmmss')
    $stalePath = Join-Path (Split-Path $TraceDir -Parent) $staleName
    try {
        Rename-Item -LiteralPath $TraceDir -NewName $staleName -ErrorAction Stop
        New-Item -ItemType Directory -Path $TraceDir -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "  Job trace directory $TraceDir is not writable and could not be repaired: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  Fix with: docker compose exec -u 0 worker chown -R 1000:1000 $TraceDir" -ForegroundColor Yellow
        return 'unwritable'
    }
    Get-ChildItem -LiteralPath $stalePath -Filter '*.log' -File -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $TraceDir -ErrorAction SilentlyContinue }
    Write-Host "  Job trace directory was not writable; recreated it (previous one kept as $staleName)" -ForegroundColor Yellow
    return 'repaired'
}
