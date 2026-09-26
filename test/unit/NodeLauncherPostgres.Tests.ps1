#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Unit tests for the portable launcher's functions (app/desktop/node-launcher/Launcher.Functions.ps1):
    database choice, PostgreSQL cluster lifecycle, tuning, secrets, the per-data-dir lock and orphan
    recovery, and the startup/run loops.

    PostgreSQL executables are reached only through Invoke-PgTool, which these tests mock; the real
    end-to-end run (initdb, start, Ctrl+C, restart) is described in docs/architecture/desktop-portable.md.

.USAGE
    Invoke-Pester -Path test/unit/NodeLauncherPostgres.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $root 'app' 'desktop' 'node-launcher' 'Launcher.Functions.ps1')

    function New-FakeNode {
        param([bool]$Exited = $false, [int]$ExitCode = 0, [bool]$ExitsInGrace = $true)
        $n = [pscustomobject]@{ Id = 4711; HasExited = $Exited; ExitCode = $ExitCode; Grace = $ExitsInGrace; Waited = $null }
        $n | Add-Member ScriptMethod WaitForExit { param($ms) $this.Waited = $ms; $this.Grace }
        $n
    }
    function Result([int]$Code, [string]$Out = '') { [pscustomobject]@{ ExitCode = $Code; Output = $Out } }
}

