#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the extracted midPoint crawler functions
    (MidpointCrawler.Functions.ps1).

.DESCRIPTION
    These cover the ingest batching/streaming, performance-stat, phase-error, and
    shadow-labelling functions that were moved verbatim out of Start-MidpointCrawler.ps1.
    The Start script's Main body is NOT run — only the function file is dot-sourced.

    Functions that build records or compute modes are tested directly; functions that
    call the Ingest API (Send-IngestBatch and the streaming helpers) are tested by
    mocking Invoke-IngestAPI so no network is hit. The midPoint REST helpers used by
    Get-MidpointShadowLabel come from Invoke-MidpointApi.ps1, also dot-sourced here.

    No case here duplicates test/unit/Midpoint.Tests.ps1 (which tests the pure helpers
    in Invoke-MidpointApi.ps1 — not the Start-script functions extracted here).

.USAGE
    Invoke-Pester -Path test/unit/MidpointCrawlerFunctions.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:midpointDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'midpoint'

    # The midPoint REST helpers (Get-MidpointAttrValue, Get-MidpointString,
    # Format-AccountLabel, …) are used by Get-MidpointShadowLabel.
    . (Join-Path $script:midpointDir 'Invoke-MidpointApi.ps1')

    # ConvertTo-JsonArray / Invoke-IngestAPI live in the shared helpers; the streaming
    # and batch functions call them. (Invoke-IngestAPI is mocked per-test.)
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')

    # The unit under test.
    . (Join-Path $script:midpointDir 'MidpointCrawler.Functions.ps1')

    # ── Script-scope state the functions read at call time ──────────────────────
    # (Normally set up by Start-MidpointCrawler.ps1's Configuration region / Main.)
    $script:CrossSystemEntities = @('systems', 'identities', 'identity-members', 'context-members', 'governance/certifications')
    $script:SyncMode            = 'full'
    $script:ingestStats         = [ordered]@{}
    $script:fetchStats          = [ordered]@{}
    $script:phaseErrors         = [System.Collections.Generic.List[string]]::new()

    # Lookup maps consumed by Get-MidpointShadowLabel.
    $script:ShadowOidToUserOid = @{}
    $script:UserOidToName      = @{}
    $script:ResourceOidToName  = @{}
}

# ─── Get-EntitySyncMode ───────────────────────────────────────────────────────
Describe 'Get-EntitySyncMode' {
    It 'forces cross-system entities to delta regardless of the configured mode' {
        $script:SyncMode = 'full'
        Get-EntitySyncMode -Entity 'systems'               | Should -Be 'delta'
        Get-EntitySyncMode -Entity 'identities'            | Should -Be 'delta'
        Get-EntitySyncMode -Entity 'identity-members'      | Should -Be 'delta'
        Get-EntitySyncMode -Entity 'context-members'       | Should -Be 'delta'
        Get-EntitySyncMode -Entity 'governance/certifications' | Should -Be 'delta'
    }
    It 'returns the configured sync mode for a per-system-scoped entity' {
        $script:SyncMode = 'full'
        Get-EntitySyncMode -Entity 'resources' | Should -Be 'full'
        $script:SyncMode = 'delta'
        Get-EntitySyncMode -Entity 'resources' | Should -Be 'delta'
        $script:SyncMode = 'full'   # restore
    }
}

