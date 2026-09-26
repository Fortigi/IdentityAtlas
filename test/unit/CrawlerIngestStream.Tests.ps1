#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the shared streaming ingest helper
    (tools/crawlers/shared/Invoke-CrawlerIngestStream.ps1).

.DESCRIPTION
    The HTTP boundary (Invoke-IngestAPI / Invoke-RestMethod) is mocked and every
    body it receives is captured, so the assertions are about what the stream
    DECIDED: when it flushes, what each chunk carries (delta, deterministic ids,
    the per-entity idPrefix, the scope), how in-chunk duplicates collapse, and
    what the reconcile call asks for.

.USAGE
    Invoke-Pester -Path test/unit/CrawlerIngestStream.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:ApiBaseUrl = 'http://localhost:3001/api'
    $script:ApiKey     = 'fgc_test'
    $script:JobId      = 0
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngestStream.ps1')

    function Reset-Sent { $script:sent = [System.Collections.Generic.List[object]]::new() }
    # Records the endpoint + body of every ingest call and answers like the API.
    $script:CaptureMock = {
        $script:sent.Add(@{ Endpoint = $Endpoint; Body = $Body })
        @{ inserted = $Body.records.Count; updated = 0; deleted = 3 }
    }
}

Describe 'New-CrawlerIngestStream' {
    It 'derives the entity from the endpoint and starts empty' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/resource-assignments' -SystemId 7 -IdPrefix 'sql-7' -BatchSize 2
        $s.Entity | Should -Be 'resource-assignments'
        $s.Buffer.Count | Should -Be 0
        $s.Records | Should -Be 0
        $s.KeyFields | Should -Be @('externalId')
    }
}

Describe 'Get-CrawlerStreamRecordKey' {
    It 'joins the key fields of a hashtable record in order' {
        Get-CrawlerStreamRecordKey -Record @{ a = 'x'; b = 'y' } -KeyFields @('b', 'a') | Should -Be 'y|x'
    }
    It 'reads properties off an object record and stringifies a missing field as empty' {
        Get-CrawlerStreamRecordKey -Record ([pscustomobject]@{ a = 1 }) -KeyFields @('a', 'zz') | Should -Be '1|'
    }
}

