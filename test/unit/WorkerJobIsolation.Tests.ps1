#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester tests for how the worker hands a job to its own pwsh process.

.DESCRIPTION
    SEC-2026-09 L-08: every job used to run inside the long-lived scheduler
    process, so the token, client secret and tenant id one job left in $global:
    were still set for the next job. Invoke-CrawlerJobProcess.ps1 now runs each job
    as a child `pwsh -File`, and these tests prove a second job cannot see what the
    first one left behind.

    SEC-2026-09 L-06: the job config (decrypted credentials) and the API key must
    never be on a process command line, where every local process can read them and
    the transcript header records them. The config goes over stdin, the key through
    IA_JOB_API_KEY, and the dispatcher's transcript uses a minimal header.

    The first block drives Invoke-CrawlerJobProcess against a stand-in dispatcher
    that reports what it received; the second drives the real Invoke-CrawlerJob.ps1.

.USAGE
    Invoke-Pester -Path test/unit/WorkerJobIsolation.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:dispatcher = Join-Path $script:repoRoot 'setup' 'docker' 'Invoke-CrawlerJob.ps1'
    . (Join-Path $script:repoRoot 'setup' 'docker' 'Invoke-CrawlerJobProcess.ps1')

    $script:work = Join-Path ([System.IO.Path]::GetTempPath()) "worker-isolation-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $script:work | Out-Null

    # Stand-in dispatcher: records exactly what the child process was given, then
    # leaves a credential in $global: the way Get-FGAccessToken does.
    $script:fakeDispatcher = Join-Path $script:work 'Fake-CrawlerJob.ps1'
    Set-Content -Path $script:fakeDispatcher -Encoding UTF8 -Value @'
param([int]$JobId, [string]$JobType, [switch]$ConfigFromStdin, [string]$ResultPath)
$report = [ordered]@{
    commandLine = [Environment]::CommandLine
    stdin       = [Console]::In.ReadToEnd()
    envKey      = $env:IA_JOB_API_KEY
    leftover    = [string]$global:ClientSecret
    jobType     = $JobType
    fromStdin   = [bool]$ConfigFromStdin
}
$global:ClientSecret = "secret-of-job-$JobId"
$report | ConvertTo-Json | Set-Content -Path (Join-Path $env:IA_TEST_OUT "$JobId.json")
if ($JobType -eq 'fail-with-message') { Set-Content -Path $ResultPath -Value 'Graph refused the token'; exit 1 }
if ($JobType -eq 'fail-silent') { exit 3 }
'@

    function Get-JobReport {
        param([int]$JobId)
        Get-Content (Join-Path $script:work "$JobId.json") -Raw | ConvertFrom-Json
    }

    $script:savedEnv = @{}
    foreach ($name in 'IA_TEST_OUT', 'IA_APP_ROOT', 'TRACE_DIR', 'IA_JOB_API_KEY') {
        $script:savedEnv[$name] = [Environment]::GetEnvironmentVariable($name)
    }
    $env:IA_TEST_OUT = $script:work
}

AfterAll {
    foreach ($name in $script:savedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $script:savedEnv[$name]) }
    Remove-Variable -Name ClientSecret -Scope Global -ErrorAction SilentlyContinue
    Remove-Item $script:work -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Invoke-CrawlerJobProcess — what the child process receives' {
    It 'passes the config on stdin and the key in the environment, never on the command line' {
        $config = @{ tenantId = 't-1'; clientSecret = 'CFG-SENTINEL-51'; nested = @{ password = 'NESTED-SENTINEL-52' } }
        Invoke-CrawlerJobProcess -JobId 101 -JobType 'entra-id' -Config $config -ApiKey 'fgc_KEY-SENTINEL-53' `
            -DispatcherPath $script:fakeDispatcher

        $r = Get-JobReport 101
        $r.commandLine | Should -Not -Match 'SENTINEL'
        $r.commandLine | Should -Match '-ConfigFromStdin'
        $r.fromStdin   | Should -BeTrue
        $r.jobType     | Should -Be 'entra-id'
        $r.envKey      | Should -Be 'fgc_KEY-SENTINEL-53'
        $received = $r.stdin | ConvertFrom-Json -AsHashtable
        $received.clientSecret    | Should -Be 'CFG-SENTINEL-51'
        $received.nested.password | Should -Be 'NESTED-SENTINEL-52'   # nested objects survive the hand-over
    }

    It 'does not leave the key in the scheduler''s own environment afterwards' {
        Invoke-CrawlerJobProcess -JobId 102 -JobType 'csv' -Config @{} -ApiKey 'fgc_KEY-2' -DispatcherPath $script:fakeDispatcher
        $env:IA_JOB_API_KEY | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-CrawlerJobProcess — credential isolation between jobs (L-08)' {
    It 'a later job does not see the credential an earlier job left in $global:' {
        Invoke-CrawlerJobProcess -JobId 201 -JobType 'entra-id' -Config @{} -ApiKey 'k' -DispatcherPath $script:fakeDispatcher
        Invoke-CrawlerJobProcess -JobId 202 -JobType 'azure-rm' -Config @{} -ApiKey 'k' -DispatcherPath $script:fakeDispatcher

        (Get-JobReport 201).leftover | Should -BeNullOrEmpty
        (Get-JobReport 202).leftover | Should -BeNullOrEmpty   # job 201 set 'secret-of-job-201' before exiting
        $global:ClientSecret | Should -BeNullOrEmpty            # and nothing reached the scheduler either
    }
}

Describe 'Invoke-CrawlerJobProcess — failures' {
    It 'rethrows the failure message the dispatcher wrote, so the job shows why it failed' {
        { Invoke-CrawlerJobProcess -JobId 301 -JobType 'fail-with-message' -Config @{} -ApiKey 'k' -DispatcherPath $script:fakeDispatcher } |
            Should -Throw -ExpectedMessage 'Graph refused the token'
        $env:IA_JOB_API_KEY | Should -BeNullOrEmpty
    }

    It 'reports the exit code when the dispatcher wrote no message' {
        { Invoke-CrawlerJobProcess -JobId 302 -JobType 'fail-silent' -Config @{} -ApiKey 'k' -DispatcherPath $script:fakeDispatcher } |
            Should -Throw -ExpectedMessage 'Crawler job process exited with code 3'
    }

    It 'Get-CrawlerJobFailureMessage ignores a whitespace-only result file' {
        $p = Join-Path $script:work 'blank-result.txt'
        Set-Content -Path $p -Value "  `n "
        Get-CrawlerJobFailureMessage -ResultPath $p -ExitCode 9 | Should -Be 'Crawler job process exited with code 9'
        Get-CrawlerJobFailureMessage -ResultPath (Join-Path $script:work 'absent.txt') -ExitCode 4 | Should -Be 'Crawler job process exited with code 4'
    }
}

