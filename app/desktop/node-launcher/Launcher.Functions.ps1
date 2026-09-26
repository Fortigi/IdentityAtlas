# Functions for Start-IdentityAtlas.ps1 (the portable launcher). Dot-sourced;
# defines functions only, so test/unit/NodeLauncherPostgres.Tests.ps1 can load it.
#
# Two database modes:
#   PGlite   — PostgreSQL compiled to WebAssembly inside node.exe. Zero setup, but
#              capped at 4 GB of address space and a fixed 128 MB buffer pool.
#   Postgres — a real PostgreSQL started from the unpacked Windows binaries in
#              postgres\ (or -PostgresRoot), as the current user, on loopback.
# See docs/architecture/desktop-portable.md.

$script:DbName = 'identityatlas'
$script:DbUser = 'identityatlas'

# ── Locating and checking the PostgreSQL binaries ────────────────────────────

# The folder holding bin\pg_ctl.exe, or $null when there is none. An explicit
# -PostgresRoot that is wrong is an error, never a silent fall-back to PGlite.
function Resolve-PostgresRoot {
    param([string]$Override, [Parameter(Mandatory)][string]$ScriptDir)
    $candidate = if ($Override) { $Override } else { Join-Path $ScriptDir 'postgres' }
    if (Test-Path -LiteralPath (Join-Path $candidate 'bin' 'pg_ctl.exe')) {
        return (Resolve-Path -LiteralPath $candidate).Path
    }
    if ($Override) { throw "-PostgresRoot '$Override' does not contain bin\pg_ctl.exe." }
    return $null
}

