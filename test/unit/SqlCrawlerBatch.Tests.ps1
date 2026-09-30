#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Batch.ps1 — the
    batched assignments path.

.DESCRIPTION
    The batched path exists only to be faster; it must not be different. So the
    central tests here run the SAME raw source rows through Invoke-SqlSlot twice —
    once through the per-row handler it replaced (Add-SqlAssignmentRow, forced by
    mocking Get-SqlSlotCallback) and once through the batch — and require the API
    to receive byte-identical requests per stream, and the run to end with the
    same counters and the same watermark.

    The rows are chosen to be awkward where the two paths could part: ids with
    surrounding spaces, numeric and GUID ids, NULL and blank keys, a principal
    named by identityId, extended values of every type the reader returns, a
    column name repeated in another case, dangling references on either side,
    three systems, a watermark column holding decimals and NULLs, and batch and
    stream sizes that do not divide the row count.

    The reader double mirrors Invoke-SqlReaderPage: per row it hands over
    ConvertTo-SqlRow of the raw values, per batch the raw value arrays.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql' 'SqlCrawler.Load.ps1')

    $script:when = [datetime]::new(2026, 1, 2, 3, 4, 5, [DateTimeKind]::Utc)
    $script:guid = [guid]'11111111-2222-3333-4444-555555555555'
    $null_ = [System.DBNull]::Value

    # The source, as SqlDataReader.GetValues returns it: raw .NET values.
    $script:Columns = [string[]]@('principalId', 'resourceId', 'modified', 'Note', 'granted', 'blob', 'NOTE', 'sysRef')
    $script:Raw = @(
        , @(' p1 ', 'r1', [decimal]1700000000000, 'a', $true, [byte[]](1, 2), 'A', 'S1')
        , @('p2', ' r2', [decimal]1700000000500, 'b', $script:when, $null_, 'B', 'S2')
        , @('p1', 'r3', $null_, $null_, $null_, $null_, 'C', 'S1')           # NULL watermark
        , @($null_, 'r1', [decimal]1700000000100, 'd', $true, $null_, 'D', 'S1')   # no principal → skipped
        , @('p2', '   ', [decimal]1700000000200, 'e', $true, $null_, 'E', 'S1')   # blank resource → skipped
        , @('p9', 'r1', [decimal]1700000000300, 'f', $true, $null_, 'F', 'S1')    # unknown principal → dangling
        , @('p1', 'r9', [decimal]1700000000400, 'g', $true, $null_, 'G', 'S1')    # unknown resource → dangling
        , @([decimal]42, $script:guid.ToString(), [decimal]1700000000900, 'h', 3.5, $null_, 'H', 'S3')
        , @('p2', 'r3', [decimal]1700000000600, [decimal]7, $true, $null_, 'I', 'NOPE')  # unknown system
        , @('p1', 'r2', [decimal]1700000000700, 'j', $script:guid, $null_, 'J', 'S2')
        , @('p2', 'r1', [decimal]1700000000800, [long]6, [int16]3, $null_, 'K', 'S3')
    )

    # Mirrors Invoke-SqlReaderPage for either callback.
    $script:ReaderDouble = {
        if ($OnRow) {
            foreach ($r in $script:Raw) { & $OnRow (ConvertTo-SqlRow -Values ([object[]]$r) -Columns $script:Columns) }
        } else {
            $batch = [System.Collections.Generic.List[object]]::new()
            foreach ($r in $script:Raw) {
                $batch.Add(([object[]]$r).Clone())
                if ($batch.Count -ge $script:BatchRows) { & $OnBatch $script:Columns $batch.ToArray(); $batch = [System.Collections.Generic.List[object]]::new() }
            }
            if ($batch.Count) { & $OnBatch $script:Columns $batch.ToArray() }
        }
        [long]$script:Raw.Count
    }

    function New-BatchTestState {
        param([bool]$Routing)
        $slots = @(@{ enabled = $true; target = 'principals' }, @{ enabled = $true; target = 'resources' }, @{ enabled = $true; target = 'assignments' })
        $st = New-SqlRunState -SystemId 7 -ServerTime '2026-09-25T09:00:00.000Z' -Slots $slots -BatchSize 2
        $st.KnownResources['r1'] = 101; $st.KnownResources['r2'] = 102; $st.KnownResources['r3'] = 101
        $st.KnownResources[$script:guid.ToString()] = 103
        foreach ($p in 'p1', 'p2', '42') { $st.KnownPrincipals[$p] = 7 }
        if ($Routing) { $st.Systems.ByKey['S1'] = 101; $st.Systems.ByKey['S2'] = 102; $st.Systems.ByKey['S3'] = 103 }
        return $st
    }

    # One Invoke-SqlSlot over the source, through the given path. Returns what
    # the API received, grouped per (endpoint, system), plus the run's state.
    function Invoke-BatchTestSlot {
        param([hashtable]$Slot, [bool]$Routing, [switch]$PerRow)
        $script:calls = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI {
            $script:calls.Add("$Endpoint#$($Body.systemId)=$($Body | ConvertTo-Json -Depth 20 -Compress)")
            @{ inserted = @($Body.records).Count; updated = 0 }
        }
        Mock Invoke-SqlQueryStream $script:ReaderDouble
        if ($PerRow) { Mock Get-SqlSlotCallback { @{ OnRow = (New-SqlRowCallback -Ctx $Ctx -Handler 'Add-SqlAssignmentRow') } } }
        $state = New-BatchTestState -Routing $Routing
        $script:SqlBatchCtx = $null; $script:SqlRowCtx = $null
        $totals = Invoke-SqlSlot -Slot $Slot -Connection 'conn' -State $state
        # Which path actually ran: each callback factory leaves its context behind.
        $path = if ($null -ne $script:SqlBatchCtx) { 'batch' } elseif ($null -ne $script:SqlRowCtx) { 'row' } else { 'none' }
        return @{ Calls = @($script:calls | Sort-Object { ($_ -split '=', 2)[0] } -Stable); State = $state; Totals = $totals; Path = $path }
    }

    $script:GrantSlot = @{ name = 'Grants'; target = 'assignments'; sql = 'SELECT 1 WHERE m >= @Since'; enabled = $true; paged = $false
                           resourceType = 'Entitlement'; assignmentType = 'Direct'; governed = $false; watermarkColumn = 'modified'; columnMap = @{} }
}

