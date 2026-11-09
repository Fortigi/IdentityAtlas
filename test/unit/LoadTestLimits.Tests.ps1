#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }
<#
.SYNOPSIS
    The load test's limits can fail, and the benchmark compares against a baseline.

.DESCRIPTION
    The Load & Soak Tests job measured the matrix at 0.7 s against a 15 s limit and
    the dashboard at 0.1 s against 5 s; ingest and the view refresh had no limit at
    all. A 20x regression passed. Run-Benchmark.ps1 could compare p95 against a
    baseline, but none was ever committed, so it compared nothing. These tests hold
    the limits, the rule each limit applies, and the benchmark's comparison.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
}

Describe 'Test-LoadAndBenchmark.ps1 limits' {
    BeforeAll {
        . (Join-Path $script:repoRoot 'test' 'nightly' 'Test-LoadAndBenchmark.ps1')
    }

    BeforeEach {
        $results = @{}
        $WriteResult = { param($Name, $Passed, $Detail) $results[$Name] = @{ Passed = $Passed; Detail = $Detail } }
        Mock Write-Host { }
    }

    It 'sets <Key> to <Value>, about twice the slowest green CI run' -ForEach @(
        @{ Key = 'IngestMinutes';      Value = 8 }
        @{ Key = 'ViewRefreshSeconds'; Value = 60 }
        @{ Key = 'MatrixSeconds';      Value = 2 }
        @{ Key = 'DashboardSeconds';   Value = 0.5 }
    ) {
        # Raising one of these needs the measurements behind it -- the old 15 s / 5 s
        # limits passed a 20x regression.
        $script:LoadTestLimits[$Key] | Should -Be $Value
    }

    Context 'Write-LimitResult' {
        It 'passes a time just under the limit' {
            Write-LimitResult 'x' 1.99 2 's'
            $results['x'].Passed | Should -BeTrue
        }

        It 'fails a time at the limit, and says what the limit was' {
            Write-LimitResult 'x' 2 2 's'
            $results['x'].Passed | Should -BeFalse
            $results['x'].Detail | Should -Be 'time=2s (limit=2s)'
        }
    }

    Context 'Measure-MedianSeconds' {
        It 'returns the middle of three timings, not the first or the slowest' {
            $t0 = [datetime]'2026-11-09T10:00:00'
            # start, end pairs: 5 s, 1 s, 3 s
            $script:clock = [System.Collections.Generic.Queue[datetime]]::new([datetime[]]@(
                $t0, $t0.AddSeconds(5), $t0, $t0.AddSeconds(1), $t0, $t0.AddSeconds(3)))
            Mock Get-Date { $script:clock.Dequeue() }
            Mock Invoke-LocalApi { }
            Measure-MedianSeconds -Path '/permissions?userLimit=25' | Should -Be 3
            Should -Invoke Invoke-LocalApi -Times 3 -Exactly -ParameterFilter { $Path -eq '/permissions?userLimit=25' }
        }
    }

    Context 'each timed step applies its limit' {
        It 'fails the matrix at a median of 2.5 s and passes it at 1.0 s' {
            Mock Measure-MedianSeconds { 2.5 } -ParameterFilter { $Path -eq '/permissions?userLimit=25' }
            Test-LoadTestMatrixPerformance
            $results['LoadTest/MatrixPerformance'].Passed | Should -BeFalse

            Mock Measure-MedianSeconds { 1.0 } -ParameterFilter { $Path -eq '/permissions?userLimit=25' }
            Test-LoadTestMatrixPerformance
            $results['LoadTest/MatrixPerformance'].Passed | Should -BeTrue
        }

        It 'fails the dashboard at a median of 0.6 s' {
            Mock Measure-MedianSeconds { 0.6 } -ParameterFilter { $Path -eq '/admin/dashboard-stats' }
            Test-LoadTestDashboardPerformance
            $results['LoadTest/DashboardPerformance'].Passed | Should -BeFalse
        }

        It 'fails a view refresh that succeeds but takes 61 s' {
            $t0 = [datetime]'2026-11-09T10:00:00'
            $script:clock = [System.Collections.Generic.Queue[datetime]]::new([datetime[]]@($t0, $t0.AddSeconds(61)))
            Mock Get-Date { $script:clock.Dequeue() }
            Mock Invoke-LocalApi { }
            Test-LoadTestViewRefresh
            $results['LoadTest/ViewRefresh'].Passed | Should -BeFalse
        }

        It 'records a 9-minute ingest as completed, and over its limit' {
            $crawler = Join-Path $TestDrive 'Start-FakeCrawler.ps1'
            Set-Content $crawler 'param($ApiBaseUrl, $ApiKey, $JobId, $ConfigPath)'
            $t0 = [datetime]'2026-11-09T10:00:00'
            $script:clock = [System.Collections.Generic.Queue[datetime]]::new([datetime[]]@($t0, $t0.AddMinutes(9)))
            Mock Get-Date { $script:clock.Dequeue() }
            Invoke-LoadTestIngest -DataFolder $TestDrive -CrawlerScript $crawler
            $results['LoadTest/CrawlerCompleted'].Passed | Should -BeTrue
            $results['LoadTest/IngestDuration'].Passed | Should -BeFalse
            $results['LoadTest/IngestDuration'].Detail | Should -Match 'limit=8min'
        }
    }

    Context 'the benchmark run' {
        It 'compares against the committed CI baseline at 50% and 50 ms, as a warning only' {
            $bench = Join-Path $TestDrive 'Run-FakeBenchmark.ps1'
            Set-Content $bench 'param($ApiBaseUrl, $ApiKey, $OutputFolder, $BaselineFile, $RegressionPct, $MinRegressionMs, [switch]$FailOnRegression) $global:benchArgs = $PSBoundParameters'
            $LogFolder = $TestDrive
            $RepoRoot = $script:repoRoot
            Invoke-LoadTestBenchmark -BenchmarkScript $bench
            $global:benchArgs.BaselineFile | Should -Be (Join-Path $script:repoRoot 'test/benchmark/ci-baseline.json')
            $global:benchArgs.RegressionPct | Should -Be 50
            $global:benchArgs.MinRegressionMs | Should -Be 50
            $global:benchArgs.ContainsKey('FailOnRegression') | Should -BeFalse
            Remove-Variable benchArgs -Scope Global
        }
    }
}