Describe 'Add-CrawlerIngestStreamRecord / flush protocol' {
    BeforeEach { Reset-Sent; Mock Invoke-IngestAPI $script:CaptureMock }

    It 'buffers below the batch size and sends nothing' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/resources' -SystemId 7 -IdPrefix 'sql-7' -BatchSize 3
        1..2 | ForEach-Object { Add-CrawlerIngestStreamRecord -Stream $s -Record @{ externalId = "r$_" } }
        $script:sent.Count | Should -Be 0
        $s.Buffer.Count | Should -Be 2
        $s.Records | Should -Be 2
    }

    It 'flushes exactly at the batch size as a delta, deterministic-id chunk in the per-entity namespace with the scope' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/resources' -SystemId 7 -IdPrefix 'sql-7' -BatchSize 3 -Scope @{ resourceType = 'Entitlement' }
        1..3 | ForEach-Object { Add-CrawlerIngestStreamRecord -Stream $s -Record @{ externalId = "r$_" } }
        $script:sent.Count | Should -Be 1
        $b = $script:sent[0].Body
        $script:sent[0].Endpoint | Should -Be 'ingest/resources'
        $b.syncMode     | Should -Be 'delta'
        $b.idGeneration | Should -Be 'deterministic'
        $b.idPrefix     | Should -Be 'sql-7-resources'
        $b.systemId     | Should -Be 7
        $b.scope.resourceType | Should -Be 'Entitlement'
        @($b.records).Count | Should -Be 3
        $s.Buffer.Count | Should -Be 0
        $s.Batches | Should -Be 1
    }

    It 'sends 7 records with batch size 3 as 3 + 3 on the way and 1 on completion, in order' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/principals' -SystemId 1 -IdPrefix 'sql-1' -BatchSize 3
        1..7 | ForEach-Object { Add-CrawlerIngestStreamRecord -Stream $s -Record @{ externalId = "p$_" } }
        $script:sent.Count | Should -Be 2
        $totals = Complete-CrawlerIngestStream -Stream $s
        $script:sent.Count | Should -Be 3
        @($script:sent | ForEach-Object { @($_.Body.records).Count }) | Should -Be @(3, 3, 1)
        @($script:sent[2].Body.records)[0].externalId | Should -Be 'p7'
        $totals.records  | Should -Be 7
        $totals.sent     | Should -Be 7
        $totals.batches  | Should -Be 3
        $totals.inserted | Should -Be 7
    }

    It 'collapses duplicate keys within one chunk (last wins) and counts them, but not across chunks' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -IdPrefix 'sql-1' -BatchSize 3 -KeyFields @('resourceExternalId', 'principalExternalId')
        Add-CrawlerIngestStreamRecord -Stream $s -Record @{ resourceExternalId = 'r1'; principalExternalId = 'u1'; n = 1 }
        Add-CrawlerIngestStreamRecord -Stream $s -Record @{ resourceExternalId = 'r1'; principalExternalId = 'u1'; n = 2 }
        Add-CrawlerIngestStreamRecord -Stream $s -Record @{ resourceExternalId = 'r2'; principalExternalId = 'u1'; n = 3 }
        $first = @($script:sent[0].Body.records)
        $first.Count | Should -Be 2
        ($first | Where-Object { $_.resourceExternalId -eq 'r1' }).n | Should -Be 2
        $s.Deduped | Should -Be 1
        # the same key again in the NEXT chunk is sent again (an update, not a duplicate)
        Add-CrawlerIngestStreamRecord -Stream $s -Record @{ resourceExternalId = 'r1'; principalExternalId = 'u1'; n = 4 }
        $t = Complete-CrawlerIngestStream -Stream $s
        @($script:sent[1].Body.records).Count | Should -Be 1
        $t.sent | Should -Be 3
        $t.records | Should -Be 4
        $t.deduped | Should -Be 1
    }

    It 'a key-less stream sends duplicates through untouched' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/x' -SystemId 1 -IdPrefix 'p' -BatchSize 10 -KeyFields @()
        1..3 | ForEach-Object { Add-CrawlerIngestStreamRecord -Stream $s -Record @{ externalId = 'same' } }
        (Complete-CrawlerIngestStream -Stream $s).sent | Should -Be 3
        @($script:sent[0].Body.records).Count | Should -Be 3
    }

    It 'a single-record remainder still serialises as a JSON array' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/identities' -SystemId 1 -IdPrefix 'sql-1'
        Add-CrawlerIngestStreamRecord -Stream $s -Record @{ externalId = 'only' }
        Complete-CrawlerIngestStream -Stream $s | Out-Null
        ($script:sent[0].Body | ConvertTo-Json -Compress -Depth 5) | Should -Match '"records":\[\{'
    }

    It 'completing an empty stream sends nothing and reports zeros' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/identities' -SystemId 1 -IdPrefix 'sql-1'
        $t = Complete-CrawlerIngestStream -Stream $s
        $script:sent.Count | Should -Be 0
        $t.sent | Should -Be 0
        $t.batches | Should -Be 0
    }

    It 'propagates an ingest failure (no silent partial chunk)' {
        Mock Invoke-IngestAPI { throw 'HTTP 500' }
        $s = New-CrawlerIngestStream -Endpoint 'ingest/resources' -SystemId 1 -IdPrefix 'sql-1' -BatchSize 1
        { Add-CrawlerIngestStreamRecord -Stream $s -Record @{ externalId = 'r1' } } | Should -Throw 'HTTP 500'
    }
}

