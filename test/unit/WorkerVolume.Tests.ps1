#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Startup repair of the job trace directory for the non-root worker image
    (setup/docker/WorkerVolume.ps1, SEC-2026-09 M-14).

.DESCRIPTION
    A root-owned trace directory cannot be produced on a Windows dev box, so
    "not writable" is simulated by mocking Test-WorkerDirectoryWritable; the rename,
    recreate and log copy run against the real TestDrive filesystem.

.USAGE
    Invoke-Pester -Path test/unit/WorkerVolume.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $root 'setup/docker/WorkerVolume.ps1')
}

Describe 'Test-WorkerDirectoryWritable' {
    It 'is true for a writable directory and leaves no probe file behind' {
        $dir = Join-Path $TestDrive 'writable'
        New-Item -ItemType Directory -Path $dir | Out-Null
        Test-WorkerDirectoryWritable -Path $dir | Should -BeTrue
        @(Get-ChildItem -LiteralPath $dir -Force).Count | Should -Be 0
    }

    It 'is false when the probe file cannot be created' {
        Test-WorkerDirectoryWritable -Path (Join-Path $TestDrive 'does-not-exist') | Should -BeFalse
    }
}

Describe 'Repair-WorkerTraceDirectory' {
    BeforeEach {
        $script:uploads  = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $script:traceDir = Join-Path $script:uploads 'jobs'
        New-Item -ItemType Directory -Path $script:uploads | Out-Null
    }

    It 'does nothing when the directory does not exist yet (the dispatcher creates it)' {
        Repair-WorkerTraceDirectory -TraceDir $script:traceDir | Should -Be 'absent'
        Test-Path $script:traceDir | Should -BeFalse
    }

    It 'leaves a writable directory and its logs untouched' {
        New-Item -ItemType Directory -Path $script:traceDir | Out-Null
        Set-Content -LiteralPath (Join-Path $script:traceDir '7.log') -Value 'job seven'
        Repair-WorkerTraceDirectory -TraceDir $script:traceDir | Should -Be 'ok'
        @(Get-ChildItem -LiteralPath $script:uploads).Name | Should -Be @('jobs')
        Get-Content -LiteralPath (Join-Path $script:traceDir '7.log') | Should -Be 'job seven'
    }

    It 'moves an unwritable directory aside, recreates it and carries the job logs over' {
        New-Item -ItemType Directory -Path $script:traceDir | Out-Null
        Set-Content -LiteralPath (Join-Path $script:traceDir '41.log') -Value 'job forty-one'
        Set-Content -LiteralPath (Join-Path $script:traceDir 'notes.txt') -Value 'not a log'
        Mock Test-WorkerDirectoryWritable { $false }

        Repair-WorkerTraceDirectory -TraceDir $script:traceDir | Should -Be 'repaired'

        $stale = @(Get-ChildItem -LiteralPath $script:uploads -Directory | Where-Object Name -Like 'jobs.root-owned-*')
        $stale.Count | Should -Be 1
        Get-Content -LiteralPath (Join-Path $stale[0].FullName '41.log') | Should -Be 'job forty-one'
        @(Get-ChildItem -LiteralPath $script:traceDir).Name | Should -Be @('41.log')
        Get-Content -LiteralPath (Join-Path $script:traceDir '41.log') | Should -Be 'job forty-one'
    }

    It 'reports unwritable, without throwing, when the directory cannot be moved aside' {
        New-Item -ItemType Directory -Path $script:traceDir | Out-Null
        Mock Test-WorkerDirectoryWritable { $false }
        Mock Rename-Item { throw 'Permission denied' }
        Mock Write-Host {}

        Repair-WorkerTraceDirectory -TraceDir $script:traceDir | Should -Be 'unwritable'
        Should -Invoke Write-Host -ParameterFilter { "$Object" -like '*chown -R 1000:1000*' } -Exactly 1
        Test-Path $script:traceDir | Should -BeTrue
    }
}