# ─── Send-IngestBatch ─────────────────────────────────────────────────────────
Describe 'Send-IngestBatch' {
    BeforeEach {
        $script:ingestStats = [ordered]@{}
        $script:SyncMode    = 'full'
    }

    It 'skips the API call and returns zeros when there are no records' {
        Mock Invoke-IngestAPI { throw 'should not be called' }
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 7 -Records @()
        $r.inserted | Should -Be 0
        $r.updated  | Should -Be 0
        $r.deleted  | Should -Be 0
        Should -Invoke Invoke-IngestAPI -Times 0
    }

    It 'sends a single batch (records ≤ BatchSize) with the resolved sync mode and scope' {
        $captured = $null
        Mock Invoke-IngestAPI { $script:captured = $Body; return @{ inserted = 2; updated = 1; deleted = 0 } }
        $recs = @([pscustomobject]@{ id = 'a' }, [pscustomobject]@{ id = 'b' })
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 7 -Scope @{ resourceType = 'Service' } -Records $recs
        Should -Invoke Invoke-IngestAPI -Times 1
        $r.inserted | Should -Be 2
        $r.updated  | Should -Be 1
        $script:captured.systemId          | Should -Be 7
        $script:captured.syncMode          | Should -Be 'full'
        $script:captured.scope.resourceType | Should -Be 'Service'
        # Records are always wrapped as a List so they serialise as a JSON array.
        @($script:captured.records).Count  | Should -Be 2
    }

    It 'forces delta mode for a cross-system endpoint even when SyncMode is full' {
        $captured = $null
        Mock Invoke-IngestAPI { $script:captured = $Body; return @{ inserted = 1; updated = 0; deleted = 0 } }
        Send-IngestBatch -Endpoint 'ingest/identities' -SystemId 3 -Records @([pscustomobject]@{ id = 'u1' }) | Out-Null
        $script:captured.syncMode | Should -Be 'delta'
    }

    It 'honours an explicit SyncModeOverride' {
        $captured = $null
        Mock Invoke-IngestAPI { $script:captured = $Body; return @{ inserted = 0; updated = 0; deleted = 0 } }
        Send-IngestBatch -Endpoint 'ingest/resources' -SyncModeOverride 'delta' -Records @([pscustomobject]@{ id = 'x' }) | Out-Null
        $script:captured.syncMode | Should -Be 'delta'
    }

    It 'chunks a large batch into a start→continue→end session and aggregates totals' {
        $script:bodies = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI {
            $script:bodies.Add($Body)
            # Only the first (start) call returns a syncId; each call inserts its chunk count.
            $isStart = ($Body.syncSession -eq 'start')
            return @{ inserted = $Body.records.Count; updated = 0; deleted = 0; syncId = $(if ($isStart) { 'SESSION-1' } else { $null }) }
        }
        # 12 records, BatchSize 5 → chunks of 5, 5, 2 → start, continue, end.
        $recs = 1..12 | ForEach-Object { [pscustomobject]@{ id = "r$_" } }
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 9 -Records @($recs) -BatchSize 5
        Should -Invoke Invoke-IngestAPI -Times 3
        @($script:bodies).Count | Should -Be 3
        $script:bodies[0].syncSession | Should -Be 'start'
        $script:bodies[1].syncSession | Should -Be 'continue'
        $script:bodies[2].syncSession | Should -Be 'end'
        # The syncId from the start call is threaded into the later calls.
        $script:bodies[1].syncId | Should -Be 'SESSION-1'
        $script:bodies[2].syncId | Should -Be 'SESSION-1'
        # Totals summed across chunks (5 + 5 + 2).
        $r.inserted | Should -Be 12
    }

    It 'records a per-endpoint ingest stat for the call' {
        Mock Invoke-IngestAPI { return @{ inserted = 1; updated = 0; deleted = 0 } }
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId 1 -Records @([pscustomobject]@{ id = 'p' }) | Out-Null
        $script:ingestStats.Contains('principals') | Should -BeTrue
        $script:ingestStats['principals'].calls    | Should -Be 1
        $script:ingestStats['principals'].records  | Should -Be 1
    }
}

# ─── New-IngestStream ─────────────────────────────────────────────────────────
Describe 'New-IngestStream' {
    It 'initialises an empty stream with the supplied endpoint/system/scope/batch size' {
        $s = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId 4 -Scope @{ assignmentType = 'Direct' } -BatchSize 100
        $s.Endpoint        | Should -Be 'ingest/resource-assignments'
        $s.SystemId        | Should -Be 4
        $s.Scope.assignmentType | Should -Be 'Direct'
        $s.BatchSize       | Should -Be 100
        $s.Buffer.Count    | Should -Be 0
        $s.Started         | Should -BeFalse
        $s.Records         | Should -Be 0
        $s.Inserted        | Should -Be 0
    }

    It 'starts every running total at zero, not just Records/Inserted' {
        # All four counters are accumulated with += later; a non-zero seed would
        # silently inflate the totals the crawler reports at the end of a sync.
        $s = New-IngestStream -Endpoint 'ingest/resources'
        $s.Records  | Should -Be 0
        $s.Inserted | Should -Be 0
        $s.Updated  | Should -Be 0
        $s.Deleted  | Should -Be 0
        $s.SyncId   | Should -BeNullOrEmpty
    }
}

