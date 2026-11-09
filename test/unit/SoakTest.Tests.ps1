#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }
<#
.SYNOPSIS
    The soak test measures memory from the Docker host, and fails when it cannot.

.DESCRIPTION
    test/nightly/Test-SoakTest.ps1 took its memory baseline from the API's
    /admin/container-stats, which #213 removed. It then skipped on every run and
    recorded the skip as a PASS, so a step named "Soak test (15 min)" finished in
    0 minutes, green, for months (#721). These tests hold the parts that made
    that possible: the memory reading, the verdict on a missing reading, and the
    two thresholds.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'test' 'nightly' 'SoakTest.Functions.ps1')
}

Describe 'ConvertFrom-DockerMemUsage' {
    It 'reads <MemUsage> as <Bytes> bytes' -ForEach @(
        @{ MemUsage = '95.5MiB / 7.75GiB'; Bytes = 100139008 }
        @{ MemUsage = '1.5GiB / 8GiB';     Bytes = 1610612736 }
        @{ MemUsage = '512KiB / 1GiB';     Bytes = 524288 }
        @{ MemUsage = '12.5MB / 8GB';      Bytes = 12500000 }
        @{ MemUsage = '800kB / 1GB';       Bytes = 800000 }
        @{ MemUsage = '0B / 0B';           Bytes = 0 }
    ) {
        ConvertFrom-DockerMemUsage $MemUsage | Should -Be $Bytes
    }

    It 'returns nothing for <MemUsage>' -ForEach @(
        @{ MemUsage = '' }
        @{ MemUsage = '--' }
        @{ MemUsage = '95.5mib / 7.75gib' }
    ) {
        ConvertFrom-DockerMemUsage $MemUsage | Should -BeNullOrEmpty
    }
}

Describe 'Get-WebContainerMemory' {
    It 'reads the MemUsage of the container it is given' {
        Mock Invoke-DockerStats { '{"Name":"ia-web-1","MemUsage":"200MiB / 7.75GiB","CPUPerc":"1.2%"}' }
        Get-WebContainerMemory -Container 'abc123' | Should -Be (200 * 1MB)
        Should -Invoke Invoke-DockerStats -Times 1 -Exactly -ParameterFilter { $Container -eq 'abc123' }
    }

    It 'returns nothing when docker gives no reading' {
        Mock Invoke-DockerStats { $null }
        Get-WebContainerMemory -Container 'abc123' | Should -BeNullOrEmpty
    }

    It 'returns nothing when docker prints something other than JSON' {
        Mock Invoke-DockerStats { 'Error response from daemon: No such container: abc123' }
        Get-WebContainerMemory -Container 'abc123' | Should -BeNullOrEmpty
    }

    It 'does not call docker without a container' {
        Mock Invoke-DockerStats { throw 'must not be called' }
        Get-WebContainerMemory -Container '' | Should -BeNullOrEmpty
        Should -Invoke Invoke-DockerStats -Times 0 -Exactly
    }
}