Describe 'ConvertTo-CommandLineArgument' {
    It '<In> -> <Out>' -ForEach @(
        @{ In = 'start';            Out = 'start' }
        @{ In = '-p 5433';          Out = '"-p 5433"' }
        @{ In = 'C:\Users\J Doe\d'; Out = '"C:\Users\J Doe\d"' }
        @{ In = 'C:\a b\';          Out = '"C:\a b\\"' }
        @{ In = 'say "hi"';         Out = '"say \"hi\""' }
        @{ In = '';                 Out = '""' }
    ) {
        ConvertTo-CommandLineArgument $In | Should -BeExactly $Out
    }
}

Describe 'Invoke-PgTool' -Skip:(-not $IsWindows) {
    BeforeAll {
        $pg = Join-Path $TestDrive 'pg'
        $null = New-Item -ItemType Directory (Join-Path $pg 'bin') -Force
        Copy-Item (Join-Path $env:SystemRoot 'System32' 'cmd.exe') (Join-Path $pg 'bin' 'cmd.exe')
    }
    It 'captures output and the exit code' {
        $r = Invoke-PgTool -PgRoot $pg -Name 'cmd' -Arguments '/c', 'echo out-61& exit 7'
        $r.ExitCode | Should -Be 7
        $r.Output | Should -Match 'out-61'
    }
    It 'returns the exit code without capturing under -Detached' {
        $r = Invoke-PgTool -PgRoot $pg -Name 'cmd' -Detached -Arguments '/c', 'exit 5'
        $r.ExitCode | Should -Be 5
        $r.Output | Should -BeExactly ''
    }
}

Describe 'Resolve-PostgresRoot' {
    BeforeAll {
        $dir = Join-Path $TestDrive 'pkg'
        $null = New-Item -ItemType Directory (Join-Path $dir 'postgres' 'bin') -Force
        Set-Content (Join-Path $dir 'postgres' 'bin' 'pg_ctl.exe') ''
        $empty = Join-Path $TestDrive 'empty'; $null = New-Item -ItemType Directory $empty -Force
    }
    It 'finds postgres\ next to the launcher' {
        Resolve-PostgresRoot -ScriptDir $dir | Should -Be (Join-Path $dir 'postgres')
    }
    It 'returns $null when the package has none' {
        Resolve-PostgresRoot -ScriptDir $empty | Should -BeNullOrEmpty
    }
    It 'an explicit -PostgresRoot wins over the package folder' {
        Resolve-PostgresRoot -Override (Join-Path $dir 'postgres') -ScriptDir $empty | Should -Be (Join-Path $dir 'postgres')
    }
    It 'a wrong -PostgresRoot is an error, not a silent PGlite fall-back' {
        { Resolve-PostgresRoot -Override $empty -ScriptDir $dir } | Should -Throw '*does not contain bin*'
    }
}

Describe 'Test-PostgresBinaries' {
    It 'passes when every binary runs' {
        Mock Invoke-PgTool { Result 0 'v16' }
        Test-PostgresBinaries -PgRoot 'P' | Should -BeNullOrEmpty
        Should -Invoke Invoke-PgTool -Times 5 -Exactly -ParameterFilter { $Arguments -contains '-V' }
    }
    It 'names application control when a binary cannot be started' {
        Mock Invoke-PgTool { throw 'An Application Control policy has blocked this file' }
        $r = Test-PostgresBinaries -PgRoot 'P'
        $r | Should -Match '^postgres\.exe could not be started'
        $r | Should -Match 'application-control'
    }
    It 'names the Visual C++ runtime on STATUS_DLL_NOT_FOUND, and stops at the first failure' {
        Mock Invoke-PgTool { if ($Name -eq 'postgres') { Result 0 } else { Result -1073741515 } }
        Test-PostgresBinaries -PgRoot 'P' | Should -Match '^initdb\.exe is missing a DLL.*VCRUNTIME140'
        Should -Invoke Invoke-PgTool -Times 2 -Exactly
    }
    It 'reports any other non-zero exit with its output' {
        Mock Invoke-PgTool { if ($Name -eq 'psql') { Result 3 'bad-62' } else { Result 0 } }
        Test-PostgresBinaries -PgRoot 'P' | Should -Be 'psql.exe -V exited with code 3: bad-62'
    }
}

Describe 'Select-DatabaseMode' {
    It '<Name>' -ForEach @(
        @{ Name = 'PGlite on request, even with binaries and a cluster'; Req = 'PGlite'; Root = 'R'; Ext = $true; Cl = $true; Pgl = $false; Mode = 'PGlite' }
        @{ Name = 'external server wins in Auto';                         Req = 'Auto'; Root = 'R'; Ext = $true; Cl = $true; Pgl = $false; Mode = 'External' }
        @{ Name = 'no binaries means PGlite in Auto';                     Req = 'Auto'; Root = ''; Ext = $false; Cl = $false; Pgl = $false; Mode = 'PGlite' }
        @{ Name = 'fresh install with binaries uses Postgres';            Req = 'Auto'; Root = 'R'; Ext = $false; Cl = $false; Pgl = $false; Mode = 'Postgres' }
        @{ Name = 'existing PGlite data stays on PGlite';                 Req = 'Auto'; Root = 'R'; Ext = $false; Cl = $false; Pgl = $true; Mode = 'PGlite' }
        @{ Name = 'an existing cluster wins over PGlite data';            Req = 'Auto'; Root = 'R'; Ext = $false; Cl = $true; Pgl = $true; Mode = 'Postgres' }
        @{ Name = 'Postgres on request switches away from PGlite data';   Req = 'Postgres'; Root = 'R'; Ext = $false; Cl = $false; Pgl = $true; Mode = 'Postgres' }
        @{ Name = 'Postgres on request ignores an external server';       Req = 'Postgres'; Root = 'R'; Ext = $true; Cl = $false; Pgl = $false; Mode = 'Postgres' }
    ) {
        (Select-DatabaseMode -Requested $Req -PgRoot $Root -ExternalConfigured $Ext -ClusterExists $Cl -PgliteDataExists $Pgl).Mode |
            Should -Be $Mode
    }
    It 'says why it kept PGlite data, and how to switch' {
        (Select-DatabaseMode -PgRoot 'R' -PgliteDataExists $true).Reason | Should -Match '-Database Postgres'
    }
    It 'Postgres on request without binaries is an error' {
        { Select-DatabaseMode -Requested 'Postgres' } | Should -Throw '*No PostgreSQL binaries*'
    }
}

Describe 'Get-PostgresTuning' {
    It '<Gb> GB RAM' -ForEach @(
        # 16 GB: every setting inside its clamp, so each ratio is checked on its own.
        @{ Gb = 16;   Sb = '4096MB'; Ec = '8192MB';  Wm = '64MB';  Mw = '1024MB'; Wal = '8GB' }
        @{ Gb = 4;    Sb = '1024MB'; Ec = '2048MB';  Wm = '16MB';  Mw = '256MB';  Wal = '2GB' }
        # Every floor.
        @{ Gb = 0.25; Sb = '128MB';  Ec = '256MB';   Wm = '4MB';   Mw = '64MB';   Wal = '2GB' }
        # Every ceiling.
        @{ Gb = 256;  Sb = '8192MB'; Ec = '32768MB'; Wm = '128MB'; Mw = '2048MB'; Wal = '8GB' }
    ) {
        $t = Get-PostgresTuning -TotalBytes ([int64]($Gb * 1GB))
        @($t.shared_buffers, $t.effective_cache_size, $t.work_mem, $t.maintenance_work_mem, $t.max_wal_size) |
            Should -Be @($Sb, $Ec, $Wm, $Mw, $Wal)
    }
    It 'switches max_wal_size at exactly 8 GB' {
        (Get-PostgresTuning -TotalBytes 8GB).max_wal_size | Should -Be '8GB'
        (Get-PostgresTuning -TotalBytes (8GB - 1MB)).max_wal_size | Should -Be '2GB'
    }
}

Describe 'Format-PostgresConfBlock' {
    It 'binds loopback, uses scram, and writes every tuning value' {
        $text = Format-PostgresConfBlock -Tuning ([ordered]@{ shared_buffers = '11MB'; work_mem = '22MB' }) -TotalBytes 16GB
        $lines = $text -split "`n"
        $lines | Should -Contain "listen_addresses = '127.0.0.1'"
        $lines | Should -Contain "password_encryption = 'scram-sha-256'"
        $lines | Should -Contain "shared_buffers = '11MB'"
        $lines | Should -Contain "work_mem = '22MB'"
        $lines | Should -Contain '# Sized for 16.0 GB of RAM:'
        $lines | Where-Object { $_ -match '^\s*port\s*=' } | Should -BeNullOrEmpty
        $text | Should -Match "^`n"
    }
}

Describe 'Secrets' {
    It 'New-DbPassword is 256 random bits, URL-safe' {
        $a = New-DbPassword; $b = New-DbPassword
        $a | Should -Match '^[A-Za-z0-9_-]{43}$'
        $a | Should -Not -Be $b
    }
    It 'Get-DbPassword trims the stored value' {
        $h = Join-Path $TestDrive 'pw1'; $null = New-Item -ItemType Directory $h -Force
        Set-Content (Join-Path $h 'password') "secret-63`r`n"
        Get-DbPassword -PgHome $h | Should -BeExactly 'secret-63'
    }
    It 'Get-DbPassword explains a missing file' {
        { Get-DbPassword -PgHome (Join-Path $TestDrive 'nope') } | Should -Throw '*password file*missing*'
    }
    It 'Set-OwnerOnlyAcl leaves exactly one, non-inherited rule for the current user' -Skip:(-not $IsWindows) {
        $f = Join-Path $TestDrive 'acl.txt'; Set-Content $f 'x'
        Set-OwnerOnlyAcl -Path $f
        $acl = Get-Acl $f
        $acl.AreAccessRulesProtected | Should -BeTrue
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $rules.Count | Should -Be 1
        $rules[0].IdentityReference.Value | Should -Be ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    }
}

Describe 'Initialize-PostgresCluster' {
    BeforeEach {
        $h = Join-Path $TestDrive ([guid]::NewGuid())
        Mock Set-OwnerOnlyAcl {}
        # initdb stand-in: creates the directory it was pointed at, like the real one.
        Mock Invoke-PgTool {
            $d = $Arguments[[array]::IndexOf($Arguments, '-D') + 1]
            $null = New-Item -ItemType Directory $d -Force
            Set-Content (Join-Path $d 'PG_VERSION') '16'
            Set-Content (Join-Path $d 'postgresql.conf') '# stock' -NoNewline
            Result 0
        }
    }
    It 'creates, configures and publishes the cluster in one step' {
        Initialize-PostgresCluster -PgRoot 'P' -PgHome $h -TotalBytes 16GB | Should -BeTrue
        Join-Path $h 'data' 'PG_VERSION' | Should -Exist
        Join-Path $h 'data.initializing' | Should -Not -Exist
        $conf = Get-Content (Join-Path $h 'data' 'postgresql.conf') -Raw
        $conf | Should -Match "^# stock`n"
        $conf | Should -Match "shared_buffers = '4096MB'"
        Get-Content (Join-Path $h 'password') -Raw | Should -Match '^[A-Za-z0-9_-]{43}$'
        Should -Invoke Set-OwnerOnlyAcl -Times 1 -Exactly -ParameterFilter { $Path -eq (Join-Path $h 'password') }
        Should -Invoke Invoke-PgTool -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'initdb' -and $Arguments -contains 'scram-sha-256' -and $Arguments -contains '--locale=C' -and
            $Arguments -contains "--pwfile=$(Join-Path $h 'password')" -and $Arguments -contains 'identityatlas' -and
            $Arguments[[array]::IndexOf($Arguments, '-D') + 1] -eq (Join-Path $h 'data.initializing')
        }
    }
    It 'does nothing when the cluster exists' {
        $null = New-Item -ItemType Directory (Join-Path $h 'data') -Force; Set-Content (Join-Path $h 'data' 'PG_VERSION') '16'
        Initialize-PostgresCluster -PgRoot 'P' -PgHome $h -TotalBytes 1GB | Should -BeFalse
        Should -Invoke Invoke-PgTool -Times 0
    }
    It 'discards a half-built cluster from an interrupted run and keeps its password' {
        $null = New-Item -ItemType Directory (Join-Path $h 'data.initializing') -Force
        Set-Content (Join-Path $h 'data.initializing' 'stale.txt') 'x'
        Set-Content (Join-Path $h 'password') 'kept-64' -NoNewline
        Initialize-PostgresCluster -PgRoot 'P' -PgHome $h -TotalBytes 1GB | Should -BeTrue
        Join-Path $h 'data' 'stale.txt' | Should -Not -Exist
        Get-Content (Join-Path $h 'password') -Raw | Should -BeExactly 'kept-64'
        Should -Invoke Set-OwnerOnlyAcl -Times 0
    }
    It 'replaces an empty data folder' {
        $null = New-Item -ItemType Directory (Join-Path $h 'data') -Force
        Initialize-PostgresCluster -PgRoot 'P' -PgHome $h -TotalBytes 1GB | Should -BeTrue
        Join-Path $h 'data' 'PG_VERSION' | Should -Exist
    }
    It 'refuses a non-empty data folder that is not a cluster' {
        $null = New-Item -ItemType Directory (Join-Path $h 'data') -Force; Set-Content (Join-Path $h 'data' 'x') 'y'
        { Initialize-PostgresCluster -PgRoot 'P' -PgHome $h -TotalBytes 1GB } | Should -Throw '*not a PostgreSQL data directory*'
        Should -Invoke Invoke-PgTool -Times 0
    }
    It 'fails without publishing anything when initdb fails' {
        Mock Invoke-PgTool { Result 1 'initdb: boom-65' }
        { Initialize-PostgresCluster -PgRoot 'P' -PgHome $h -TotalBytes 1GB } | Should -Throw '*boom-65*'
        Join-Path $h 'data' | Should -Not -Exist
    }
}