# Quotes one argument for a Windows command line (Start-Process joins as-is).
function ConvertTo-CommandLineArgument([string]$Value) {
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

# Every call to a PostgreSQL executable goes through here, so tests mock one thing.
#
# -Detached is for `pg_ctl start`, and does two things:
#   • It does not capture output. pg_ctl launches the server through a cmd.exe
#     that lives as long as the server and inherits pg_ctl's stdout, so capturing
#     it means waiting on a pipe that only closes when the server stops.
#   • It runs in its own hidden console, which the server then inherits. Closing
#     the launcher's window sends CTRL_CLOSE_EVENT to every process attached to
#     that console and Windows then terminates them: attached, every backend dies
#     at once and the postmaster aborts, leaving a database that needs crash
#     recovery on the next start. Detached, the server only stops when asked —
#     by the launcher on Ctrl+C, or by Watch-IdentityAtlas.ps1 otherwise.
function Invoke-PgTool {
    param([Parameter(Mandatory)][string]$PgRoot, [Parameter(Mandatory)][string]$Name,
          [string[]]$Arguments = @(), [switch]$Detached)
    $exe = Join-Path $PgRoot 'bin' "$Name.exe"
    if ($Detached) {
        $argLine = ($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' '
        $p = Start-Process -FilePath $exe -ArgumentList $argLine -WindowStyle Hidden -PassThru
        $null = $p.Handle   # keeps ExitCode readable after the process ends
        $p.WaitForExit()
        return [pscustomobject]@{ ExitCode = $p.ExitCode; Output = '' }
    }
    $output = & $exe @Arguments 2>&1 | ForEach-Object { "$_" }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

# STATUS_DLL_NOT_FOUND: the process could not load an import before main().
$script:DllNotFound = -1073741515

# Run each binary once with -V before trusting the folder. This is the cheapest
# way to learn, up front and with a readable message, the two ways a locked-down
# laptop refuses these files: application control (WDAC / AppLocker) blocking an
# unsigned executable, and a missing Visual C++ runtime (VCRUNTIME140.dll).
# Returns $null when all run, otherwise the reason.
function Test-PostgresBinaries {
    param([Parameter(Mandatory)][string]$PgRoot)
    foreach ($name in 'postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql') {
        try {
            $r = Invoke-PgTool -PgRoot $PgRoot -Name $name -Arguments '-V'
        } catch {
            return "$name.exe could not be started: $($_.Exception.Message) (an application-control policy blocks unsigned executables this way)."
        }
        if ($r.ExitCode -eq $script:DllNotFound) {
            return "$name.exe is missing a DLL, usually VCRUNTIME140.dll from the Microsoft Visual C++ Redistributable (x64)."
        }
        if ($r.ExitCode -ne 0) { return "$name.exe -V exited with code $($r.ExitCode): $($r.Output)" }
    }
    return $null
}

# ── Choosing the database ────────────────────────────────────────────────────

# Auto keeps an existing install on the database it already has: a PGlite user
# whose zip gains a postgres\ folder must not open an empty app, because nothing
# migrates PGlite data across (re-import instead — see the docs).
function Select-DatabaseMode {
    param(
        [ValidateSet('Auto', 'Postgres', 'PGlite')][string]$Requested = 'Auto',
        [string]$PgRoot, [bool]$ExternalConfigured, [bool]$ClusterExists, [bool]$PgliteDataExists
    )
    if ($Requested -eq 'PGlite') { return [pscustomobject]@{ Mode = 'PGlite'; Reason = 'requested' } }
    if ($ExternalConfigured -and $Requested -eq 'Auto') {
        return [pscustomobject]@{ Mode = 'External'; Reason = 'DATABASE_URL or POSTGRES_HOST is set' }
    }
    if (-not $PgRoot) {
        if ($Requested -eq 'Postgres') { throw 'No PostgreSQL binaries found: add a postgres\ folder next to the launcher or pass -PostgresRoot.' }
        return [pscustomobject]@{ Mode = 'PGlite'; Reason = 'no PostgreSQL binaries in the package' }
    }
    if ($Requested -eq 'Auto' -and -not $ClusterExists -and $PgliteDataExists) {
        return [pscustomobject]@{ Mode = 'PGlite'; Reason = 'this data directory already holds PGlite data; -Database Postgres switches, then re-import' }
    }
    return [pscustomobject]@{ Mode = 'Postgres'; Reason = 'PostgreSQL binaries found' }
}

# ── Tuning ───────────────────────────────────────────────────────────────────

function Get-TotalMemoryBytes {
    [int64](Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory
}

function Limit-Mb([int64]$Value, [int64]$Min, [int64]$Max) { [Math]::Min($Max, [Math]::Max($Min, $Value)) }

# Sized from the machine's memory, for a laptop that is also running a browser,
# the API and the crawlers: a quarter for the buffer pool, generous sort and
# index-build memory, and room for bulk loads before a forced checkpoint.
function Get-PostgresTuning {
    param([Parameter(Mandatory)][int64]$TotalBytes)
    $mb = [int64][Math]::Floor($TotalBytes / 1MB)
    [ordered]@{
        shared_buffers       = '{0}MB' -f (Limit-Mb ([int64]($mb / 4))   128  8192)
        effective_cache_size = '{0}MB' -f (Limit-Mb ([int64]($mb / 2))   256 32768)
        work_mem             = '{0}MB' -f (Limit-Mb ([int64]($mb / 256))   4   128)
        maintenance_work_mem = '{0}MB' -f (Limit-Mb ([int64]($mb / 16))   64  2048)
        max_wal_size         = if ($mb -ge 8192) { '8GB' } else { '2GB' }
    }
}

# Appended to postgresql.conf once, at initdb time, so it stays visible and
# editable there; later starts never rewrite it. Port is passed on the command
# line instead so -PostgresPort always wins.
function Format-PostgresConfBlock {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Tuning, [int64]$TotalBytes)
    $lines = @(
        '',
        '# ── Identity Atlas portable launcher ─────────────────────────────────',
        '# Written once when this cluster was created. Edit freely; the launcher',
        '# does not touch this file again. The port comes from -PostgresPort.',
        "listen_addresses = '127.0.0.1'",
        "password_encryption = 'scram-sha-256'",
        'logging_collector = on',
        "log_directory = 'log'",
        "log_filename = 'postgresql-%a.log'",
        'log_truncate_on_rotation = on',
        'log_rotation_age = 1d',
        [string]::Format([cultureinfo]::InvariantCulture, '# Sized for {0:N1} GB of RAM:', $TotalBytes / 1GB)
    )
    $lines += foreach ($k in $Tuning.Keys) { "$k = '$($Tuning[$k])'" }
    ($lines -join "`n") + "`n"
}

# ── Secrets ──────────────────────────────────────────────────────────────────

function New-DbPassword {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# Only the current user: no inherited entries, one FullControl rule.
function Set-OwnerOnlyAcl {
    param([Parameter(Mandatory)][string]$Path)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Get-DbPassword {
    param([Parameter(Mandatory)][string]$PgHome)
    $file = Join-Path $PgHome 'password'
    if (-not (Test-Path -LiteralPath $file)) {
        throw "The database password file $file is missing. The server was initialised with it; restore it from a backup of the data directory."
    }
    (Get-Content -LiteralPath $file -Raw).Trim()
}

# ── Cluster lifecycle ────────────────────────────────────────────────────────

function Test-ClusterExists {
    param([Parameter(Mandatory)][string]$PgHome)
    Test-Path -LiteralPath (Join-Path $PgHome 'data' 'PG_VERSION')
}

# First run only, and safe to interrupt: initdb writes into data.initializing and
# the folder is renamed to data only once it is complete and configured, so a
# half-built cluster is never mistaken for a real one — the next run discards it
# and starts over. The password file is written (owner-only) before initdb and
# reused on a retry. Returns $true when it created the cluster.
function Initialize-PostgresCluster {
    param([Parameter(Mandatory)][string]$PgRoot, [Parameter(Mandatory)][string]$PgHome, [Parameter(Mandatory)][int64]$TotalBytes)
    if (Test-ClusterExists -PgHome $PgHome) { return $false }
    $data = Join-Path $PgHome 'data'
    if ((Test-Path -LiteralPath $data) -and (Get-ChildItem -LiteralPath $data -Force | Select-Object -First 1)) {
        throw "$data exists but is not a PostgreSQL data directory. Move it aside and start again."
    }
    $tmp = Join-Path $PgHome 'data.initializing'
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $PgHome -Force
    $pwFile = Join-Path $PgHome 'password'
    if (-not (Test-Path -LiteralPath $pwFile)) {
        Set-Content -LiteralPath $pwFile -Value (New-DbPassword) -NoNewline
        Set-OwnerOnlyAcl -Path $pwFile
    }
    Write-Host 'Creating the PostgreSQL database cluster (first run only)...' -ForegroundColor Cyan
    $r = Invoke-PgTool -PgRoot $PgRoot -Name 'initdb' -Arguments @(
        '-D', $tmp, '-U', $script:DbUser, "--pwfile=$pwFile", '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C')
    if ($r.ExitCode -ne 0) { throw "initdb failed with exit code $($r.ExitCode):`n$($r.Output)" }
    $conf = Format-PostgresConfBlock -Tuning (Get-PostgresTuning -TotalBytes $TotalBytes) -TotalBytes $TotalBytes
    Add-Content -LiteralPath (Join-Path $tmp 'postgresql.conf') -Value $conf -NoNewline
    if (Test-Path -LiteralPath $data) { Remove-Item -LiteralPath $data -Force }
    Move-Item -LiteralPath $tmp -Destination $data
    return $true
}

# pg_ctl exit codes: 0 running, 3 not running.
function Test-PostgresRunning {
    param([Parameter(Mandatory)][string]$PgRoot, [Parameter(Mandatory)][string]$PgHome)
    (Invoke-PgTool -PgRoot $PgRoot -Name 'pg_ctl' -Arguments @('status', '-D', (Join-Path $PgHome 'data'))).ExitCode -eq 0
}

# Fast shutdown: active transactions roll back, a checkpoint is written, and the
# next start needs no crash recovery. Never a kill: a server that is slow to stop
# is left to finish rather than risk its data.
function Stop-PostgresServer {
    param([Parameter(Mandatory)][string]$PgRoot, [Parameter(Mandatory)][string]$PgHome, [int]$TimeoutSec = 300)
    if (-not (Test-PostgresRunning -PgRoot $PgRoot -PgHome $PgHome)) { return }
    Write-Host 'Stopping PostgreSQL...' -ForegroundColor Gray
    $r = Invoke-PgTool -PgRoot $PgRoot -Name 'pg_ctl' -Arguments @(
        'stop', '-D', (Join-Path $PgHome 'data'), '-m', 'fast', '-w', '-t', "$TimeoutSec")
    if ($r.ExitCode -ne 0) { Write-Warning "PostgreSQL did not confirm it stopped within $TimeoutSec s; it was left to finish. $($r.Output)" }
}

# pg_ctl -W returns as soon as the postmaster is launched; Wait-PostgresReady
# does the waiting, so a long crash recovery is watched rather than timed out.
function Start-PostgresServer {
    param([Parameter(Mandatory)][string]$PgRoot, [Parameter(Mandatory)][string]$PgHome, [Parameter(Mandatory)][int]$Port)
    $log = Join-Path $PgHome 'startup.log'
    Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
    $r = Invoke-PgTool -PgRoot $PgRoot -Name 'pg_ctl' -Detached -Arguments @(
        'start', '-D', (Join-Path $PgHome 'data'), '-l', $log, '-W', '-o', "-p $Port")
    if ($r.ExitCode -ne 0) { throw "pg_ctl start failed with exit code $($r.ExitCode). Last lines of its log:`n$(Get-LogTail $log)" }
}

function Get-LogTail {
    param([string]$Path, [int]$Lines = 15)
    if ($Path -and (Test-Path -LiteralPath $Path)) { (Get-Content -LiteralPath $Path -Tail $Lines) -join "`n" } else { '' }
}

# pg_isready exit codes: 0 accepting, 1 rejecting (starting up or recovering),
# 2 no response. Waits as long as the server is alive; fails fast when it dies.
function Wait-PostgresReady {
    param([Parameter(Mandatory)][string]$PgRoot, [Parameter(Mandatory)][string]$PgHome,
          [Parameter(Mandatory)][int]$Port, [int]$WarnAfterSec = 60, [int]$PollMs = 500)
    $started = [DateTime]::UtcNow; $warned = $false
    while ($true) {
        $r = Invoke-PgTool -PgRoot $PgRoot -Name 'pg_isready' -Arguments @('-h', '127.0.0.1', '-p', "$Port", '-q')
        if ($r.ExitCode -eq 0) { return }
        if (-not (Test-PostgresRunning -PgRoot $PgRoot -PgHome $PgHome)) {
            throw "PostgreSQL stopped during startup. Last lines of its log:`n$(Get-LogTail (Join-Path $PgHome 'startup.log'))"
        }
        if (-not $warned -and ([DateTime]::UtcNow - $started).TotalSeconds -ge $WarnAfterSec) {
            Write-Warning "PostgreSQL is still starting after $WarnAfterSec s (recovering after an unclean stop takes a while on a large database). Waiting; Ctrl+C stops it cleanly."
            $warned = $true
        }
        Start-Sleep -Milliseconds $PollMs
    }
}

# Creates the application database when it is missing — including after a first
# run that was interrupted between initdb and here.
# (The password is a plain string on purpose, here and below: libpq and node.exe
# take it from an environment variable, so a SecureString would be converted
# straight back.)
function Initialize-AppDatabase {
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    param([Parameter(Mandatory)][string]$PgRoot, [Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Password)
    $base = @('-h', '127.0.0.1', '-p', "$Port", '-U', $script:DbUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-tA', '-c')
    $env:PGPASSWORD = $Password
    try {
        $r = Invoke-PgTool -PgRoot $PgRoot -Name 'psql' -Arguments ($base + "SELECT 1 FROM pg_database WHERE datname = '$script:DbName'")
        if ($r.ExitCode -ne 0) { throw "Could not query PostgreSQL: $($r.Output)" }
        if ($r.Output.Trim() -eq '1') { return $false }
        $r = Invoke-PgTool -PgRoot $PgRoot -Name 'psql' -Arguments ($base + "CREATE DATABASE $script:DbName")
        if ($r.ExitCode -ne 0) { throw "Could not create database ${script:DbName}: $($r.Output)" }
        return $true
    } finally {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
}

# What node.exe needs to reach the server. The password travels in the child's
# environment, readable only by this user, never on a command line.
function Get-PostgresEnvironment {
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Password)
    [ordered]@{
        POSTGRES_HOST = '127.0.0.1'; POSTGRES_PORT = "$Port"; POSTGRES_DB = $script:DbName
        POSTGRES_USER = $script:DbUser; POSTGRES_PASSWORD = $Password
    }
}

# ── One launcher per data directory ──────────────────────────────────────────

# An exclusive handle on launcher.lock, held for the launcher's lifetime and
# released by Windows when the process ends however it ends. Two launchers on one
# data directory would mean two writers on one PGlite store, or a second launcher
# stopping the first one's PostgreSQL. Returns $null when another launcher has it.
#
# -WaitMs retries for a moment: the watchdog of a launcher that just stopped holds
# the lock for the second it takes to confirm there is nothing left to clean up.
function Enter-LauncherLock {
    param([Parameter(Mandatory)][string]$DataDir, [int]$WaitMs = 0, [int]$PollMs = 250)
    $null = New-Item -ItemType Directory -Path $DataDir -Force
    $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMs)
    while ($true) {
        try {
            return [System.IO.File]::Open((Join-Path $DataDir 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        } catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { return $null }
            Start-Sleep -Milliseconds $PollMs
        }
    }
}

# The node.exe this launcher started, so the next launcher can recognise it if
# this one dies without cleaning up (its console killed, say). The start time
# guards against a recycled process id. Stored as ticks: ConvertFrom-Json turns an
# ISO date string back into a DateTime, which then never equals the string.
function Save-LauncherState {
    param([Parameter(Mandatory)][string]$DataDir, [Parameter(Mandatory)][System.Diagnostics.Process]$Node)
    @{ nodePid = $Node.Id; nodeStartTicks = $Node.StartTime.ToUniversalTime().Ticks } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataDir 'launcher.state.json')
}

function Clear-LauncherState {
    param([Parameter(Mandatory)][string]$DataDir)
    Remove-Item -LiteralPath (Join-Path $DataDir 'launcher.state.json') -ErrorAction SilentlyContinue
}

# Called only while holding the lock, so a recorded node.exe that is still alive
# belongs to a launcher that is gone. Returns $true when it stopped one.
function Stop-OrphanedNode {
    param([Parameter(Mandatory)][string]$DataDir)
    $file = Join-Path $DataDir 'launcher.state.json'
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    $state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $proc = Get-Process -Id $state.nodePid -ErrorAction SilentlyContinue
    $isSame = $proc -and $proc.ProcessName -eq 'node' -and
              $proc.StartTime.ToUniversalTime().Ticks -eq [int64]$state.nodeStartTicks
    if ($isSame) {
        Write-Host "Stopping node.exe (pid $($proc.Id)) left behind by a previous launcher..." -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force
        $null = $proc.WaitForExit(10000)
    }
    Clear-LauncherState -DataDir $DataDir
    return [bool]$isSame
}

# ── The app ──────────────────────────────────────────────────────────────────

# $null when nothing answers; otherwise the parsed /api/health body. Probes
# 127.0.0.1, the address the API binds: "localhost" tries ::1 first, and on
# Windows that attempt alone can outlast a short timeout.
function Get-AppHealth {
    param([Parameter(Mandatory)][int]$Port)
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5 -ErrorAction Stop } catch { $null }
}

# Waits until the API answers AND its schema is migrated. The API opens its port
# before migrating, so "answers" alone would open the browser on a half-built
# schema. Fails at once if node.exe exits (reporting its code); past WarnAfterSec
# it says so and keeps waiting, because killing a process mid-migration is what
# leaves a database worse off for the next start.
function Wait-AppReady {
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][int]$Port, [string]$CrashLog,
          [int]$WarnAfterSec = 300, [int]$PollMs = 500)
    $started = [DateTime]::UtcNow; $warned = $false; $saidMigrating = $false
    while ($true) {
        if ($Node.HasExited) {
            throw "Identity Atlas exited during startup with code $($Node.ExitCode). Details, if any: $CrashLog"
        }
        $health = Get-AppHealth -Port $Port
        if ($health -and $health.schemaReady) { return }
        if ($health -and -not $saidMigrating) { Write-Host 'Server is up; migrating the database schema...' -ForegroundColor Gray; $saidMigrating = $true }
        if (-not $warned -and ([DateTime]::UtcNow - $started).TotalSeconds -ge $WarnAfterSec) {
            Write-Warning "Identity Atlas is not ready after $WarnAfterSec s. It is still starting and will not be stopped; Ctrl+C stops it cleanly."
            $warned = $true
        }
        Start-Sleep -Milliseconds $PollMs
    }
}

# Blocks while the app runs. Start-Sleep, unlike Process.WaitForExit(), lets
# Ctrl+C through, so the caller's finally block always gets to stop things.
function Wait-AppExit {
    param([Parameter(Mandatory)]$Node, [scriptblock]$DatabaseAlive = { $true }, [int]$PollMs = 1000)
    while ($true) {
        if ($Node.HasExited) { return "Identity Atlas exited with code $($Node.ExitCode)." }
        if (-not (& $DatabaseAlive)) { return 'PostgreSQL stopped unexpectedly; stopping Identity Atlas.' }
        Start-Sleep -Milliseconds $PollMs
    }
}

# ── Orchestration steps (called by Start-IdentityAtlas.ps1) ──────────────────

function Test-PgliteData {
    param([Parameter(Mandatory)][string]$DataDir)
    Test-Path -LiteralPath (Join-Path $DataDir 'pgdata' 'PG_VERSION')
}

# Select-DatabaseMode plus the binary preflight. A package whose PostgreSQL cannot
# run here falls back to PGlite on a fresh install; with an existing cluster, or
# when PostgreSQL was asked for, falling back would show an empty app, so it fails.
# Only a Postgres choice carries PgRoot: binaries that failed the preflight are
# never run again (a missing DLL raises a modal "System Error" box per attempt).
function Resolve-DatabaseChoice {
    param([string]$Requested = 'Auto', [string]$PgRoot, [Parameter(Mandatory)][string]$DataDir)
    $clusterExists = Test-ClusterExists -PgHome (Join-Path $DataDir 'postgres')
    $choice = Select-DatabaseMode -Requested $Requested -PgRoot $PgRoot -ClusterExists $clusterExists `
        -ExternalConfigured ([bool]($env:DATABASE_URL -or $env:POSTGRES_HOST)) -PgliteDataExists (Test-PgliteData -DataDir $DataDir)
    if ($choice.Mode -ne 'Postgres') { return $choice }
    $problem = Test-PostgresBinaries -PgRoot $PgRoot
    if (-not $problem) { return [pscustomobject]@{ Mode = 'Postgres'; Reason = $choice.Reason; PgRoot = $PgRoot } }
    if ($Requested -eq 'Auto' -and -not $clusterExists) {
        Write-Warning "The bundled PostgreSQL cannot run on this machine: $problem Using the built-in PGlite database instead."
        return [pscustomobject]@{ Mode = 'PGlite'; Reason = 'the bundled PostgreSQL cannot run on this machine' }
    }
    throw "The bundled PostgreSQL cannot run on this machine: $problem"
}

# Initialise on first run, restart a server a dead launcher left behind, start,
# wait, make sure the database exists. Returns the environment for node.exe.
function Start-BundledPostgres {
    param([Parameter(Mandatory)][string]$PgRoot, [Parameter(Mandatory)][string]$PgHome,
          [Parameter(Mandatory)][int]$Port, [int]$WarnAfterSec = 60)
    $null = Initialize-PostgresCluster -PgRoot $PgRoot -PgHome $PgHome -TotalBytes (Get-TotalMemoryBytes)
    if (Test-PostgresRunning -PgRoot $PgRoot -PgHome $PgHome) {
        Write-Host 'Restarting a PostgreSQL server left running by a previous launcher...' -ForegroundColor Yellow
        Stop-PostgresServer -PgRoot $PgRoot -PgHome $PgHome
    }
    Write-Host "Starting PostgreSQL on 127.0.0.1:$Port..." -ForegroundColor Cyan
    Start-PostgresServer -PgRoot $PgRoot -PgHome $PgHome -Port $Port
    Wait-PostgresReady -PgRoot $PgRoot -PgHome $PgHome -Port $Port -WarnAfterSec $WarnAfterSec
    $password = Get-DbPassword -PgHome $PgHome
    if (Initialize-AppDatabase -PgRoot $PgRoot -Port $Port -Password $password) {
        Write-Host "Created database '$script:DbName'." -ForegroundColor Gray
    }
    Get-PostgresEnvironment -Port $Port -Password $password
}

# The postmaster, read from postmaster.pid (first line). Cheap enough to poll
# every second, unlike starting pg_ctl status each time.
function Get-PostmasterProcess {
    param([Parameter(Mandatory)][string]$PgHome)
    $pidFile = Join-Path $PgHome 'data' 'postmaster.pid'
    $first = Get-Content -LiteralPath $pidFile -TotalCount 1 -ErrorAction SilentlyContinue
    if (-not $first) { return $null }
    Get-Process -Id ([int]$first) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'postgres'
}

# node.exe reads its database from these. Everything is cleared first: connection.js
# prefers DATABASE_URL over POSTGRES_*, so a stale one inherited from the shell
# would silently win over the server this launcher just started.
function Set-ChildDatabaseEnvironment {
    param([System.Collections.IDictionary]$Values = @{})
    foreach ($name in 'DATABASE_URL', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD') {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    foreach ($k in $Values.Keys) { Set-Item "Env:$k" -Value $Values[$k] }
}

# On Ctrl+C node.exe gets the signal too and shuts itself down (index.js allows
# itself 5 s); give it that before ending it.
function Stop-NodeProcess {
    param($Node, [int]$GraceMs = 6000)
    if (-not $Node -or $Node.HasExited) { return }
    if (-not $Node.WaitForExit($GraceMs)) { Stop-Process -Id $Node.Id -Force -ErrorAction SilentlyContinue }
}

# Prepares the chosen database and the environment node.exe will inherit.
# External needs nothing: node.exe uses the DATABASE_URL / POSTGRES_* it inherits.
function Initialize-ChosenDatabase {
    param([Parameter(Mandatory)]$Choice, [Parameter(Mandatory)][string]$PgHome,
          [Parameter(Mandatory)][int]$Port, [int]$WarnAfterSec = 60)
    switch ($Choice.Mode) {
        'Postgres' { Set-ChildDatabaseEnvironment -Values (Start-BundledPostgres -PgRoot $Choice.PgRoot -PgHome $PgHome -Port $Port -WarnAfterSec $WarnAfterSec) }
        'PGlite'   { Set-ChildDatabaseEnvironment }
    }
}

# Starts node.exe bootstrap.mjs in this console, records it for orphan recovery,
# then drops the database password from this process: the child has its copy.
function Start-AppProcess {
    param([Parameter(Mandatory)][string]$ScriptDir, [Parameter(Mandatory)][string]$DataDir, [Parameter(Mandatory)][int]$Port)
    $env:IA_DATA_DIR = $DataDir
    $env:PORT = "$Port"
    $node = Start-Process -FilePath (Join-Path $ScriptDir 'node.exe') -WorkingDirectory $ScriptDir -NoNewWindow -PassThru `
        -ArgumentList (ConvertTo-CommandLineArgument (Join-Path $ScriptDir 'bootstrap.mjs'))
    $null = $node.Handle   # keeps ExitCode readable after the process ends
    Save-LauncherState -DataDir $DataDir -Node $node
    Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue
    $node
}

# ── After the launcher ends ──────────────────────────────────────────────────

# What must not outlive a launcher: its node.exe and its PostgreSQL. Run by the
# watchdog once the launcher process is gone. Takes the lock first, so it never
# touches processes a newer launcher already owns; after a normal Ctrl+C the
# launcher has already done all of this and every step is a no-op.
function Invoke-LauncherCleanup {
    param([Parameter(Mandatory)][string]$DataDir, [string]$PgRoot, [int]$WaitMs = 5000)
    $lock = Enter-LauncherLock -DataDir $DataDir -WaitMs $WaitMs
    if (-not $lock) { return $false }
    try {
        $null = Stop-OrphanedNode -DataDir $DataDir
        if ($PgRoot) { Stop-PostgresServer -PgRoot $PgRoot -PgHome (Join-Path $DataDir 'postgres') }
    } finally {
        $lock.Dispose()
    }
    return $true
}

# Starts Watch-IdentityAtlas.ps1 hidden, in its own console so that closing the
# launcher's window does not end it too. The execution policy is passed on
# explicitly: the child does not inherit the launcher's, and every file from a
# downloaded zip carries the mark RemoteSigned refuses.
function Start-LauncherWatchdog {
    param([Parameter(Mandatory)][string]$ScriptDir, [Parameter(Mandatory)][string]$DataDir,
          [string]$PgRoot, [int]$LauncherPid = $PID)
    $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $ScriptDir 'Watch-IdentityAtlas.ps1'), '-LauncherPid', "$LauncherPid", '-DataDir', $DataDir)
    if ($PgRoot) { $argList += '-PgRoot', $PgRoot }
    Start-Process -FilePath (Get-Process -Id $PID).Path -WindowStyle Hidden -PassThru `
        -ArgumentList (($argList | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' ')
}

# What a second launcher on the same data directory says, and its exit code. It
# only calls the app "running" (and opens the browser) once the schema is ready:
# the API answers before its migrations finish.
function Show-OtherLauncher {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$DataDir, [switch]$OpenBrowser)
    $url = "http://localhost:$Port"
    $health = Get-AppHealth -Port $Port
    if ($health -and $health.schemaReady) {
        Write-Host "Identity Atlas is already running at $url" -ForegroundColor Green
        if ($OpenBrowser) { Start-Process $url }
        return 0
    }
    Write-Host "Identity Atlas is still starting from $DataDir in another window. It opens $url when it is ready." -ForegroundColor Yellow
    return 1
}