# ─── Add-IngestStreamRecord / Send-IngestStreamChunk / Complete-IngestStream ──
Describe 'Streaming ingest (Add-IngestStreamRecord + Complete-IngestStream)' {
    BeforeEach {
        $script:ingestStats = [ordered]@{}
        $script:SyncMode    = 'full'
    }

    It 'buffers records without flushing until MORE than a full batch is held' {
        Mock Invoke-IngestAPI { throw 'should not flush yet' }
        $s = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -BatchSize 3
        1..3 | ForEach-Object { Add-IngestStreamRecord -Stream $s -Record ([pscustomobject]@{ id = "a$_" }) }
        # Exactly BatchSize records → no flush yet (a non-empty remainder must remain for 'end').
        Should -Invoke Invoke-IngestAPI -Times 0
        $s.Buffer.Count | Should -Be 3
        $s.Started      | Should -BeFalse
        $s.Records      | Should -Be 3
    }

    It 'captures the syncId from the opening chunk only' {
        # `$Session -in @('start','single') -and $R.syncId` — if that -and became an
        # -or, a later 'continue' response could overwrite the session id mid-stream
        # and the server would treat the rest of the sync as a different session.
        $script:bodies = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI {
            $script:bodies.Add($Body)
            # Every response carries a syncId; only the first may be adopted.
            return @{ inserted = 0; updated = 0; deleted = 0; syncId = "SS$($script:bodies.Count)" }
        }
        $s = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -BatchSize 2
        1..7 | ForEach-Object { Add-IngestStreamRecord -Stream $s -Record ([pscustomobject]@{ id = "a$_" }) }
        Complete-IngestStream -Stream $s

        $script:bodies[0].syncSession | Should -Be 'start'
        $script:bodies[1].syncSession | Should -Be 'continue'
        $s.SyncId | Should -Be 'SS1'
        # Every follow-up chunk must quote the original session id.
        $script:bodies[1].syncId | Should -Be 'SS1'
    }

    It 'treats absent counters in a chunk response as zero' {
        # The totals are accumulated as ($R.inserted ?? 0); dropping that guard
        # would turn a sparse response into $null and poison the running total.
        Mock Invoke-IngestAPI { return @{ syncId = 'SS' } }
        $s = New-IngestStream -Endpoint 'ingest/resources' -SystemId 1 -BatchSize 2
        1..5 | ForEach-Object { Add-IngestStreamRecord -Stream $s -Record ([pscustomobject]@{ id = "a$_" }) }
        Complete-IngestStream -Stream $s
        $s.Inserted | Should -Be 0
        $s.Updated  | Should -Be 0
        $s.Deleted  | Should -Be 0
        $s.Records  | Should -Be 5
    }

    It 'sums the counters across every chunk of a session' {
        Mock Invoke-IngestAPI { return @{ inserted = 2; updated = 1; deleted = 3; syncId = 'SS' } }
        $s = New-IngestStream -Endpoint 'ingest/resources' -SystemId 1 -BatchSize 2
        1..5 | ForEach-Object { Add-IngestStreamRecord -Stream $s -Record ([pscustomobject]@{ id = "a$_" }) }
        Complete-IngestStream -Stream $s
        # 5 records at BatchSize 2 → two flushes plus the closing chunk = 3 calls.
        Should -Invoke Invoke-IngestAPI -Exactly 3
        $s.Inserted | Should -Be 6
        $s.Updated  | Should -Be 3
        $s.Deleted  | Should -Be 9
    }

    It 'flushes a start chunk once the buffer exceeds the batch size, leaving a remainder' {
        $script:bodies = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $script:bodies.Add($Body); return @{ inserted = 0; updated = 0; deleted = 0; syncId = 'SS' } }
        $s = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -BatchSize 3
        1..4 | ForEach-Object { Add-IngestStreamRecord -Stream $s -Record ([pscustomobject]@{ id = "a$_" }) }
        # 4 > 3 → flush a 'start' chunk of 3, keep 1 in the buffer.
        Should -Invoke Invoke-IngestAPI -Times 1
        $script:bodies[0].syncSession | Should -Be 'start'
        $s.Started      | Should -BeTrue
        $s.SyncId       | Should -Be 'SS'
        $s.Buffer.Count | Should -Be 1
    }

    It 'emits a single (no-session) call when everything fits in one batch on Complete' {
        $script:bodies = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $script:bodies.Add($Body); return @{ inserted = 2; updated = 0; deleted = 0 } }
        $s = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -BatchSize 10
        1..2 | ForEach-Object { Add-IngestStreamRecord -Stream $s -Record ([pscustomobject]@{ id = "a$_" }) }
        Complete-IngestStream -Stream $s
        Should -Invoke Invoke-IngestAPI -Times 1
        # 'single' → no syncSession key on the body.
        $script:bodies[0].ContainsKey('syncSession') | Should -BeFalse
        $s.Inserted | Should -Be 2
    }

    It 'closes a started session with an end chunk on Complete' {
        $script:bodies = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $script:bodies.Add($Body); return @{ inserted = 0; updated = 0; deleted = 0; syncId = 'SS' } }
        $s = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -BatchSize 3
        1..4 | ForEach-Object { Add-IngestStreamRecord -Stream $s -Record ([pscustomobject]@{ id = "a$_" }) }  # 1 start flush
        Complete-IngestStream -Stream $s                                                                        # end flush
        Should -Invoke Invoke-IngestAPI -Times 2
        $script:bodies[0].syncSession | Should -Be 'start'
        $script:bodies[1].syncSession | Should -Be 'end'
        $script:bodies[1].syncId      | Should -Be 'SS'   # threaded from the start response
    }

    It 'does nothing on Complete when no records were ever added (no scoped delete)' {
        Mock Invoke-IngestAPI { throw 'should not be called for an empty stream' }
        $s = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -BatchSize 5
        Complete-IngestStream -Stream $s
        Should -Invoke Invoke-IngestAPI -Times 0
    }

    It 'streams the full record set across chunk boundaries (totals add up)' {
        Mock Invoke-IngestAPI {
            return @{ inserted = $Body.records.Count; updated = 0; deleted = 0; syncId = 'SS' }
        }
        $s = New-IngestStream -Endpoint 'ingest/resource-assignments' -SystemId 1 -BatchSize 4
        1..10 | ForEach-Object { Add-IngestStreamRecord -Stream $s -Record ([pscustomobject]@{ id = "a$_" }) }
        Complete-IngestStream -Stream $s
        $s.Records  | Should -Be 10
        $s.Inserted | Should -Be 10   # every record reported inserted exactly once
    }
}

