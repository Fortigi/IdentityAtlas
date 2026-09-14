#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester tests for setup/docker/Build-FGContexts.ps1 (the buildContexts post-sync hook).

.DESCRIPTION
    SEC-2026-09 I-11: the hook read API_BASE_URL while the worker, the dispatcher and
    the desktop launcher all set WEB_API_URL, so it only reached the API because its
    hard-coded default happened to match the Docker service name. It now reads
    WEB_API_URL first and keeps API_BASE_URL as a fallback.

.USAGE
    Invoke-Pester -Path test/unit/BuildFGContexts.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:hook     = Join-Path $script:repoRoot 'setup' 'docker' 'Build-FGContexts.ps1'
    $script:keyFile  = Join-Path ([System.IO.Path]::GetTempPath()) "worker-key-$([guid]::NewGuid().ToString('N'))"
    Set-Content -Path $script:keyFile -Value "fgc_hook-key`n"

    $script:saved = @{}
    foreach ($n in 'WEB_API_URL', 'API_BASE_URL', 'WORKER_KEY_FILE') { $script:saved[$n] = [Environment]::GetEnvironmentVariable($n) }
}

AfterAll {
    foreach ($n in $script:saved.Keys) { [Environment]::SetEnvironmentVariable($n, $script:saved[$n]) }
    Remove-Item $script:keyFile -Force -ErrorAction SilentlyContinue
}

Describe 'Build-FGContexts.ps1 — which API it calls' {
    BeforeEach {
        foreach ($n in 'WEB_API_URL', 'API_BASE_URL') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
        $env:WORKER_KEY_FILE = $script:keyFile
        # Asserted with Should -Invoke: inside the hook script, $script: is the HOOK's
        # scope, so a mock body cannot append to a list owned by this test file.
        Mock Invoke-RestMethod { [pscustomobject]@{ contextsCreated = 3; durationMs = 5 } }
        Mock Write-Host { }
    }

    It 'uses WEB_API_URL when both names are set' {
        $env:WEB_API_URL  = 'https://web-api.example.test/api/'
        $env:API_BASE_URL = 'https://legacy.example.test/api'
        & $script:hook
        Should -Invoke Invoke-RestMethod -Exactly 1
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter {
            $Uri -eq 'https://web-api.example.test/api/ingest/refresh-contexts' -and $Headers.Authorization -eq 'Bearer fgc_hook-key'
        }
    }

    It 'falls back to API_BASE_URL for older configurations' {
        $env:API_BASE_URL = 'https://legacy.example.test/api'
        & $script:hook
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -eq 'https://legacy.example.test/api/ingest/refresh-contexts' }
    }

    It 'defaults to the Docker service address when neither is set' {
        & $script:hook
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -eq 'http://web:3001/api/ingest/refresh-contexts' }
    }

    It 'skips without calling the API when the key file is missing' {
        $env:WORKER_KEY_FILE = Join-Path ([System.IO.Path]::GetTempPath()) "absent-$([guid]::NewGuid().ToString('N'))"
        & $script:hook
        Should -Invoke Invoke-RestMethod -Exactly 0
    }
}
