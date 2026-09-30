#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Timing.ps1 — where a
    statement's time went.

.DESCRIPTION
    The arithmetic is tested with a fixed clock frequency and tick counts chosen
    so every mistake lands on a different answer: forgetting to subtract one part
    from the remainder, mixing up two parts, or letting the remainder go negative.
    The plumbing — reader, streams and counts feeding one statement's timing — is
    tested through Invoke-SqlSlot with the two boundaries mocked.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerTiming.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql' 'SqlCrawler.Load.ps1')
    $script:F = [System.Diagnostics.Stopwatch]::Frequency
}

Describe 'Get-SqlTimingBreakdown' {
    It 'converts each part to seconds and leaves shaping as exactly what the others do not explain' {
        # 10 s in total: read 2, JSON 0.5, API 3, counts 1 → shaping 3.5. Leaving
        # any one part out of the subtraction gives a different shaping figure.
        $t = @{ ReadTicks = 2000; SerializeTicks = 500; SendTicks = 3000; CountTicks = 1000; TotalTicks = 10000 }
        $b = Get-SqlTimingBreakdown -Timing $t -Frequency 1000
        $b.total     | Should -Be 10
        $b.read      | Should -Be 2
        $b.serialize | Should -Be 0.5
        $b.api       | Should -Be 3
        $b.counts    | Should -Be 1
        $b.shape     | Should -Be 3.5
    }

    It 'never reports negative shaping when the measured parts add up to more than the total' {
        $t = @{ ReadTicks = 600; SerializeTicks = 0; SendTicks = 600; CountTicks = 0; TotalTicks = 1000 }
        (Get-SqlTimingBreakdown -Timing $t -Frequency 1000).shape | Should -Be 0
    }

    It 'uses the real Stopwatch frequency by default' {
        $t = New-SqlTiming
        $t.TotalTicks = 3 * $script:F
        (Get-SqlTimingBreakdown -Timing $t).total | Should -Be 3
    }
}

Describe 'Format-SqlTimingLine' {
    It 'names every part in a fixed order, with one decimal and a dot whatever the culture' {
        $b = [ordered]@{ total = 99; read = 12.34; shape = 690.25; serialize = 14.06; api = 250.44; counts = 8 }
        $saved = [System.Threading.Thread]::CurrentThread.CurrentCulture
        try {
            [System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('nl-NL')
            Format-SqlTimingLine -Breakdown $b |
                Should -Be 'time: source read 12.3s · shaping 690.3s · JSON 14.1s · API 250.4s · source counts 8.0s'
        } finally { [System.Threading.Thread]::CurrentThread.CurrentCulture = $saved }
    }
}

Describe 'Add-SqlStreamTiming' {
    It 'sums the serialise and send time of every stream of every role' {
        $mk = { param($s, $d) [pscustomobject]@{ Timing = @{ SerializeTicks = [long]$s; SendTicks = [long]$d } } }
        $roleA = @{ Streams = [System.Collections.Generic.Dictionary[int, object]]::new() }
        $roleA.Streams[1] = & $mk 1 10
        $roleA.Streams[2] = & $mk 2 20
        $roleB = @{ Streams = [System.Collections.Generic.Dictionary[int, object]]::new() }
        $roleB.Streams[1] = & $mk 4 40
        $t = New-SqlTiming
        $t.SendTicks = 100   # what was there already is kept, not replaced
        Add-SqlStreamTiming -Timing $t -Streams @{ assignment = $roleA; member = $roleB }
        $t.SerializeTicks | Should -Be 7
        $t.SendTicks | Should -Be 170
    }

    It 'adds nothing for a slot that opened no stream' {
        $t = New-SqlTiming
        Add-SqlStreamTiming -Timing $t -Streams @{}
        $t.SendTicks + $t.SerializeTicks | Should -Be 0
    }
}

Describe 'Get-SqlRate' {
    It 'is rows over seconds, and 0 rather than a division error when no time passed' {
        Get-SqlRate -Rows 3000 -Seconds 20 | Should -Be 150
        Get-SqlRate -Rows 3000 -Seconds 0 | Should -Be 0
    }
}

Describe 'Write-SqlRunTiming' {
    BeforeEach { Mock Write-Host { } }

    It 'writes one line per timed statement with its own rate, then the run total over every one of them' {
        $totals = [ordered]@{
            'Grants'  = @{ rows = 3000; timing = [ordered]@{ total = 20; read = 1; shape = 15; serialize = 1; api = 2; counts = 1 } }
            # A buffered statement that recorded no timing is left out, not counted as zero seconds.
            'Systems' = @{ rows = 40 }
            'Roles'   = @{ rows = 1000; timing = [ordered]@{ total = 10; read = 2; shape = 3; serialize = 0; api = 4; counts = 1 } }
        }
        $lines = Write-SqlRunTiming -Totals $totals
        $lines.Count | Should -Be 4
        $lines[1] | Should -Match '^\s+Grants\s+3,000 rows\s+20s\s+150/s\s+read\s+1s\s+shape\s+15s\s+JSON\s+1s\s+API\s+2s\s+counts\s+1s$'
        $lines[2] | Should -Match '^\s+Roles\s+1,000 rows\s+10s\s+100/s'
        # 4,000 rows in 30 s is 133/s — the Systems row neither adds rows nor divides the rate.
        $lines[3] | Should -Match '^\s+all statements\s+4,000 rows\s+30s\s+133/s\s+read\s+3s\s+shape\s+18s\s+JSON\s+1s\s+API\s+6s\s+counts\s+2s$'
        Should -Invoke Write-Host -Exactly 4
    }
}

Describe 'Invoke-SqlSlot records where its time went' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        $script:said = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:said.Add([string]$Object) }
        Mock Update-CrawlerProgress { }
        # The reader reports 2 s of source time; each batch 1 s of API wait and
        # 0.25 s of JSON. Fixed amounts, so the slot's figures are checkable.
        Mock Invoke-SqlQueryStream {
            foreach ($r in $script:rows) { & $OnRow $r }
            $Timing.ReadTicks += 2 * $script:F
            [long]$script:rows.Count
        }
        Mock Invoke-IngestAPI {
            if ($Timing) { $Timing.SendTicks += $script:F; $Timing.SerializeTicks += $script:F / 4 }
            $script:sent.Add($Endpoint)
            @{ inserted = @($Body.records).Count; updated = 0 }
        }
    }

    It 'folds the reader, every batch of every stream, and the total into the statement''s totals' {
        # 5 principals at batch size 2 → 3 batches → 3 s of API, 0.75 s of JSON.
        $script:rows = @(1..5 | ForEach-Object { [ordered]@{ id = "p$_"; displayName = "P $_" } })
        $slot = @{ name = 'People'; target = 'principals'; sql = 'SELECT 1'; enabled = $true; principalType = 'User'; paged = $false }
        $state = New-SqlRunState -SystemId 7 -ServerTime '2026-09-25T09:00:00.000Z' -Slots @($slot) -BatchSize 2
        $r = Invoke-SqlSlot -Slot $slot -Connection 'conn' -State $state
        @($script:sent | Where-Object { $_ -eq 'ingest/principals' }).Count | Should -Be 3
        $r.timing.read | Should -Be 2
        $r.timing.api | Should -Be 3
        $r.timing.serialize | Should -Be 0.75
        $r.timing.total | Should -BeGreaterThan 0
        $r.timing.shape | Should -BeGreaterOrEqual 0
        $state.Totals['People'].timing.api | Should -Be 3
        @($script:said | Where-Object { $_ -like '*time: source read 2.0s*API 3.0s*' }).Count | Should -Be 1
    }
}