# ─── Add-IngestStat ───────────────────────────────────────────────────────────
Describe 'Add-IngestStat' {
    BeforeEach { $script:ingestStats = [ordered]@{} }

    It 'creates a new endpoint bucket on first call' {
        Add-IngestStat -Endpoint 'resources' -Seconds 1.5 -Records 10
        $script:ingestStats['resources'].seconds | Should -Be 1.5
        $script:ingestStats['resources'].calls   | Should -Be 1
        $script:ingestStats['resources'].records | Should -Be 10
    }
    It 'accumulates seconds, calls and records across multiple calls to the same endpoint' {
        Add-IngestStat -Endpoint 'resources' -Seconds 1.0 -Records 5
        Add-IngestStat -Endpoint 'resources' -Seconds 2.0 -Records 7
        $script:ingestStats['resources'].seconds | Should -Be 3.0
        $script:ingestStats['resources'].calls   | Should -Be 2
        $script:ingestStats['resources'].records | Should -Be 12
    }
}

# ─── Measure-MidpointFetch ────────────────────────────────────────────────────
Describe 'Measure-MidpointFetch' {
    BeforeEach { $script:fetchStats = [ordered]@{} }

    It 'returns the scriptblock result unchanged' {
        $r = Measure-MidpointFetch -Label 'users' -Script { @('u1', 'u2', 'u3') }
        @($r) | Should -Be @('u1', 'u2', 'u3')
    }
    It 'records the object count for the labelled read' {
        Measure-MidpointFetch -Label 'roles' -Script { @('r1', 'r2') } | Out-Null
        $script:fetchStats.Contains('roles') | Should -BeTrue
        $script:fetchStats['roles'].count    | Should -Be 2
    }
    It 'counts a single (scalar) result as one object' {
        Measure-MidpointFetch -Label 'one' -Script { 'solo' } | Out-Null
        $script:fetchStats['one'].count | Should -Be 1
    }
}