Describe 'The batched path sends exactly what the per-row path sent' {
    BeforeEach {
        Mock Update-CrawlerProgress { }
        Mock Write-Host { }
        Mock Measure-SqlSource { @{ rows = [long]11; pairs = [long]7; reason = $null } }
        Mock Get-CrawlerDeltaTokenRow { $null }
    }

    It 'routed by resource, across batch and stream boundaries: same requests, counters and watermark' -ForEach @(
        @{ BatchRows = 1 }, @{ BatchRows = 3 }, @{ BatchRows = 1000 }
    ) {
        $script:BatchRows = $BatchRows
        $bat = Invoke-BatchTestSlot -Slot $script:GrantSlot -Routing $true
        $row = Invoke-BatchTestSlot -Slot $script:GrantSlot -Routing $true -PerRow
        $bat.Path | Should -Be 'batch'
        $row.Path | Should -Be 'row'
        $row.Calls.Count | Should -BeGreaterThan 3
        $bat.Calls | Should -Be $row.Calls
        foreach ($k in 'rows', 'sent', 'skipped', 'dangling', 'misrouted', 'systems') { $bat.Totals[$k] | Should -Be $row.Totals[$k] -Because $k }
        $bat.Totals.skipped | Should -Be 2
        $bat.Totals.dangling | Should -Be 2
        $bat.Totals.systems | Should -Be 3
        $bd = $bat.State.Deltas[0]; $rd = $row.State.Deltas[0]
        $bd.Max | Should -Be $rd.Max
        $bd.Max | Should -Be 1700000000900
        $bd.Rows | Should -Be 11
        $bd.Unusable | Should -BeNullOrEmpty
        @($bat.State.Scopes | ForEach-Object Key) | Should -Be @($row.State.Scopes | ForEach-Object Key)
    }

    It 'routed by the statement''s own systemId column, including a row naming no system: same requests and misrouted count' {
        $script:BatchRows = 4
        # Neither a resources statement nor a watermark this time: the route and
        # the fallback for an unknown resource are the column's alone.
        $slot = $script:GrantSlot.Clone(); $slot.watermarkColumn = ''; $slot.sql = 'SELECT 1'
        $script:Columns[7] = 'systemId'
        try {
            $bat = Invoke-BatchTestSlot -Slot $slot -Routing $true
            $row = Invoke-BatchTestSlot -Slot $slot -Routing $true -PerRow
        } finally { $script:Columns[7] = 'sysRef' }
        $bat.Calls | Should -Be $row.Calls
        $bat.Totals.misrouted | Should -Be $row.Totals.misrouted
        $bat.Totals.misrouted | Should -Be 1
        $bat.State.Systems.Unknown['NOPE'] | Should -Be 1
    }

    It 'with no routing everything lands in the crawler''s own system, identically' {
        $script:BatchRows = 5
        $bat = Invoke-BatchTestSlot -Slot $script:GrantSlot -Routing $false
        $row = Invoke-BatchTestSlot -Slot $script:GrantSlot -Routing $false -PerRow
        $bat.Calls | Should -Be $row.Calls
        @($bat.Calls | ForEach-Object { ($_ -split '=', 2)[0] } | Sort-Object -Unique) | Should -Be @('ingest/resource-assignments#7')
    }
}