Describe 'Add-CrawlerIngestStreamRecords (a whole collection per call)' {
    BeforeEach { Reset-Sent; Mock Invoke-IngestAPI $script:CaptureMock }

    It 'chunks exactly like the per-record form: no chunk over BatchSize, order kept, nothing lost across calls' {
        # 2 + 7 + 1 records at batch size 3. The 7 overflows a partly-filled buffer
        # AND spans more than one chunk, which is where a slice boundary would drop
        # or repeat a record.
        $s = New-CrawlerIngestStream -Endpoint 'ingest/principals' -SystemId 1 -IdPrefix 'csv' -BatchSize 3
        Add-CrawlerIngestStreamRecords -Stream $s -Records @(1..2 | ForEach-Object { @{ externalId = "p$_" } })
        $script:sent.Count | Should -Be 0
        Add-CrawlerIngestStreamRecords -Stream $s -Records @(3..9 | ForEach-Object { @{ externalId = "p$_" } })
        $script:sent.Count | Should -Be 3                  # p1-3, p4-6, p7-9 went out as they filled
        $s.Buffer.Count | Should -Be 0
        Add-CrawlerIngestStreamRecords -Stream $s -Records @(, @{ externalId = 'p10' })
        $t = Complete-CrawlerIngestStream -Stream $s
        @($script:sent | ForEach-Object { @($_.Body.records).Count }) | Should -Be @(3, 3, 3, 1)
        @($script:sent | ForEach-Object { @($_.Body.records) } | ForEach-Object { $_.externalId }) |
            Should -Be @(1..10 | ForEach-Object { "p$_" })
        $t.records | Should -Be 10
        $t.sent | Should -Be 10
    }

    It 'accepts an empty collection and sends nothing' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/principals' -SystemId 1 -IdPrefix 'csv' -BatchSize 3
        Add-CrawlerIngestStreamRecords -Stream $s -Records @()
        $script:sent.Count | Should -Be 0
        $s.Records | Should -Be 0
    }

    It 'collapses in-chunk duplicates of hashtable records on EVERY key field, including the last' {
        # The inline key builder must use all key fields: a pair held both Direct
        # and Eligible is two assignments, and keying on two of the three fields
        # would silently drop one of them.
        $s = New-CrawlerIngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -IdPrefix 'csv' -BatchSize 10 `
            -KeyFields @('resourceExternalId', 'principalExternalId', 'assignmentType')
        Add-CrawlerIngestStreamRecords -Stream $s -Records @(
            @{ resourceExternalId = 'r1'; principalExternalId = 'u1'; assignmentType = 'Direct' }
            @{ resourceExternalId = 'r1'; principalExternalId = 'u1'; assignmentType = 'Eligible' }
            @{ resourceExternalId = 'r1'; principalExternalId = 'u1'; assignmentType = 'Direct' }
        )
        $t = Complete-CrawlerIngestStream -Stream $s
        @($script:sent[0].Body.records | ForEach-Object assignmentType | Sort-Object) | Should -Be @('Direct', 'Eligible')
        $t.deduped | Should -Be 1
    }

    It 'does not merge keys whose fields only concatenate alike' {
        # 'a|b' + 'c' and 'a' + 'b|c' — a separator-free key would collide.
        $s = New-CrawlerIngestStream -Endpoint 'ingest/x' -SystemId 1 -IdPrefix 'csv' -BatchSize 10 -KeyFields @('x', 'y')
        Add-CrawlerIngestStreamRecords -Stream $s -Records @(@{ x = 'ab'; y = 'c' }, @{ x = 'a'; y = 'bc' })
        (Complete-CrawlerIngestStream -Stream $s).deduped | Should -Be 0
    }

    It 'dedups object records through the property path' {
        $s = New-CrawlerIngestStream -Endpoint 'ingest/x' -SystemId 1 -IdPrefix 'csv' -BatchSize 10
        Add-CrawlerIngestStreamRecords -Stream $s -Records @([pscustomobject]@{ externalId = 'e1'; n = 1 }, [pscustomobject]@{ externalId = 'e1'; n = 2 })
        Complete-CrawlerIngestStream -Stream $s | Out-Null
        @($script:sent[0].Body.records).Count | Should -Be 1
        @($script:sent[0].Body.records)[0].n | Should -Be 2
    }
}

Describe 'Invoke-CrawlerReconcile' {
    BeforeEach { Reset-Sent; Mock Invoke-IngestAPI $script:CaptureMock }

    It 'posts entity, systemId, scope and before to ingest/reconcile and returns the deleted count' {
        $n = Invoke-CrawlerReconcile -Endpoint 'ingest/resource-assignments' -SystemId 7 -Scope @{ assignmentType = 'Direct'; governed = $true } -Before '2026-09-25T10:00:00.000Z'
        $n | Should -Be 3
        $script:sent[0].Endpoint | Should -Be 'ingest/reconcile'
        $b = $script:sent[0].Body
        $b.entity   | Should -Be 'resource-assignments'
        $b.systemId | Should -Be 7
        $b.before   | Should -Be '2026-09-25T10:00:00.000Z'
        $b.scope.assignmentType | Should -Be 'Direct'
        $b.scope.governed | Should -BeTrue
    }

    It 'treats a response without a count as zero' {
        Mock Invoke-IngestAPI { @{} }
        Invoke-CrawlerReconcile -Endpoint 'ingest/resources' -SystemId 1 -Before '2026-01-01T00:00:00Z' | Should -Be 0
    }
}

Describe 'Get-CrawlerServerTime' {
    It 'returns the serverTime whoami reports, with the bearer key' {
        Mock Invoke-RestMethod { [pscustomobject]@{ id = 1; serverTime = '2026-09-25T09:00:00.000Z' } }
        Get-CrawlerServerTime | Should -Be '2026-09-25T09:00:00.000Z'
        Should -Invoke Invoke-RestMethod -Exactly 1 -ParameterFilter { $Uri -eq 'http://localhost:3001/api/crawlers/whoami' -and $Headers.Authorization -eq 'Bearer fgc_test' }
    }

    It 'falls back to the local UTC clock (ISO round-trip format) when the API has no serverTime' {
        Mock Invoke-RestMethod { [pscustomobject]@{ id = 1 } }
        $before = [DateTime]::UtcNow.AddSeconds(-1)
        $t = [DateTime]::Parse((Get-CrawlerServerTime), $null, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
        $t | Should -BeGreaterOrEqual $before
        $t | Should -BeLessOrEqual ([DateTime]::UtcNow.AddSeconds(1))
    }
}
