#Requires -Modules Pester
<#
    Start-MockServerJob waits for a mock server's background job to report MOCK_STARTED.

    The integration suite starts every crawler's tests at the same moment, and each mock server is a
    fresh pwsh job process. On a loaded CI runner that job needed longer than the old 4 s window and
    the OData tests failed with "failed to start … Output: " (nothing at all). The first case below
    uses a server that reports after ~5 s: it fails against the 4 s default and passes now.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot '..' '..' 'tools' 'crawlers' 'shared' 'Start-MockServerJob.ps1')
}

Describe 'Start-MockServerJob' {
    It 'waits for a server that is slow to come up (longer than the old 4 s window)' {
        $block = { param($p) Start-Sleep -Seconds 5; Write-Output "MOCK_STARTED: port=$p"; Start-Sleep -Seconds 30 }
        $mock = Start-MockServerJob -ScriptBlock $block -ArgumentList @(12345) -Name 'Slow' -Port 12345
        try {
            $mock.Port | Should -Be 12345
            (Receive-Job -Job $mock.Job -Keep) -join ' ' | Should -Match 'MOCK_STARTED: port=12345'
        } finally {
            Stop-Job $mock.Job -ErrorAction SilentlyContinue
            Remove-Job $mock.Job -Force -ErrorAction SilentlyContinue
        }
    }

    It 'fails straight away when the server reports it could not bind, naming the product and its output' {
        $block = { param($p) Write-Output "MOCK_ERROR: port $p in use" }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        { Start-MockServerJob -ScriptBlock $block -ArgumentList @(2222) -Name 'Broken' -Port 2222 } |
            Should -Throw -ExpectedMessage '*Mock Broken server failed to start on port 2222*MOCK_ERROR: port 2222 in use*'
        # An error marker must not sit out the whole start-up window.
        $sw.Elapsed.TotalSeconds | Should -BeLessThan 20
    }

    It 'gives up after the timeout when nothing is ever reported' {
        $block = { param($p) Start-Sleep -Seconds 60 }
        { Start-MockServerJob -ScriptBlock $block -ArgumentList @(3333) -Name 'Silent' -Port 3333 -TimeoutMs 1000 } |
            Should -Throw -ExpectedMessage '*Mock Silent server failed to start on port 3333*'
    }
}