Describe 'What the batched records carry' {
    BeforeEach {
        Mock Update-CrawlerProgress { }
        Mock Write-Host { }
        Mock Measure-SqlSource { @{ rows = [long]11; pairs = [long]7; reason = $null } }
        Mock Get-CrawlerDeltaTokenRow { $null }
        $script:BatchRows = 1000
    }

    It 'converts each extended value the way the reader''s row conversion does, and keeps the LAST of a repeated column' {
        $bat = Invoke-BatchTestSlot -Slot $script:GrantSlot -Routing $true
        $recs = @($bat.Calls | ForEach-Object { (($_ -split '=', 2)[1] | ConvertFrom-Json).records } | ForEach-Object { $_ })
        $second = $recs | Where-Object { $_.resourceExternalId -eq 'r2' -and $_.principalExternalId -eq 'p2' }
        ($bat.Calls -join ' ') | Should -Match ([regex]::Escape('"granted":"2026-01-02T03:04:05.0000000Z"'))  # a datetime, as ISO-8601 text
        $second.extendedAttributes.Note | Should -Be 'B'                               # 'Note' then 'NOTE': the last value
        @($second.extendedAttributes.PSObject.Properties.Name | Where-Object { $_ -eq 'note' }) | Should -Be @('Note')  # one key per name, first spelling…
        $first = $recs | Where-Object { $_.resourceExternalId -eq 'r1' -and $_.principalExternalId -eq 'p1' }
        $first.extendedAttributes.Note | Should -Be 'A'                                 # …holding the last value
        $first.extendedAttributes.blob | Should -BeNullOrEmpty                         # binary is dropped
        $num = $recs | Where-Object { $_.principalExternalId -eq '42' }
        $num.resourceExternalId | Should -Be $script:guid.ToString()                   # a GUID key as its string
        $num.extendedAttributes.granted | Should -Be 3.5
        ($recs | Where-Object { $_.resourceExternalId -eq 'r2' -and $_.principalExternalId -eq 'p1' }).extendedAttributes.granted |
            Should -Be $script:guid.ToString()
    }

    It 'takes the principal from identityId when the statement has no principalId' {
        $script:Columns = [string[]]@('identityId', 'resourceId')
        $saved = $script:Raw
        $script:Raw = @(, @('p1', 'r1'))
        try {
            $slot = $script:GrantSlot.Clone(); $slot.watermarkColumn = ''; $slot.sql = 'SELECT 1'
            $bat = Invoke-BatchTestSlot -Slot $slot -Routing $false
            $rec = (($bat.Calls[0] -split '=', 2)[1] | ConvertFrom-Json).records[0]
            $rec.principalExternalId | Should -Be 'p1'
            $rec.PSObject.Properties.Name | Should -Not -Contain 'extendedAttributes'
        } finally {
            $script:Raw = $saved
            $script:Columns = [string[]]@('principalId', 'resourceId', 'modified', 'Note', 'granted', 'blob', 'NOTE', 'sysRef')
        }
    }
}