Describe 'Invoke-CrawlerJob.ps1 — run as a child process' {
    BeforeEach {
        $script:appRoot  = Join-Path $script:work "approot-$([guid]::NewGuid().ToString('N'))"
        $script:traceDir = Join-Path $script:work "trace-$([guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Path $script:appRoot | Out-Null
        $env:IA_APP_ROOT = $script:appRoot   # no module here: the job stops at bootstrap
        $env:TRACE_DIR   = $script:traceDir
    }

    It 'reads the stdin config and the environment key, and returns its failure message to the parent' {
        { Invoke-CrawlerJobProcess -JobId 401 -JobType 'entra-id' -Config @{ clientSecret = 'CFG-SENTINEL-61' } `
            -ApiKey 'fgc_KEY-SENTINEL-62' -DispatcherPath $script:dispatcher } |
            Should -Throw -ExpectedMessage '*IdentityAtlas module not found*'

        $log = Get-Content (Join-Path $script:traceDir '401.log') -Raw
        $log | Should -Not -Match 'SENTINEL'
    }

    It 'fails with a clear message when it gets no API key at all' {
        $result = Join-Path $script:work 'nokey-result.txt'
        Remove-Item Env:IA_JOB_API_KEY -ErrorAction SilentlyContinue
        '{}' | & pwsh -NoProfile -NonInteractive -File $script:dispatcher -JobId 402 -JobType 'csv' -ConfigFromStdin -ResultPath $result | Out-Null
        $LASTEXITCODE | Should -Not -Be 0
        Get-Content $result -Raw | Should -Match 'No crawler API key'
    }

    It 'keeps a command-line API key out of the transcript header (legacy in-process call)' {
        # The full transcript header records the host command line. Launch the
        # dispatcher the old way, with the key as an argument, and read the log.
        & pwsh -NoProfile -NonInteractive -Command "& '$($script:dispatcher)' -JobId 403 -JobType 'csv' -Config '{}' -ApiKey 'fgc_HEADER-SENTINEL-63'" 2>&1 | Out-Null
        $log = Get-Content (Join-Path $script:traceDir '403.log') -Raw
        $log | Should -Match 'PowerShell transcript start'
        $log | Should -Not -Match 'HEADER-SENTINEL'
    }
}

Describe 'Invoke-CrawlerJob.ps1 — Resolve-JobApiKey / Read-JobConfigInput' {
    BeforeAll {
        $content = Get-Content $script:dispatcher -Raw
        foreach ($fn in 'Resolve-JobApiKey', 'Read-JobConfigInput') {
            $m = [regex]::Match($content, "function $fn \{[\s\S]+?\n\}")
            if (-not $m.Success) { throw "Could not extract $fn from the dispatcher" }
            . ([scriptblock]::Create($m.Value))
        }
    }
    AfterEach { Remove-Item Env:IA_JOB_API_KEY -ErrorAction SilentlyContinue }

    It 'prefers an explicit key and still removes the environment variable' {
        $env:IA_JOB_API_KEY = 'from-env'
        Resolve-JobApiKey -ApiKey 'explicit' | Should -Be 'explicit'
        $env:IA_JOB_API_KEY | Should -BeNullOrEmpty
    }

    It 'falls back to IA_JOB_API_KEY, removing it once read' {
        $env:IA_JOB_API_KEY = 'from-env'
        Resolve-JobApiKey -ApiKey '' | Should -Be 'from-env'
        $env:IA_JOB_API_KEY | Should -BeNullOrEmpty
    }

    It 'throws when neither is present' {
        { Resolve-JobApiKey -ApiKey '' } | Should -Throw -ExpectedMessage '*No crawler API key*'
    }

    It 'reads the whole config from the given reader' {
        $reader = [System.IO.StringReader]::new("{`"a`":`n1}")
        Read-JobConfigInput -Reader $reader | Should -Be "{`"a`":`n1}"
    }
}
