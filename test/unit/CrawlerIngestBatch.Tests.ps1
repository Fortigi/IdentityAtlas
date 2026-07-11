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
}