Describe 'test/benchmark/ci-baseline.json' {
    It 'has a p95 for every endpoint Run-Benchmark.ps1 measures' {
        # An endpoint without a baseline is never compared; this keeps a new one from
        # being added silently.
        $script_ = Get-Content (Join-Path $script:repoRoot 'test' 'benchmark' 'Run-Benchmark.ps1') -Raw
        $measured = [regex]::Matches($script_, "@\{ name = '([^']+)';\s+path = ") | ForEach-Object { $_.Groups[1].Value }
        $measured.Count | Should -BeGreaterThan 5
        $baseline = Get-Content (Join-Path $script:repoRoot 'test' 'benchmark' 'ci-baseline.json') -Raw | ConvertFrom-Json
        foreach ($name in $measured) {
            $baseline.clientTimings.$name.p95Ms | Should -BeGreaterThan 0 -Because "$name is measured"
        }
    }
}

Describe 'Run-Benchmark.ps1 regression rule' {
    BeforeAll {
        . (Join-Path $script:repoRoot 'test' 'benchmark' 'Run-Benchmark.ps1') -OutputFolder $TestDrive
    }

    It 'flags +51% that is also +51 ms' {
        Get-BaselineRegression -Name 'e' -Cur @{ p95Ms = 151 } -Base @{ p95Ms = 100 } -Pct 50 -MinMs 50 |
            Should -Be 'e  p95 100ms -> 151ms (+51%)'
    }

    It 'does not flag exactly +50%' {
        Get-BaselineRegression -Name 'e' -Cur @{ p95Ms = 150 } -Base @{ p95Ms = 100 } -Pct 50 -MinMs 0 |
            Should -BeNullOrEmpty
    }

    It 'does not flag +300% that is only +30 ms, under a 50 ms floor' {
        Get-BaselineRegression -Name 'e' -Cur @{ p95Ms = 40 } -Base @{ p95Ms = 10 } -Pct 50 -MinMs 50 |
            Should -BeNullOrEmpty
    }

    It 'flags the same +30 ms without a floor' {
        Get-BaselineRegression -Name 'e' -Cur @{ p95Ms = 40 } -Base @{ p95Ms = 10 } -Pct 50 |
            Should -Not -BeNullOrEmpty
    }

    Context 'Publish-BenchmarkToActions' {
        BeforeEach {
            $saved = @{ GITHUB_ACTIONS = $env:GITHUB_ACTIONS; GITHUB_STEP_SUMMARY = $env:GITHUB_STEP_SUMMARY }
            $env:GITHUB_STEP_SUMMARY = Join-Path $TestDrive 'summary.md'
            Remove-Item $env:GITHUB_STEP_SUMMARY -ErrorAction SilentlyContinue
            Set-Content $mdOut '# Identity Atlas — API Benchmark'
            $script:regressions = @('matrix-unfiltered  p95 1833.6ms -> 3000ms (+63.6%)')
            Mock Write-Host { }
        }
        AfterEach {
            $env:GITHUB_ACTIONS = $saved.GITHUB_ACTIONS
            $env:GITHUB_STEP_SUMMARY = $saved.GITHUB_STEP_SUMMARY
        }

        It 'annotates each regression and puts the report in the job summary' {
            $env:GITHUB_ACTIONS = 'true'
            Publish-BenchmarkToActions
            Should -Invoke Write-Host -Times 1 -Exactly -ParameterFilter {
                "$Object" -eq '::warning title=Benchmark regression (p95)::matrix-unfiltered  p95 1833.6ms -> 3000ms (+63.6%)'
            }
            Get-Content $env:GITHUB_STEP_SUMMARY -Raw | Should -Match 'API Benchmark'
        }

        It 'does neither outside GitHub Actions' {
            $env:GITHUB_ACTIONS = $null
            Publish-BenchmarkToActions
            Should -Invoke Write-Host -Times 0 -Exactly
            Test-Path $env:GITHUB_STEP_SUMMARY | Should -BeFalse
        }
    }
}