Describe 'The docker calls, against a docker executable' {
    # A real executable, not a Mock: the first CI run failed on how PowerShell
    # handles a NATIVE command's output and exit code (Select-Object -First 1
    # left $LASTEXITCODE unset), which a mocked PowerShell function cannot show.
    BeforeAll {
        $script:savedPath = $env:PATH
        $bin = Join-Path $TestDrive 'bin'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        if ($IsWindows) {
            Set-Content (Join-Path $bin 'docker.cmd') -Value @(
                '@echo off'
                'if "%1"=="compose" echo.'
                'if "%1"=="compose" echo c0ffee123'
                'if "%1"=="stats" echo {"Name":"ia-web-1","MemUsage":"200MiB / 7.75GiB"}'
                'if defined FAKE_DOCKER_EXIT exit /b %FAKE_DOCKER_EXIT%'
                'exit /b 0'
            )
        } else {
            $sh = Join-Path $bin 'docker'
            Set-Content $sh -Value @(
                '#!/bin/sh'
                'case "$1" in'
                '  compose) echo; echo c0ffee123 ;;'
                '  stats) echo ''{"Name":"ia-web-1","MemUsage":"200MiB / 7.75GiB"}'' ;;'
                'esac'
                'exit ${FAKE_DOCKER_EXIT:-0}'
            )
            chmod +x $sh
        }
        $env:PATH = "$bin$([IO.Path]::PathSeparator)$env:PATH"
    }
    AfterAll {
        $env:PATH = $script:savedPath
    }
    AfterEach {
        $env:FAKE_DOCKER_EXIT = $null
    }

    It 'resolves the compose service to its container id' {
        Resolve-SoakContainer -ComposeFile 'docker-compose.ci.yml' | Should -Be 'c0ffee123'
    }

    It 'reads the memory docker stats reports' {
        Get-WebContainerMemory -Container 'c0ffee123' | Should -Be (200 * 1MB)
    }

    It 'returns nothing when docker exits non-zero' {
        $env:FAKE_DOCKER_EXIT = '1'
        Resolve-SoakContainer -ComposeFile 'docker-compose.ci.yml' | Should -BeNullOrEmpty
        Get-WebContainerMemory -Container 'c0ffee123' | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-SoakTest' {
    BeforeEach {
        $results = @{}
        $WriteResult = { param($Name, $Passed, $Detail) $results[$Name] = @{ Passed = $Passed; Detail = $Detail } }
        $DurationMinutes = 15
        $ApiBaseUrl = 'http://localhost:3001/api'
        $Container = 'abc123'
        Mock Invoke-SoakWarmUp { }
        Mock Write-Host { }
        Mock Invoke-SoakLoop { $script:totalRequests = 900; $script:totalErrors = 0; $script:memorySamples = @() }
    }

    It 'FAILS, and does not run the loop, when no web container is running' {
        $Container = ''
        Invoke-SoakTest
        $results['Soak/InitialMemory'].Passed | Should -BeFalse
        Should -Invoke Invoke-SoakLoop -Times 0 -Exactly
    }

    It 'FAILS, naming the container, when the baseline cannot be read' {
        Mock Get-WebContainerMemory { $null }
        Invoke-SoakTest
        $results['Soak/InitialMemory'].Passed | Should -BeFalse
        $results['Soak/InitialMemory'].Detail | Should -Match 'abc123'
        Should -Invoke Invoke-SoakLoop -Times 0 -Exactly
    }

    It 'takes the baseline after the warm-up pass' {
        $script:order = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-SoakWarmUp { $script:order.Add('warm-up') }
        Mock Get-WebContainerMemory { $script:order.Add('read'); 100MB }
        Invoke-SoakTest
        $script:order[0..1] -join ',' | Should -Be 'warm-up,read'
    }

    It 'passes a run that ends at 1.99x its baseline with no errors' {
        $script:reads = [System.Collections.Generic.Queue[long]]::new([long[]]@(100MB, 199MB))
        Mock Get-WebContainerMemory { $script:reads.Dequeue() }
        Invoke-SoakTest
        $results['Soak/InitialMemory'].Passed | Should -BeTrue
        $results['Soak/FinalMemory'].Passed | Should -BeTrue
        $results['Soak/NoMemoryLeak'].Passed | Should -BeTrue
        $results['Soak/ThroughputOK'].Passed | Should -BeTrue
        Should -Invoke Invoke-SoakLoop -Times 1 -Exactly -ParameterFilter { $InitialMemory -eq 100MB }
    }

    It 'fails a run that ends at exactly 2x its baseline' {
        $script:reads = [System.Collections.Generic.Queue[long]]::new([long[]]@(100MB, 200MB))
        Mock Get-WebContainerMemory { $script:reads.Dequeue() }
        Invoke-SoakTest
        $results['Soak/NoMemoryLeak'].Passed | Should -BeFalse
        $results['Soak/NoMemoryLeak'].Detail | Should -Match 'ratio=2x'
    }

    It 'fails both memory checks when the final reading is missing' {
        $script:reads = [System.Collections.Generic.Queue[object]]::new([object[]]@(100MB, $null))
        Mock Get-WebContainerMemory { $script:reads.Dequeue() }
        Invoke-SoakTest
        $results['Soak/FinalMemory'].Passed | Should -BeFalse
        $results['Soak/NoMemoryLeak'].Passed | Should -BeFalse
    }
}

Describe 'Assert-SoakThroughput' {
    BeforeEach {
        $results = @{}
        $WriteResult = { param($Name, $Passed, $Detail) $results[$Name] = @{ Passed = $Passed; Detail = $Detail } }
        Mock Write-Host { }
    }

    It 'passes 9 errors in 1000 requests (0.9%)' {
        $totalRequests = 1000; $totalErrors = 9
        Assert-SoakThroughput
        $results['Soak/ThroughputOK'].Passed | Should -BeTrue
    }

    It 'fails 10 errors in 1000 requests (1%)' {
        $totalRequests = 1000; $totalErrors = 10
        Assert-SoakThroughput
        $results['Soak/ThroughputOK'].Passed | Should -BeFalse
    }

    It 'fails a run that made no requests at all' {
        $totalRequests = 0; $totalErrors = 0
        Assert-SoakThroughput
        $results['Soak/ThroughputOK'].Passed | Should -BeFalse
    }
}

Describe 'Write-Result without a callback' {
    It 'counts a failure toward the exit code, and a pass not at all' {
        $WriteResult = $null
        Mock Write-Host { }
        $script:standaloneFailures = 0
        Write-Result 'x' $true
        Write-Result 'y' $false
        $script:standaloneFailures | Should -Be 1
    }
}

Describe 'Nothing calls the removed /admin/container-stats endpoint' {
    It 'no script or workflow requests it' {
        # #213 removed the endpoint and the docker.sock mount behind it; two callers
        # under test/nightly/ were missed and failed or skipped silently for months.
        # Prose may still name it (to say it must not return); a URL built from a
        # variable or a quoted path is a call.
        $hits = Get-ChildItem (Join-Path $script:repoRoot 'test'), (Join-Path $script:repoRoot '.github') -Recurse -File -Include '*.ps1', '*.yml', '*.sh', '*.js' |
            Where-Object { $_.FullName -ne $PSCommandPath } |
            Select-String -Pattern '(\$\w+|[''"])/admin/container-stats' |
            ForEach-Object { "$($_.Path):$($_.LineNumber)" }
        $hits | Should -BeNullOrEmpty
    }
}