Describe 'Server control' {
    It 'Test-PostgresRunning maps pg_ctl status exit codes' {
        Mock Invoke-PgTool { Result 0 }
        Test-PostgresRunning -PgRoot 'P' -PgHome 'H' | Should -BeTrue
        Mock Invoke-PgTool { Result 3 }
        Test-PostgresRunning -PgRoot 'P' -PgHome 'H' | Should -BeFalse
    }

    Context 'Stop-PostgresServer' {
        It 'does nothing when the server is down' {
            Mock Test-PostgresRunning { $false }
            Mock Invoke-PgTool { Result 0 }
            Stop-PostgresServer -PgRoot 'P' -PgHome 'H'
            Should -Invoke Invoke-PgTool -Times 0
        }
        It 'uses a fast shutdown and waits for it' {
            Mock Test-PostgresRunning { $true }
            Mock Invoke-PgTool { Result 0 }
            Stop-PostgresServer -PgRoot 'P' -PgHome 'H' -TimeoutSec 77
            Should -Invoke Invoke-PgTool -Times 1 -Exactly -ParameterFilter {
                ($Arguments -join ' ') -eq "stop -D $(Join-Path 'H' 'data') -m fast -w -t 77"
            }
        }
        It 'warns rather than kills when the stop is slow' {
            Mock Test-PostgresRunning { $true }
            Mock Invoke-PgTool { Result 1 'timed out' }
            Mock Stop-Process {}
            Stop-PostgresServer -PgRoot 'P' -PgHome 'H' -WarningVariable w -WarningAction SilentlyContinue
            $w | Should -Match 'left to finish'
            Should -Invoke Stop-Process -Times 0
        }
    }

    Context 'Start-PostgresServer' {
        It 'starts detached from this console, on the requested port' {
            Mock Invoke-PgTool { Result 0 }
            Start-PostgresServer -PgRoot 'P' -PgHome 'H' -Port 5999
            Should -Invoke Invoke-PgTool -Times 1 -Exactly -ParameterFilter {
                $Detached -and $Arguments[0] -eq 'start' -and $Arguments -contains '-W' -and
                $Arguments[[array]::IndexOf($Arguments, '-o') + 1] -eq '-p 5999'
            }
        }
        It 'fails with the tail of the startup log' {
            $h = Join-Path $TestDrive 'ss'; $null = New-Item -ItemType Directory $h -Force
            Mock Invoke-PgTool { Set-Content (Join-Path $h 'startup.log') 'FATAL: port-66 in use'; Result 1 }
            { Start-PostgresServer -PgRoot 'P' -PgHome $h -Port 1 } | Should -Throw '*port-66 in use*'
        }
    }

    Context 'Wait-PostgresReady' {
        BeforeEach { Mock Start-Sleep {} }
        It 'returns once pg_isready accepts' {
            $script:n = 0
            Mock Invoke-PgTool { $script:n++; if ($script:n -ge 3) { Result 0 } else { Result 1 } }
            Mock Test-PostgresRunning { $true }
            Wait-PostgresReady -PgRoot 'P' -PgHome 'H' -Port 5433
            Should -Invoke Invoke-PgTool -Times 3 -Exactly -ParameterFilter { $Name -eq 'pg_isready' -and $Arguments -contains '5433' }
        }
        It 'fails fast, with the log, when the server dies while starting' {
            $h = Join-Path $TestDrive 'wr'; $null = New-Item -ItemType Directory $h -Force
            Set-Content (Join-Path $h 'startup.log') 'FATAL: bad-67'
            Mock Invoke-PgTool { Result 2 }
            Mock Test-PostgresRunning { $false }
            { Wait-PostgresReady -PgRoot 'P' -PgHome $h -Port 1 } | Should -Throw '*stopped during startup*bad-67*'
        }
        It 'warns once when slow, and keeps waiting' {
            $script:n = 0
            Mock Invoke-PgTool { $script:n++; if ($script:n -ge 4) { Result 0 } else { Result 1 } }
            Mock Test-PostgresRunning { $true }
            Wait-PostgresReady -PgRoot 'P' -PgHome 'H' -Port 1 -WarnAfterSec 0 -WarningVariable w -WarningAction SilentlyContinue
            @($w).Count | Should -Be 1
            $script:n | Should -Be 4
        }
    }
}