Describe 'Update-SqlBatchWatermark' {
    It 'marks the column unusable at the first value that is not a whole number, naming it, and stops raising the mark' {
        $delta = @{ Column = 'modified'; Max = [long]::MinValue; Rows = [long]0; Unusable = $null }
        $rows = [System.Collections.Generic.List[object]]::new()
        $rows.Add([object[]]@([decimal]5)); $rows.Add([object[]]@('2026-01-01')); $rows.Add([object[]]@([decimal]9))
        Update-SqlBatchWatermark -Rows $rows -Plan @{ Watermark = 0 } -Delta $delta
        $delta.Unusable | Should -Be "the watermark column 'modified' returned '2026-01-01', which is not epoch milliseconds"
        $delta.Max | Should -Be 5
        $delta.Rows | Should -Be 3
    }

    # A string[] would store the NULL as '' and make it look like a bad value.
    It 'ignores a NULL but not an empty string, exactly as the per-row rule does' {
        $delta = @{ Column = 'modified'; Max = [long]::MinValue; Rows = [long]0; Unusable = $null }
        $rows = @([object[]]@([decimal]5), [object[]]@([System.DBNull]::Value), [object[]]@([decimal]8))
        Update-SqlBatchWatermark -Rows $rows -Plan @{ Watermark = 0 } -Delta $delta
        $delta.Unusable | Should -BeNullOrEmpty
        $delta.Max | Should -Be 8
        Update-SqlBatchWatermark -Rows @(, [object[]]@('')) -Plan @{ Watermark = 0 } -Delta $delta
        $delta.Unusable | Should -Be "the watermark column 'modified' returned '', which is not epoch milliseconds"
    }

    It 'accepts what TryParse accepts beyond plain digits — a sign, surrounding spaces — and a 19-digit value' {
        $delta = @{ Column = 'modified'; Max = [long]::MinValue; Rows = [long]0; Unusable = $null }
        $rows = @([object[]]@(' 12 '), [object[]]@('-3'), [object[]]@('1000000000000000000'))
        Update-SqlBatchWatermark -Rows $rows -Plan @{ Watermark = 0 } -Delta $delta
        $delta.Unusable | Should -BeNullOrEmpty
        $delta.Max | Should -Be 1000000000000000000
    }

    It 'counts the rows even when the statement has no usable watermark column, and does nothing without a delta' {
        $delta = @{ Column = 'modified'; Max = [long]::MinValue; Rows = [long]4; Unusable = $null }
        $rows = [System.Collections.Generic.List[object]]::new(); $rows.Add([object[]]@([decimal]5))
        Update-SqlBatchWatermark -Rows $rows -Plan @{ Watermark = -1 } -Delta $delta
        $delta.Rows | Should -Be 5
        $delta.Max | Should -Be ([long]::MinValue)
        { Update-SqlBatchWatermark -Rows $rows -Plan @{ Watermark = 0 } -Delta $null } | Should -Not -Throw
    }
}

Describe 'Get-SqlBatchKeys' {
    It 'is blank for every row when the statement has no such column' {
        $rows = [System.Collections.Generic.List[object]]::new(); $rows.Add([object[]]@('x')); $rows.Add([object[]]@('y'))
        $k = Get-SqlBatchKeys -Rows $rows -Ordinal -1
        $k.Length | Should -Be 2
        $k | Should -Be @('', '')
    }
}

Describe 'Step-SqlBatchProgress' {
    It 'reports progress once each time the row count crosses a multiple of 100,000' {
        Mock Update-CrawlerProgress { }
        $ctx = @{ Rows = 99000; Slot = @{ name = 'G' } }
        Step-SqlBatchProgress -Ctx $ctx -Count 1000     # 100,000 exactly
        Step-SqlBatchProgress -Ctx $ctx -Count 1000     # 101,000
        Step-SqlBatchProgress -Ctx $ctx -Count 150000   # 251,000: crosses two, reports once
        $ctx.Rows | Should -Be 251000
        Should -Invoke Update-CrawlerProgress -Exactly 2
        Should -Invoke Update-CrawlerProgress -Exactly 1 -ParameterFilter { $Detail -eq "G: $((100000).ToString('N0')) rows" }
    }
}

Describe 'Invoke-SqlQueryStream -OnBatch' {
    It 'refuses to run with both callbacks or with neither' {
        { Invoke-SqlQueryStream -Connection 'c' -Sql 'x' } | Should -Throw '*exactly one of -OnRow and -OnBatch*'
        { Invoke-SqlQueryStream -Connection 'c' -Sql 'x' -OnRow { } -OnBatch { } } | Should -Throw '*exactly one of -OnRow and -OnBatch*'
    }
}
