# Pester tests for the shared Invoke-CrawlerIngestBatch — the one canonical
# crawler ingest-batch protocol that replaced five drifted per-crawler copies.
# Invoke-IngestAPI is mocked so we can assert the exact request bodies for every
# opt-in behaviour (chunking, deletes, empty-skip, id-generation, sync-mode
# resolver, stats). No network.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' '..' 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    function New-Recs { param([int]$n) 1..$n | ForEach-Object { @{ id = "id-$_" } } }
}

Describe 'Invoke-CrawlerIngestBatch' {
    BeforeEach {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI {
            $script:sent.Add($Body)
            return @{ inserted = $Body.records.Count; updated = 0; deleted = 0; syncId = 'sync-1' }
        } -ModuleName $null

        # A DEFAULT Write-Host mock, declared before the filtered ones the progress
        # tests add. A mock that only has a -ParameterFilter has nothing to fall back
        # to when a call does not match it, and this function writes several lines per
        # call — so the three tests below failed with "no mock matched the call"
        # whenever they ran without another container happening to have Write-Host
        # mocked. They passed in the full suite and failed when this file ran alone,
        # which also made the mutation baseline depend on how many files were mapped.
        Mock Write-Host { }
    }

    Context 'single batch' {
        It 'sends one full-sync batch with the records as a JSON array' {
            $r = Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -SystemId 7 -Records (New-Recs 3)
            $script:sent.Count | Should -Be 1
            $b = $script:sent[0]
            $b.systemId | Should -Be 7
            $b.syncMode | Should -Be 'full'
            $b.records.Count | Should -Be 3
            $b.ContainsKey('syncSession') | Should -BeFalse
            $r.inserted | Should -Be 3
        }

        It 'wraps a single record as an array (the delta single-record fix)' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 1) | Out-Null
            ,$script:sent[0].records | Should -BeOfType [System.Collections.IEnumerable]
            $script:sent[0].records.Count | Should -Be 1
        }
    }

    Context 'chunked session' {
        It 'splits into start/continue/end sessions above BatchSize' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resource-assignments' -Records (New-Recs 5) -BatchSize 2 | Out-Null
            $script:sent.Count | Should -Be 3
            $script:sent[0].syncSession | Should -Be 'start'
            $script:sent[1].syncSession | Should -Be 'continue'
            $script:sent[2].syncSession | Should -Be 'end'
            $script:sent[1].syncId | Should -Be 'sync-1'   # carried from the start batch
        }
    }

    Context 'deletes' {
        It 'includes deletedIds in the single batch' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 2) -DeletedIds @('a', 'b') | Out-Null
            $script:sent.Count | Should -Be 1
            $script:sent[0].deletedIds.Count | Should -Be 2
        }

        It 'sends a separate delete batch first in the chunked path' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 4) -DeletedIds @('x') -BatchSize 2 | Out-Null
            $script:sent[0].deletedIds.Count | Should -Be 1
            $script:sent[0].records.Count | Should -Be 0        # delete-only leading batch
            $script:sent[1].syncSession | Should -Be 'start'
        }
    }

    Context 'empty records' {
        It 'sends an empty full-sync batch by default (server scoped-delete)' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -SystemId 3 -Records @() | Out-Null
            $script:sent.Count | Should -Be 1
            $script:sent[0].records.Count | Should -Be 0
        }

        It 'skips the call entirely with -SkipWhenEmpty' {
            $r = Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records @() -SkipWhenEmpty
            $script:sent.Count | Should -Be 0
            $r.inserted | Should -Be 0
        }
    }

    Context 'deterministic id generation (CSV)' {
        It 'adds idGeneration and a per-endpoint idPrefix' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resource-assignments' -Records (New-Recs 1) -IdGeneration 'deterministic' -IdPrefix 'acme' | Out-Null
            $script:sent[0].idGeneration | Should -Be 'deterministic'
            $script:sent[0].idPrefix | Should -Be 'acme-resource-assignments'
        }
    }

    Context 'sync-mode resolver (midPoint)' {
        It 'resolves the sync mode per entity' {
            $resolver = { param($e) if ($e -eq 'identities') { 'delta' } else { 'full' } }
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/identities' -Records (New-Recs 1) -SyncModeResolver $resolver | Out-Null
            $script:sent[0].syncMode | Should -Be 'delta'
        }
    }

    Context 'stats callback (midPoint)' {
        It 'invokes -OnStat with entity and record count' {
            $script:stat = $null
            $onStat = { param($e, $s, $c) $script:stat = @{ entity = $e; count = $c } }
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 4) -OnStat $onStat | Out-Null
            $script:stat.entity | Should -Be 'resources'
            $script:stat.count | Should -Be 4
        }
    }

    # ── Chunk boundaries ────────────────────────────────────────────────────
    # The slice expression is Records[$i .. min($i + $BatchSize - 1, Count - 1)].
    # Asserting only the batch *count* leaves every off-by-one in that expression
    # alive — a dropped or duplicated record ships silently. Assert the contents.
    Context 'chunk boundaries' {
        It 'partitions the records exactly once, in order, with no gaps or repeats' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 5) -BatchSize 2 | Out-Null
            $script:sent.Count | Should -Be 3
            @($script:sent[0].records | ForEach-Object { $_.id }) | Should -Be @('id-1', 'id-2')
            @($script:sent[1].records | ForEach-Object { $_.id }) | Should -Be @('id-3', 'id-4')
            @($script:sent[2].records | ForEach-Object { $_.id }) | Should -Be @('id-5')
        }

        It 'sends a single batch when the record count is exactly BatchSize' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 4) -BatchSize 4 | Out-Null
            $script:sent.Count | Should -Be 1
            $script:sent[0].ContainsKey('syncSession') | Should -BeFalse
        }

        It 'chunks as soon as the record count exceeds BatchSize by one' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 5) -BatchSize 4 | Out-Null
            $script:sent.Count | Should -Be 2
            @($script:sent[1].records | ForEach-Object { $_.id }) | Should -Be @('id-5')
        }

        It 'marks the final batch "end" even when it is exactly full' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 4) -BatchSize 2 | Out-Null
            $script:sent.Count | Should -Be 2
            $script:sent[0].syncSession | Should -Be 'start'
            $script:sent[1].syncSession | Should -Be 'end'
        }

        It 'numbers the batch progress lines 1..N of N' {
            Mock Write-Host { } -ParameterFilter { $Object -like '  Batch *' }
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 5) -BatchSize 2 | Out-Null
            foreach ($line in '  Batch 1/3 done', '  Batch 2/3 done', '  Batch 3/3 done') {
                Should -Invoke Write-Host -Exactly 1 -ParameterFilter { $Object -eq $line }
            }
        }
    }

    # ── Result accumulation ─────────────────────────────────────────────────
    # Every counter starts at 0 and is summed with a ?? 0 null-guard. A wrong
    # seed or a dropped guard reports a plausible-but-wrong ingest total, which
    # is exactly the kind of number nobody re-checks.
    Context 'result accumulation' {
        It 'sums inserted and updated across every chunk' {
            Mock Invoke-IngestAPI { return @{ inserted = 10; updated = 3; deleted = 0; syncId = 's' } } -ModuleName $null
            $r = Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 5) -BatchSize 2
            $r.inserted | Should -Be 30   # 3 batches x 10
            $r.updated  | Should -Be 9    # 3 batches x 3
        }

        It 'treats missing counters in the response as zero, not as one' {
            # DeletedIds included so the separate delete-batch counter is seeded
            # from a response with no `deleted` field too, not just the chunks.
            Mock Invoke-IngestAPI { return @{ syncId = 's' } } -ModuleName $null
            $r = Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 5) -DeletedIds @('x') -BatchSize 2
            $r.inserted | Should -Be 0
            $r.updated  | Should -Be 0
            $r.deleted  | Should -Be 0
        }

        It 'adds the separate delete batch to the final deleted total' {
            Mock Invoke-IngestAPI { return @{ inserted = 0; updated = 0; deleted = 2; syncId = 's' } } -ModuleName $null
            $r = Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 3) -DeletedIds @('x', 'y') -BatchSize 2
            # 2 from the leading delete-only batch + 2 reported by the last chunk.
            $r.deleted | Should -Be 4
        }

        It 'returns explicit zeros when the batch is skipped as empty' {
            $r = Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records @() -SkipWhenEmpty
            $r.inserted | Should -Be 0
            $r.updated  | Should -Be 0
            $r.deleted  | Should -Be 0
        }
    }

    # ── Records / deletes presence ──────────────────────────────────────────
    Context 'records and deletes presence' {
        It 'still sends when there are only deletes and no records' {
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records @() -DeletedIds @('gone') -SkipWhenEmpty | Out-Null
            $script:sent.Count | Should -Be 1
            $script:sent[0].deletedIds.Count | Should -Be 1
        }

        It 'announces the delete count only when records and deletes are both present' {
            Mock Write-Host { } -ParameterFilter { $Object -like '*deletes)*' }
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 2) -DeletedIds @('a') | Out-Null
            Should -Invoke Write-Host -Exactly 1 -ParameterFilter { $Object -eq ' (+1 deletes)' }
        }

        It 'omits the delete suffix when there is nothing to delete' {
            Mock Write-Host { } -ParameterFilter { $Object -like '*deletes)*' }
            Invoke-CrawlerIngestBatch -Endpoint 'ingest/resources' -Records (New-Recs 2) | Out-Null
            Should -Invoke Write-Host -Exactly 0 -ParameterFilter { $Object -like '*deletes)*' }
        }
    }
}
