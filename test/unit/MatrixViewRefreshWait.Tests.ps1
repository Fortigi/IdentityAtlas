#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester tests for the end-of-job wait on the background matrix-view refresh
    (Get-MatrixViewRefreshStatus / Wait-MatrixViewRefresh in
    setup/docker/Invoke-CrawlerJob.ps1).

.DESCRIPTION
    The refresh used to run inside an HTTP request the crawler abandoned after
    300 s and retried; a failure was logged as "non-critical" and the job said
    success. Now the API refreshes in the background and the job waits for it
    here. These pin that the job reports what really happened.
#>

BeforeAll {
    $repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $content = Get-Content (Join-Path $repoRoot 'setup/docker/Invoke-CrawlerJob.ps1') -Raw
    foreach ($name in 'Get-MatrixViewRefreshStatus', 'Wait-MatrixViewRefresh') {
        $m = [regex]::Match($content, "function $name \{[\s\S]+?\n\}")
        if (-not $m.Success) { throw "Could not extract $name from Invoke-CrawlerJob.ps1" }
        . ([scriptblock]::Create($m.Value))
    }
    function Update-JobProgress { param($Step, $Pct) }

    # A status object shaped like GET /ingest/refresh-views.
    function New-Status {
        param([bool]$Pending = $false, [int]$Runs = 0, $Last = $null, [string]$State = 'idle')
        [pscustomobject]@{ state = $State; pending = $Pending; runs = $Runs; last = $Last }
    }
}

Describe 'Get-MatrixViewRefreshStatus' {
    It 'returns the API status, calling the status endpoint with the key' {
        Mock Invoke-RestMethod { New-Status -Runs 4 }
        $s = Get-MatrixViewRefreshStatus -ApiBaseUrl 'http://web/api' -ApiKey 'k1'
        $s.runs | Should -Be 4
        Should -Invoke Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
            $Uri -eq 'http://web/api/ingest/refresh-views' -and $Method -eq 'Get' -and $Headers.Authorization -eq 'Bearer k1'
        }
    }

    It 'returns $null when the API has no status endpoint' {
        Mock Invoke-RestMethod { throw '404 Not Found' }
        Get-MatrixViewRefreshStatus -ApiBaseUrl 'http://web/api' -ApiKey 'k' | Should -BeNullOrEmpty
    }
}

Describe 'Wait-MatrixViewRefresh' {
    BeforeEach { Mock Start-Sleep {} }

    It 'does nothing when there was no status before the job (older API)' {
        Mock Invoke-RestMethod { throw 'should not be called' }
        { Wait-MatrixViewRefresh -ApiBaseUrl 'x' -ApiKey 'k' -Before $null } | Should -Not -Throw
        Should -Invoke Invoke-RestMethod -Times 0 -Exactly
    }

    It 'polls while a refresh is pending, then reports the successful run' {
        $script:polls = 0
        Mock Invoke-RestMethod {
            $script:polls++
            if ($script:polls -lt 3) { New-Status -Pending $true -Runs 1 -State 'running' }
            else { New-Status -Runs 2 -Last ([pscustomobject]@{ ok = $true; durationMs = 161000; error = $null }) }
        }
        Mock Write-Host {}
        Wait-MatrixViewRefresh -ApiBaseUrl 'x' -ApiKey 'k' -Before (New-Status -Runs 1)
        $script:polls | Should -Be 3
        Should -Invoke Start-Sleep -Times 2 -Exactly
        Should -Invoke Write-Host -ParameterFilter { $Object -eq '  Matrix views refreshed in 161 s' }
    }

    It 'fails the job when the refresh this job asked for failed' {
        Mock Invoke-RestMethod {
            New-Status -Runs 3 -Last ([pscustomobject]@{ ok = $false; durationMs = 184000; error = 'No space left on device' })
        }
        { Wait-MatrixViewRefresh -ApiBaseUrl 'x' -ApiKey 'k' -Before (New-Status -Runs 2) } |
            Should -Throw 'Data loaded, but the matrix view refresh failed after 184 s: No space left on device'
    }

    It 'ignores an old failure when no refresh ran during this job' {
        Mock Invoke-RestMethod {
            New-Status -Runs 2 -Last ([pscustomobject]@{ ok = $false; durationMs = 1000; error = 'an earlier failure' })
        }
        { Wait-MatrixViewRefresh -ApiBaseUrl 'x' -ApiKey 'k' -Before (New-Status -Runs 2) } | Should -Not -Throw
    }

    It 'gives up with a clear message when the refresh outlasts the timeout' {
        Mock Invoke-RestMethod { New-Status -Pending $true -Runs 0 -State 'running' }
        { Wait-MatrixViewRefresh -ApiBaseUrl 'x' -ApiKey 'k' -Before (New-Status) -TimeoutSeconds -1 } |
            Should -Throw 'Data loaded, but the matrix views were still refreshing after -1 s*'
    }
}