# ─── Add-PhaseError ───────────────────────────────────────────────────────────
Describe 'Add-PhaseError' {
    BeforeEach { $script:phaseErrors = [System.Collections.Generic.List[string]]::new() }

    It 'appends a "Phase: message" entry to the shared phase-error list' {
        Add-PhaseError -Phase 'Roles' -Msg 'boom'
        $script:phaseErrors.Count | Should -Be 1
        $script:phaseErrors[0]    | Should -Be 'Roles: boom'
    }
    It 'accumulates multiple phase errors in order' {
        Add-PhaseError -Phase 'Orgs'  -Msg 'a'
        Add-PhaseError -Phase 'Users' -Msg 'b'
        $script:phaseErrors.Count | Should -Be 2
        $script:phaseErrors[1]    | Should -Be 'Users: b'
    }
}

# ─── Write-Step ───────────────────────────────────────────────────────────────
Describe 'Write-Step' {
    It 'runs without throwing (progress logging only)' {
        { Write-Step -Msg 'doing the thing' } | Should -Not -Throw
    }
}

# ─── Get-MidpointShadowLabel ──────────────────────────────────────────────────
Describe 'Get-MidpointShadowLabel' {
    BeforeEach {
        $script:ShadowOidToUserOid = @{}
        $script:UserOidToName      = @{}
        $script:ResourceOidToName  = @{}
    }

    It 'prefers a readable attribute (fullName) over the raw shadow name' {
        $shadow = [pscustomobject]@{
            name       = '12345'
            attributes = [pscustomobject]@{ 'ri:fullName' = [pscustomobject]@{ '@value' = 'Andrea Hill' } }
        }
        Get-MidpointShadowLabel -Shadow $shadow -ShadowOid 'sh-1' -ResourceOid 'res-1' | Should -Be 'Andrea Hill'
    }

    It 'falls back to the formatted shadow name when no readable attribute exists' {
        $shadow = [pscustomobject]@{ name = 'CN=Jane Roe [JROE@x.com],OU=Users,DC=x'; attributes = [pscustomobject]@{} }
        Get-MidpointShadowLabel -Shadow $shadow -ShadowOid 'sh-2' -ResourceOid 'res-1' | Should -Be 'Jane Roe'
    }

    It 'uses "owner name (resource)" when the shadow name is purely numeric and the owner is known' {
        $script:ShadowOidToUserOid = @{ 'sh-3' = 'user-9' }
        $script:UserOidToName      = @{ 'user-9' = 'Bob Smith' }
        $script:ResourceOidToName  = @{ 'res-2'  = 'Active Directory' }
        $shadow = [pscustomobject]@{ name = '99001'; attributes = [pscustomobject]@{} }
        Get-MidpointShadowLabel -Shadow $shadow -ShadowOid 'sh-3' -ResourceOid 'res-2' | Should -Be 'Bob Smith (Active Directory)'
    }

    It 'uses "owner name (account)" when the resource name is unknown' {
        $script:ShadowOidToUserOid = @{ 'sh-4' = 'user-1' }
        $script:UserOidToName      = @{ 'user-1' = 'Carol King' }
        $shadow = [pscustomobject]@{ name = '4242'; attributes = [pscustomobject]@{} }
        Get-MidpointShadowLabel -Shadow $shadow -ShadowOid 'sh-4' -ResourceOid 'res-unknown' | Should -Be 'Carol King (account)'
    }

    It 'falls back to the raw shadow name when numeric and no owner is known' {
        $shadow = [pscustomobject]@{ name = '7777'; attributes = [pscustomobject]@{} }
        Get-MidpointShadowLabel -Shadow $shadow -ShadowOid 'sh-orphan' -ResourceOid 'res-x' | Should -Be '7777'
    }

    It 'falls back to the shadow OID when the shadow has no name and no owner' {
        # A truly absent (null) name makes Get-MidpointString fall through to the OID fallback.
        $shadow = [pscustomobject]@{ name = $null; attributes = [pscustomobject]@{} }
        Get-MidpointShadowLabel -Shadow $shadow -ShadowOid 'sh-id-5' -ResourceOid 'res-x' | Should -Be 'sh-id-5'
    }
}