Describe 'Initialize-AppDatabase' {
    BeforeEach { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    It 'leaves an existing database alone' {
        Mock Invoke-PgTool { Result 0 "1`n" }
        Initialize-AppDatabase -PgRoot 'P' -Port 5433 -Password 'pw' | Should -BeFalse
        Should -Invoke Invoke-PgTool -Times 1 -Exactly
    }
    It 'creates a missing one, authenticating with the password only for the call' {
        $script:seen = @()
        Mock Invoke-PgTool { $script:seen += "$env:PGPASSWORD|$($Arguments[-1])"; Result 0 '' }
        Initialize-AppDatabase -PgRoot 'P' -Port 5433 -Password 'pw-68' | Should -BeTrue
        $script:seen | Should -Be @("pw-68|SELECT 1 FROM pg_database WHERE datname = 'identityatlas'", 'pw-68|CREATE DATABASE identityatlas')
        $env:PGPASSWORD | Should -BeNullOrEmpty
    }
    It 'fails, and still drops the password, when the server refuses' {
        Mock Invoke-PgTool { Result 2 'auth-69 failed' }
        { Initialize-AppDatabase -PgRoot 'P' -Port 5433 -Password 'pw' } | Should -Throw '*auth-69*'
        $env:PGPASSWORD | Should -BeNullOrEmpty
    }
    It 'reports a failed CREATE DATABASE' {
        Mock Invoke-PgTool { if ($Arguments[-1] -like 'CREATE*') { Result 1 'disk-70' } else { Result 0 '' } }
        { Initialize-AppDatabase -PgRoot 'P' -Port 5433 -Password 'pw' } | Should -Throw '*disk-70*'
    }
}

Describe 'Get-PostgresEnvironment' {
    It 'points node.exe at loopback' {
        $e = Get-PostgresEnvironment -Port 5999 -Password 'pw-71'
        $e.POSTGRES_HOST, $e.POSTGRES_PORT, $e.POSTGRES_DB, $e.POSTGRES_USER, $e.POSTGRES_PASSWORD |
            Should -Be @('127.0.0.1', '5999', 'identityatlas', 'identityatlas', 'pw-71')
    }
}

Describe 'Launcher lock' -Skip:(-not $IsWindows) {
    It 'admits one launcher per data directory, and the next once it is released' {
        $d = Join-Path $TestDrive 'lock'
        $first = Enter-LauncherLock -DataDir $d
        try {
            $first | Should -Not -BeNullOrEmpty
            Enter-LauncherLock -DataDir $d | Should -BeNullOrEmpty
        } finally { $first.Dispose() }
        $again = Enter-LauncherLock -DataDir $d
        $again | Should -Not -BeNullOrEmpty
        $again.Dispose()
    }
}

Describe 'Orphaned node.exe' {
    BeforeEach {
        $d = Join-Path $TestDrive ([guid]::NewGuid()); $null = New-Item -ItemType Directory $d -Force
        $self = [System.Diagnostics.Process]::GetCurrentProcess()
        Save-LauncherState -DataDir $d -Node $self
        $state = Join-Path $d 'launcher.state.json'
        Mock Stop-Process {}
    }
    It 'records the pid and start time' {
        $s = Get-Content $state -Raw | ConvertFrom-Json
        $s.nodePid | Should -Be $self.Id
        $s.nodeStartTicks | Should -Be $self.StartTime.ToUniversalTime().Ticks
    }
    It 'stops the recorded node.exe and clears the record' {
        $fake = [pscustomobject]@{ Id = $self.Id; ProcessName = 'node'; StartTime = $self.StartTime }
        $fake | Add-Member ScriptMethod WaitForExit { param($ms) $true }
        Mock Get-Process { $fake }
        Stop-OrphanedNode -DataDir $d | Should -BeTrue
        Should -Invoke Stop-Process -Times 1 -Exactly -ParameterFilter { $Id -eq $self.Id }
        $state | Should -Not -Exist
    }
    It 'leaves a process that reused the pid alone' {
        $fake = [pscustomobject]@{ Id = $self.Id; ProcessName = 'node'; StartTime = $self.StartTime.AddMilliseconds(-1) }
        Mock Get-Process { $fake }
        Stop-OrphanedNode -DataDir $d | Should -BeFalse
        Should -Invoke Stop-Process -Times 0
        $state | Should -Not -Exist
    }
    It 'leaves a process that is not node.exe alone' {
        Stop-OrphanedNode -DataDir $d | Should -BeFalse     # the recorded pid is this pwsh
        Should -Invoke Stop-Process -Times 0
    }
    It 'does nothing without a record' {
        Clear-LauncherState -DataDir $d
        Stop-OrphanedNode -DataDir $d | Should -BeFalse
    }
}

Describe 'Get-PostmasterProcess' {
    BeforeEach { $h = Join-Path $TestDrive ([guid]::NewGuid()); $null = New-Item -ItemType Directory (Join-Path $h 'data') -Force }
    It 'is $null without postmaster.pid' {
        Get-PostmasterProcess -PgHome $h | Should -BeNullOrEmpty
    }
    It 'reads the pid from the first line and requires a postgres process' {
        Set-Content (Join-Path $h 'data' 'postmaster.pid') "4242`n$h`n"
        Mock Get-Process { [pscustomobject]@{ Id = 4242; ProcessName = 'postgres' } } -ParameterFilter { $Id -eq 4242 }
        (Get-PostmasterProcess -PgHome $h).Id | Should -Be 4242
        Mock Get-Process { [pscustomobject]@{ Id = 4242; ProcessName = 'notepad' } } -ParameterFilter { $Id -eq 4242 }
        Get-PostmasterProcess -PgHome $h | Should -BeNullOrEmpty
    }
}

Describe 'Health and run loops' {
    BeforeEach { Mock Start-Sleep {} }

    It 'Get-AppHealth probes 127.0.0.1 and returns $null when nothing answers' {
        Mock Invoke-RestMethod { [pscustomobject]@{ status = 'ok'; schemaReady = $true } } -ParameterFilter { $Uri -eq 'http://127.0.0.1:3999/api/health' }
        (Get-AppHealth -Port 3999).schemaReady | Should -BeTrue
        Mock Invoke-RestMethod { throw 'refused' }
        Get-AppHealth -Port 3998 | Should -BeNullOrEmpty
    }

    Context 'Wait-AppReady' {
        It 'waits for the migrated schema, not just an open port' {
            $script:n = 0
            Mock Get-AppHealth { $script:n++; switch ($script:n) { 1 { $null } { $_ -in 2, 3 } { @{ schemaReady = $false } } default { @{ schemaReady = $true } } } }
            Mock Write-Host {}
            Wait-AppReady -Node (New-FakeNode) -Port 1
            $script:n | Should -Be 4
            Should -Invoke Write-Host -Times 1 -Exactly -ParameterFilter { "$Object" -match 'migrating' }
        }
        It 'fails at once with the exit code when node.exe dies' {
            Mock Get-AppHealth { $null }
            { Wait-AppReady -Node (New-FakeNode -Exited $true -ExitCode 9) -Port 1 -CrashLog 'C:\d\startup-error.log' } |
                Should -Throw '*exited during startup with code 9*startup-error.log*'
            Should -Invoke Get-AppHealth -Times 0
        }
        It 'warns once when slow but never stops the process' {
            $script:n = 0
            Mock Get-AppHealth { $script:n++; if ($script:n -ge 3) { @{ schemaReady = $true } } }
            Mock Stop-Process {}
            Wait-AppReady -Node (New-FakeNode) -Port 1 -WarnAfterSec 0 -WarningVariable w -WarningAction SilentlyContinue
            @($w).Count | Should -Be 1
            Should -Invoke Stop-Process -Times 0
        }
    }

    Context 'Wait-AppExit' {
        It 'reports node.exe exiting' {
            Wait-AppExit -Node (New-FakeNode -Exited $true -ExitCode 4) | Should -Be 'Identity Atlas exited with code 4.'
        }
        It 'reports the database going away' {
            $script:n = 0
            Wait-AppExit -Node (New-FakeNode) -DatabaseAlive { $script:n++; $script:n -lt 3 } | Should -Match 'PostgreSQL stopped unexpectedly'
            $script:n | Should -Be 3
        }
    }
}

Describe 'Resolve-DatabaseChoice' {
    BeforeEach {
        $d = Join-Path $TestDrive ([guid]::NewGuid()); $null = New-Item -ItemType Directory $d -Force
        Remove-Item Env:DATABASE_URL, Env:POSTGRES_HOST -ErrorAction SilentlyContinue
    }
    It 'uses Postgres when the binaries run, and only then carries the root' {
        Mock Test-PostgresBinaries { $null }
        $c = Resolve-DatabaseChoice -PgRoot 'R' -DataDir $d
        $c.Mode | Should -Be 'Postgres'
        $c.PgRoot | Should -Be 'R'
    }
    It 'falls back to PGlite, with a warning, on a fresh install whose binaries cannot run' {
        Mock Test-PostgresBinaries { 'blocked-72' }
        $c = Resolve-DatabaseChoice -PgRoot 'R' -DataDir $d -WarningVariable w -WarningAction SilentlyContinue
        $c.Mode | Should -Be 'PGlite'
        $c.PgRoot | Should -BeNullOrEmpty
        $w | Should -Match 'blocked-72'
    }
    It 'refuses to fall back when a cluster already holds the data' {
        Mock Test-PostgresBinaries { 'blocked-73' }
        $null = New-Item -ItemType Directory (Join-Path $d 'postgres' 'data') -Force
        Set-Content (Join-Path $d 'postgres' 'data' 'PG_VERSION') '16'
        { Resolve-DatabaseChoice -PgRoot 'R' -DataDir $d } | Should -Throw '*blocked-73*'
    }
    It 'refuses to fall back when Postgres was asked for' {
        Mock Test-PostgresBinaries { 'blocked-74' }
        { Resolve-DatabaseChoice -Requested 'Postgres' -PgRoot 'R' -DataDir $d } | Should -Throw '*blocked-74*'
    }
    It 'keeps existing PGlite data without running the preflight' {
        Mock Test-PostgresBinaries { throw 'must not run' }
        $null = New-Item -ItemType Directory (Join-Path $d 'pgdata') -Force; Set-Content (Join-Path $d 'pgdata' 'PG_VERSION') '16'
        $c = Resolve-DatabaseChoice -PgRoot 'R' -DataDir $d
        $c.Mode | Should -Be 'PGlite'
        $c.PgRoot | Should -BeNullOrEmpty
    }
    It 'sees an external server configured in the environment' {
        $env:POSTGRES_HOST = 'db'
        try { (Resolve-DatabaseChoice -PgRoot 'R' -DataDir $d).Mode | Should -Be 'External' } finally { Remove-Item Env:POSTGRES_HOST }
    }
}

Describe 'Start-BundledPostgres' {
    BeforeEach {
        $script:calls = [System.Collections.Generic.List[string]]::new()
        Mock Get-TotalMemoryBytes { 16GB }
        Mock Initialize-PostgresCluster { $script:calls.Add("init:$TotalBytes"); $false }
        Mock Stop-PostgresServer { $script:calls.Add('stop') }
        Mock Start-PostgresServer { $script:calls.Add("start:$Port") }
        Mock Wait-PostgresReady { $script:calls.Add("wait:$WarnAfterSec") }
        Mock Get-DbPassword { 'pw-75' }
        Mock Initialize-AppDatabase { $script:calls.Add("db:$Password"); $true }
        Mock Write-Host {}
    }
    It 'initialises, starts, waits and creates the database, in that order' {
        Mock Test-PostgresRunning { $false }
        $e = Start-BundledPostgres -PgRoot 'R' -PgHome 'H' -Port 5999 -WarnAfterSec 42
        $script:calls | Should -Be @("init:$(16GB)", 'start:5999', 'wait:42', 'db:pw-75')
        $e.POSTGRES_PASSWORD | Should -Be 'pw-75'
        $e.POSTGRES_PORT | Should -Be '5999'
    }
    It 'cleanly restarts a server a dead launcher left running' {
        Mock Test-PostgresRunning { $true }
        $null = Start-BundledPostgres -PgRoot 'R' -PgHome 'H' -Port 5999
        $script:calls[1..2] | Should -Be @('stop', 'start:5999')
    }
}

Describe 'Set-ChildDatabaseEnvironment' {
    AfterEach { Set-ChildDatabaseEnvironment }
    It 'drops an inherited DATABASE_URL, which would otherwise win in connection.js' {
        $env:DATABASE_URL = 'postgresql://stale'; $env:POSTGRES_PASSWORD = 'old'
        Set-ChildDatabaseEnvironment -Values ([ordered]@{ POSTGRES_HOST = '127.0.0.1'; POSTGRES_PORT = '5433' })
        $env:DATABASE_URL | Should -BeNullOrEmpty
        $env:POSTGRES_PASSWORD | Should -BeNullOrEmpty
        $env:POSTGRES_HOST | Should -Be '127.0.0.1'
        $env:POSTGRES_PORT | Should -Be '5433'
    }
    It 'clears everything when given nothing' {
        $env:POSTGRES_HOST = 'x'
        Set-ChildDatabaseEnvironment
        $env:POSTGRES_HOST | Should -BeNullOrEmpty
    }
}

Describe 'Stop-NodeProcess' {
    BeforeEach { Mock Stop-Process {} }
    It 'ignores a missing or finished process' {
        Stop-NodeProcess -Node $null
        Stop-NodeProcess -Node (New-FakeNode -Exited $true)
        Should -Invoke Stop-Process -Times 0
    }
    It 'lets node.exe finish its own Ctrl+C shutdown' {
        $n = New-FakeNode -ExitsInGrace $true
        Stop-NodeProcess -Node $n -GraceMs 1234
        $n.Waited | Should -Be 1234
        Should -Invoke Stop-Process -Times 0
    }
    It 'ends it when it does not' {
        Stop-NodeProcess -Node (New-FakeNode -ExitsInGrace $false)
        Should -Invoke Stop-Process -Times 1 -Exactly -ParameterFilter { $Id -eq 4711 -and $Force }
    }
}

Describe 'Test-ClusterExists / Test-PgliteData' {
    It 'look for PG_VERSION, not just the folder' {
        $d = Join-Path $TestDrive 'ex'
        $null = New-Item -ItemType Directory (Join-Path $d 'postgres' 'data'), (Join-Path $d 'pgdata') -Force
        Test-ClusterExists -PgHome (Join-Path $d 'postgres') | Should -BeFalse
        Test-PgliteData -DataDir $d | Should -BeFalse
        Set-Content (Join-Path $d 'postgres' 'data' 'PG_VERSION') '16'; Set-Content (Join-Path $d 'pgdata' 'PG_VERSION') '16'
        Test-ClusterExists -PgHome (Join-Path $d 'postgres') | Should -BeTrue
        Test-PgliteData -DataDir $d | Should -BeTrue
    }
}

Describe 'Initialize-ChosenDatabase' {
    BeforeEach {
        Mock Start-BundledPostgres { [ordered]@{ POSTGRES_HOST = '127.0.0.1'; POSTGRES_PORT = "$Port" } }
        Mock Set-ChildDatabaseEnvironment {}
    }
    It 'Postgres: starts the bundled server and hands its settings on' {
        Initialize-ChosenDatabase -Choice @{ Mode = 'Postgres'; PgRoot = 'R' } -PgHome 'H' -Port 5999 -WarnAfterSec 7
        Should -Invoke Start-BundledPostgres -Times 1 -Exactly -ParameterFilter { $PgRoot -eq 'R' -and $Port -eq 5999 -and $WarnAfterSec -eq 7 }
        Should -Invoke Set-ChildDatabaseEnvironment -Times 1 -Exactly -ParameterFilter { $Values.POSTGRES_PORT -eq '5999' }
    }
    It 'PGlite: clears any inherited server settings' {
        Initialize-ChosenDatabase -Choice @{ Mode = 'PGlite' } -PgHome 'H' -Port 1
        Should -Invoke Set-ChildDatabaseEnvironment -Times 1 -Exactly -ParameterFilter { -not $Values -or $Values.Count -eq 0 }
        Should -Invoke Start-BundledPostgres -Times 0
    }
    It 'External: leaves the inherited settings alone' {
        Initialize-ChosenDatabase -Choice @{ Mode = 'External' } -PgHome 'H' -Port 1
        Should -Invoke Set-ChildDatabaseEnvironment -Times 0
        Should -Invoke Start-BundledPostgres -Times 0
    }
}

Describe 'Start-AppProcess' {
    BeforeEach {
        $self = [System.Diagnostics.Process]::GetCurrentProcess()
        Mock Start-Process { $self }
        Mock Save-LauncherState {}
    }
    AfterEach { Remove-Item Env:IA_DATA_DIR, Env:PORT, Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue }
    It 'starts bootstrap.mjs with the data dir and port, records it, then drops the password' {
        $env:POSTGRES_PASSWORD = 'pw-76'
        $dir = Join-Path $TestDrive 'A B'
        $captured = @{}
        Mock Start-Process { $captured.Env = "$env:IA_DATA_DIR|$env:PORT|$env:POSTGRES_PASSWORD"; $self }
        Start-AppProcess -ScriptDir $dir -DataDir 'D' -Port 3999 | Should -Be $self
        $captured.Env | Should -Be 'D|3999|pw-76'
        Should -Invoke Start-Process -Times 1 -Exactly -ParameterFilter {
            $FilePath -eq (Join-Path $dir 'node.exe') -and $ArgumentList -eq ('"' + (Join-Path $dir 'bootstrap.mjs') + '"') -and $NoNewWindow
        }
        Should -Invoke Save-LauncherState -Times 1 -Exactly -ParameterFilter { $DataDir -eq 'D' }
        $env:POSTGRES_PASSWORD | Should -BeNullOrEmpty
    }
}

Describe 'Enter-LauncherLock -WaitMs' -Skip:(-not $IsWindows) {
    It 'gives up after the wait, having retried' {
        $d = Join-Path $TestDrive 'lockwait'
        $held = Enter-LauncherLock -DataDir $d
        try {
            # Count the sleeps ourselves rather than asserting `-Times 1`, which is
            # an AT-LEAST assertion and so cannot tell one sleep from thirty. The
            # exact count is timing-dependent (the mock makes each sleep free, so the
            # loop spins until the deadline), but "more than one" is the claim that
            # matters: it retried rather than waiting once and giving up.
            $script:sleeps = 0
            Mock Start-Sleep { $script:sleeps++ }
            $script:t = [DateTime]::UtcNow
            Enter-LauncherLock -DataDir $d -WaitMs 300 -PollMs 10 | Should -BeNullOrEmpty
            ([DateTime]::UtcNow - $script:t).TotalMilliseconds | Should -BeGreaterOrEqual 300
            $script:sleeps | Should -BeGreaterThan 1
        } finally { $held.Dispose() }
    }
}

Describe 'Invoke-LauncherCleanup' {
    BeforeEach {
        $script:order = [System.Collections.Generic.List[string]]::new()
        $script:disposed = $false
        $fakeLock = [pscustomobject]@{}
        $fakeLock | Add-Member ScriptMethod Dispose { $script:disposed = $true }
        Mock Enter-LauncherLock { $fakeLock }
        Mock Stop-OrphanedNode { $script:order.Add('node'); $true }
        Mock Stop-PostgresServer { $script:order.Add("pg:$PgHome") }
    }
    It 'stops node.exe, then PostgreSQL, under the lock' {
        Invoke-LauncherCleanup -DataDir 'D' -PgRoot 'R' | Should -BeTrue
        $script:order | Should -Be @('node', "pg:$(Join-Path 'D' 'postgres')")
        $script:disposed | Should -BeTrue
        Should -Invoke Enter-LauncherLock -Times 1 -Exactly -ParameterFilter { $WaitMs -eq 5000 }
    }
    It 'leaves PostgreSQL alone in PGlite mode' {
        Invoke-LauncherCleanup -DataDir 'D' | Should -BeTrue
        $script:order | Should -Be @('node')
    }
    It 'touches nothing when a newer launcher owns the data directory' {
        Mock Enter-LauncherLock { $null }
        Invoke-LauncherCleanup -DataDir 'D' -PgRoot 'R' | Should -BeFalse
        Should -Invoke Stop-OrphanedNode -Times 0
        Should -Invoke Stop-PostgresServer -Times 0
    }
    It 'releases the lock even when a step fails' {
        Mock Stop-PostgresServer { throw 'pg-77' }
        { Invoke-LauncherCleanup -DataDir 'D' -PgRoot 'R' } | Should -Throw '*pg-77*'
        $script:disposed | Should -BeTrue
    }
}

Describe 'Start-LauncherWatchdog' {
    BeforeEach { Mock Start-Process { 'started' } }
    # Paths here are deliberately NOT drive-qualified. Join-Path resolves the drive
    # through the provider, so a literal 'C:\...' throws DriveNotFoundException when
    # the suite runs on the Linux CI runner. The spaces are the part that matters:
    # they are what the argument quoting has to survive.
    It 'starts the watchdog hidden, with the policy, launcher pid, data dir and PostgreSQL root' {
        Start-LauncherWatchdog -ScriptDir 'app dir' -DataDir 'data dir' -PgRoot 'pg' -LauncherPid 4321 | Should -Be 'started'
        Should -Invoke Start-Process -Times 1 -Exactly -ParameterFilter {
            $WindowStyle -eq 'Hidden' -and $FilePath -eq (Get-Process -Id $PID).Path -and
            $ArgumentList -eq ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path 'app dir' 'Watch-IdentityAtlas.ps1') +
                               '" -LauncherPid 4321 -DataDir "data dir" -PgRoot pg')
        }
    }
    It 'omits -PgRoot in PGlite mode and defaults to this process' {
        $null = Start-LauncherWatchdog -ScriptDir 'A' -DataDir 'D'
        Should -Invoke Start-Process -Times 1 -Exactly -ParameterFilter {
            $ArgumentList -match "-LauncherPid $PID -DataDir D$" -and $ArgumentList -notmatch 'PgRoot'
        }
    }
}

Describe 'Show-OtherLauncher' {
    BeforeEach { Mock Start-Process {}; Mock Write-Host {} }
    It 'reports a ready app and opens it' {
        Mock Get-AppHealth { @{ schemaReady = $true } }
        Show-OtherLauncher -Port 3999 -DataDir 'D' -OpenBrowser | Should -Be 0
        Should -Invoke Start-Process -Times 1 -Exactly -ParameterFilter { $FilePath -eq 'http://localhost:3999' }
    }
    It 'does not open the browser when asked not to' {
        Mock Get-AppHealth { @{ schemaReady = $true } }
        Show-OtherLauncher -Port 3999 -DataDir 'D' | Should -Be 0
        Should -Invoke Start-Process -Times 0
    }
    It 'says "still starting", without a browser, while the schema migrates' {
        Mock Get-AppHealth { @{ schemaReady = $false } }
        Show-OtherLauncher -Port 3999 -DataDir 'D' -OpenBrowser | Should -Be 1
        Should -Invoke Start-Process -Times 0
        Should -Invoke Write-Host -Times 1 -Exactly -ParameterFilter { "$Object" -match 'still starting from D' }
    }
    It 'says "still starting" when nothing answers yet' {
        Mock Get-AppHealth { $null }
        Show-OtherLauncher -Port 3999 -DataDir 'D' -OpenBrowser | Should -Be 1
        Should -Invoke Start-Process -Times 0
    }
}
