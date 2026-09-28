#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Ownership.ps1 — the
    owner column a `resources` statement carries, turned into a real link.

.DESCRIPTION
    The inputs are chosen to DISCRIMINATE, because the cheap versions of these
    tests all pass against the wrong code:

      * the owner is resolved by account key AND by employee number, and the two
        are never the same string in a test, so "returns what it was given"
        fails;
      * one value is BOTH one account's key and another account's employee
        number, which pins the precedence rather than assuming it;
      * "nobody to match against" and "matched nobody" are asserted as
        DIFFERENT outcomes — a run with no accounts must not report the source's
        owners as wrong;
      * an owner that resolves to nobody is asserted NOT to touch the slot's
        skipped/dangling counters, which is what the 5% unplaced bound reads:
        an owner column that resolves for nothing must report, not fail the job;
      * the ownership resource's external id is asserted to differ from the
        owned resource's, so a shaper that returned the owned id would fail;
      * the same rows are run twice and the payloads compared, which is the
        "a second run deletes and recreates nothing" claim.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerOwnership.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $sqlDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql'
    $script:ApiBaseUrl = 'http://localhost:3001/api'; $script:ApiKey = 'fgc_test'; $script:JobId = 0
    . (Join-Path $sqlDir 'SqlCrawler.Load.ps1')

    function Reset-SqlTestState {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        $script:rowsToReplay = @()
    }
    $script:IngestMock = {
        $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Body = $Body })
        @{ inserted = @($Body.records).Count; updated = 0; deleted = 0; systemIds = @(7) }
    }
    $script:StreamMock = {
        foreach ($r in $script:rowsToReplay) { & $OnRow $r }
        [long]@($script:rowsToReplay).Count
    }
    function New-TestRow { param([hashtable]$Cells) $o = [ordered]@{}; foreach ($k in $Cells.Keys) { $o[$k] = $Cells[$k] }; return $o }
    function Get-Sent { param([string]$Endpoint) @($script:sent | Where-Object { $_.Endpoint -eq $Endpoint }) }
    function Get-SentRecords {
        param([string]$Endpoint, [hashtable]$Scope)
        $out = [System.Collections.Generic.List[object]]::new()
        foreach ($c in (Get-Sent $Endpoint)) {
            if ($Scope) {
                $match = $true
                foreach ($k in $Scope.Keys) { if ("$($c.Body.scope.$k)" -ne "$($Scope[$k])") { $match = $false } }
                if (-not $match) { continue }
            }
            foreach ($r in @($c.Body.records)) { $out.Add($r) }
        }
        return , @($out)
    }
    # A resources slot as Resolve-SqlQuerySlot normalises it, so the tests run
    # the real `ownership` gate rather than a hand-set flag.
    function New-ResourceSlot {
        param([hashtable]$Over = @{})
        $raw = @{ name = 'Entitlements'; target = 'resources'; sql = 'SELECT 1'; resourceType = 'Entitlement' }
        foreach ($k in $Over.Keys) { $raw[$k] = $Over[$k] }
        return Resolve-SqlQuerySlot -Slot $raw
    }
    # A run that has already read accounts, the way a principals slot leaves it.
    # Key and employee number are deliberately unlike each other.
    function New-OwnerState {
        param([hashtable]$Accounts = @{ 'id-ann' = 'E1001'; 'id-bob' = 'E1002' }, [string]$Mode = 'full')
        $s = New-SqlRunState -SystemId 7 -ServerTime '2026-09-28T09:00:00.000Z' -Slots @() -BatchSize 1000 -SyncMode $Mode
        foreach ($k in $Accounts.Keys) {
            Add-SqlKnownKey -Known $s.KnownPrincipals -Key $k -SystemId 7 -Catalog $s.Systems
            if ($Accounts[$k]) { $s.PrincipalsByEmployeeId[$Accounts[$k]] = $k }
        }
        $s.HasPrincipals = $Accounts.Count -gt 0
        return $s
    }
    function New-Resource {
        param([string]$Id = 'ent-1', [string]$Name = 'CRM Reader', [string]$Type = 'Entitlement')
        return [ordered]@{ externalId = $Id; displayName = $Name; resourceType = $Type; enabled = $true }
    }
}

Describe 'Resolve-SqlPrincipalRef' {
    It 'resolves an owner named by the account key' {
        $r = Resolve-SqlPrincipalRef -State (New-OwnerState) -Value 'id-ann'
        $r.Found | Should -BeTrue
        $r.How   | Should -Be 'direct'
        $r.Key   | Should -Be 'id-ann'
    }

    It 'translates an owner named by employee number to the ACCOUNT key' {
        # The key and the employee number are different strings, so a resolver
        # that echoed its input would fail here.
        $r = Resolve-SqlPrincipalRef -State (New-OwnerState) -Value 'E1002'
        $r.Found | Should -BeTrue
        $r.How   | Should -Be 'employeeId'
        $r.Key   | Should -Be 'id-bob'
        $r.Key   | Should -Not -Be 'E1002'
    }

    It 'prefers the account key when one value is also another account employee number' {
        # 'id-ann' is Ann's key AND (in this source) Bob's employee number. The
        # account key wins: an id that IS an account cannot mean somebody else.
        $state = New-OwnerState -Accounts @{ 'id-ann' = 'E1001'; 'id-bob' = 'id-ann' }
        (Resolve-SqlPrincipalRef -State $state -Value 'id-ann').Key | Should -Be 'id-ann'
    }

    It 'reports an unknown owner as not found, distinctly from having nothing to look in' {
        (Resolve-SqlPrincipalRef -State (New-OwnerState) -Value 'E9999').How | Should -Be 'unknown'
        # A run with no accounts did not LOOK; saying "unknown" would blame the
        # source for the run's own configuration.
        (Resolve-SqlPrincipalRef -State (New-OwnerState -Accounts @{}) -Value 'E9999').How | Should -Be 'nolookup'
        (Resolve-SqlPrincipalRef -State $null -Value 'E9999').How | Should -Be 'nolookup'
    }

    It 'treats a blank or whitespace owner as no owner at all' {
        foreach ($v in @('', '   ', $null)) {
            $r = Resolve-SqlPrincipalRef -State (New-OwnerState) -Value $v
            $r.How | Should -Be 'blank'
            $r.Key | Should -BeNullOrEmpty
        }
    }

    It 'ignores surrounding whitespace on a real owner' {
        (Resolve-SqlPrincipalRef -State (New-OwnerState) -Value '  id-ann  ').Key | Should -Be 'id-ann'
    }
}

Describe 'ConvertTo-SqlOwnershipRecords' {
    BeforeEach { $script:tally = New-SqlOwnershipTally }

    It 'emits the ownership resource, the HasOwnership link and the Direct owner assignment' {
        $recs = ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource) -Owner 'id-ann' -Tally $script:tally -State (New-OwnerState)

        $recs.resource.externalId   | Should -Be 'ownership:ent-1'
        # Not the owned resource's own id — the two are separate rows.
        $recs.resource.externalId   | Should -Not -Be 'ent-1'
        $recs.resource.resourceType | Should -Be 'ResourceOwnership'
        # Named after the thing owned, with no "Owner @ " prefix (migration 053).
        $recs.resource.displayName  | Should -Be 'CRM Reader'
        $recs.resource.extendedAttributes.ownedResourceId   | Should -Be 'ent-1'
        $recs.resource.extendedAttributes.ownedResourceType | Should -Be 'Entitlement'

        $recs.relationship.parentExternalId | Should -Be 'ent-1'
        $recs.relationship.childExternalId  | Should -Be 'ownership:ent-1'
        $recs.relationship.relationshipType | Should -Be 'HasOwnership'

        $recs.assignment.resourceExternalId  | Should -Be 'ownership:ent-1'
        $recs.assignment.principalExternalId | Should -Be 'id-ann'
        $recs.assignment.assignmentType      | Should -Be 'Direct'
        $recs.assignment.resourceType        | Should -Be 'ResourceOwnership'
        $recs.assignment.governed            | Should -BeFalse
    }

    It 'assigns the ACCOUNT, not the employee number the source wrote' {
        $recs = ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource) -Owner 'E1002' -Tally $script:tally -State (New-OwnerState)
        $recs.assignment.principalExternalId | Should -Be 'id-bob'
        $script:tally.Mapped   | Should -Be 1
        $script:tally.Resolved | Should -Be 0
    }

    It 'carries the slot resourceType of whatever is owned, not a hardcoded one' {
        $recs = ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource -Type 'SAPRole') -Owner 'id-ann' -Tally $script:tally -State (New-OwnerState)
        $recs.resource.resourceType | Should -Be 'ResourceOwnership'
        $recs.resource.extendedAttributes.ownedResourceType | Should -Be 'SAPRole'
    }

    It 'emits nothing for an owner that matches no account, and counts it by value' {
        $state = New-OwnerState
        ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource -Id 'ent-1') -Owner 'ghost' -Tally $script:tally -State $state | Should -BeNullOrEmpty
        ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource -Id 'ent-2') -Owner 'ghost' -Tally $script:tally -State $state | Should -BeNullOrEmpty
        $script:tally.Emitted | Should -Be 0
        $script:tally.Unresolved['ghost'] | Should -Be 2
        $script:tally.NoLookup | Should -Be 0
    }

    It 'counts "no accounts in this run" separately from "matched nobody"' {
        ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource) -Owner 'id-ann' -Tally $script:tally -State (New-OwnerState -Accounts @{}) | Should -BeNullOrEmpty
        $script:tally.NoLookup | Should -Be 1
        # Nothing is reported as an unresolvable value: nobody looked.
        $script:tally.Unresolved.Count | Should -Be 0
    }

    It 'counts nothing at all for a row with no owner' {
        ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource) -Owner '  ' -Tally $script:tally -State (New-OwnerState) | Should -BeNullOrEmpty
        $script:tally.Emitted + $script:tally.Resolved + $script:tally.Mapped + $script:tally.NoLookup | Should -Be 0
        $script:tally.Unresolved.Count | Should -Be 0
    }
}

Describe 'Get-SqlOwnershipReport / Join-SqlOwnershipTally' {
    It 'reports the counts and names the values nobody could be found for, worst first' {
        $t = New-SqlOwnershipTally
        $state = New-OwnerState
        ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource -Id 'a') -Owner 'id-ann' -Tally $t -State $state | Out-Null
        ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource -Id 'b') -Owner 'E1002'  -Tally $t -State $state | Out-Null
        foreach ($i in 1..3) { ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource -Id "c$i") -Owner 'often' -Tally $t -State $state | Out-Null }
        ConvertTo-SqlOwnershipRecords -ResourceRecord (New-Resource -Id 'd') -Owner 'rare' -Tally $t -State $state | Out-Null

        $r = Get-SqlOwnershipReport -Tally $t
        $r.ownershipsEmitted    | Should -Be 2
        $r.ownersKeyed          | Should -Be 1
        $r.ownersMapped         | Should -Be 1
        $r.ownersUnresolved     | Should -Be 2
        $r.ownersUnresolvedRows | Should -Be 4
        $r.ownersUnresolvedSample[0] | Should -Be "'often' (3)"
    }

    It 'folds one statement tally into the run total without losing either statement values' {
        $run = New-SqlOwnershipTally
        $a = New-SqlOwnershipTally; $a.Emitted = 2; $a.Resolved = 2; $a.Unresolved['x'] = 1
        $b = New-SqlOwnershipTally; $b.Emitted = 3; $b.Mapped = 3; $b.Unresolved['x'] = 4; $b.Unresolved['y'] = 1
        Join-SqlOwnershipTally -Into $run -From $a
        Join-SqlOwnershipTally -Into $run -From $b
        $run.Emitted | Should -Be 5
        $run.Resolved | Should -Be 2
        $run.Mapped | Should -Be 3
        $run.Unresolved['x'] | Should -Be 5
        $run.Unresolved['y'] | Should -Be 1
    }
}

Describe 'New-SqlOwnershipStreams' {
    It 'gives each half of an owner link its own reconcile scope' {
        $state = New-OwnerState
        $streams = New-SqlSlotStreams -Slot (New-ResourceSlot @{ ownership = $true }) -State $state
        @($streams.Keys | Sort-Object) | Should -Be @('ownershipAssignment', 'ownershipRelationship', 'ownershipResource', 'resource')

        # The owned resources keep their own scope; the ownership rows get one
        # that no other statement of the run writes to, so a full sync of either
        # can never remove the other.
        $streams.resource.Scope.resourceType              | Should -Be 'Entitlement'
        $streams.ownershipResource.Scope.resourceType     | Should -Be 'ResourceOwnership'
        $streams.ownershipRelationship.Scope.relationshipType | Should -Be 'HasOwnership'
        $streams.ownershipAssignment.Scope.assignmentType | Should -Be 'Direct'
        $streams.ownershipAssignment.Scope.resourceType   | Should -Be 'ResourceOwnership'
        $streams.ownershipAssignment.Scope.governed       | Should -BeFalse
        foreach ($k in @('ownershipResource', 'ownershipRelationship', 'ownershipAssignment')) { $streams[$k].Reconcile | Should -BeTrue }
    }

    It 'opens no ownership stream when the slot does not ask for one' {
        @((New-SqlSlotStreams -Slot (New-ResourceSlot) -State (New-OwnerState)).Keys) | Should -Be @('resource')
    }

    It 'ignores an ownership flag on a target that has no resources' {
        # The flag is a resources-slot property; Resolve-SqlQuerySlot drops it
        # elsewhere so a stray value cannot change what an assignments statement does.
        $slot = Resolve-SqlQuerySlot -Slot @{ name = 'a'; target = 'assignments'; sql = 'SELECT 1'; resourceType = 'Entitlement'; ownership = $true }
        $slot.ownership | Should -BeFalse
    }

    It 'keys the owner-assignment expectation so the scope can be verified at all' {
        # An assignments STATEMENT gets its expectation from the source's own
        # distinct-pair count. An owner assignment has no statement, so without
        # a key set it would expect zero and fail every run that emitted one.
        $state = New-OwnerState
        $streams = New-SqlSlotStreams -Slot (New-ResourceSlot @{ ownership = $true }) -State $state
        $expect = $streams.ownershipAssignment.Expect
        $null -ne $expect.KeySet | Should -BeTrue   # an EMPTY HashSet is still a key set
        Add-SqlExpectedKey -Expectation $expect -Key 'ownership:ent-1|id-ann'
        (Get-SqlScopeVerdict -Expectation $expect -Atlas 1).ok | Should -BeTrue
        (Get-SqlScopeVerdict -Expectation $expect -Atlas 0).ok | Should -BeFalse
    }
}

Describe 'Stream flush order' {
    # A slot's last, PARTIAL batch is only sent when the slot ends; the full ones
    # before it already went out as they filled, in the order records were added.
    # So the flush order here is the order of a first run's remainder — and
    # IdentityMembers.identityId has a real foreign key. Flushed member-first it
    # inserts links to identities that do not exist yet, which is exactly what
    # the CI integration run hit. The order used to be a hashtable's, i.e.
    # arbitrary.
    It 'sends what is pointed at before what points at it' {
        $order = Get-SqlFlushOrder -Roles @('member', 'principal', 'identity')
        $order.IndexOf('identity')  | Should -BeLessThan $order.IndexOf('member')
        $order.IndexOf('principal') | Should -BeLessThan $order.IndexOf('member')
    }

    It 'sends an owned resource before the link and the assignment that name it' {
        $order = Get-SqlFlushOrder -Roles @('ownershipAssignment', 'ownershipRelationship', 'ownershipResource', 'resource')
        $order.IndexOf('resource')              | Should -BeLessThan $order.IndexOf('ownershipRelationship')
        $order.IndexOf('ownershipResource')     | Should -BeLessThan $order.IndexOf('ownershipRelationship')
        $order.IndexOf('ownershipResource')     | Should -BeLessThan $order.IndexOf('ownershipAssignment')
    }

    It 'keeps a role nobody listed rather than dropping it from the flush' {
        # A role that falls out of the flush is a batch that is never sent: the
        # records vanish and the run still reports success. Ordering must never
        # be able to do that.
        $order = Get-SqlFlushOrder -Roles @('member', 'somethingNew', 'identity')
        @($order | Sort-Object) | Should -Be @('identity', 'member', 'somethingNew')
    }

    It 'flushes every stream of a real slot exactly once, in that order' {
        Reset-SqlTestState
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Invoke-SqlQueryStream $script:StreamMock
        Mock Update-CrawlerProgress { }
        # One row with a batch size of 1000: nothing fills, so EVERY batch is a
        # slot-end flush — the shape that broke.
        $script:rowsToReplay = @((New-TestRow @{ id = 'ent-1'; displayName = 'CRM Reader'; ownerId = 'id-ann' }))
        Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $true }) -Connection 'conn' -State (New-OwnerState) | Out-Null
        $endpoints = @($script:sent | ForEach-Object { $_.Endpoint })
        $endpoints.Count | Should -Be 4
        # The owned resource and the ownership resource share an endpoint; the
        # link and the assignment must both come after both of them.
        $endpoints.IndexOf('ingest/resource-relationships') | Should -BeGreaterThan 1
        $endpoints.IndexOf('ingest/resource-assignments')   | Should -BeGreaterThan 1
    }
}

Describe 'Invoke-SqlSlot — a resources slot that carries an owner' {
    BeforeEach {
        Reset-SqlTestState
        Mock Invoke-IngestAPI $script:IngestMock
        Mock Invoke-SqlQueryStream $script:StreamMock
        Mock Update-CrawlerProgress { }
        $script:ownerRows = @(
            (New-TestRow @{ id = 'ent-1'; displayName = 'CRM Reader'; ownerId = 'id-ann'; ownerName = 'Ann' })
            (New-TestRow @{ id = 'ent-2'; displayName = 'CRM Writer'; ownerId = 'E1002'; ownerName = 'Bob' })
            (New-TestRow @{ id = 'ent-3'; displayName = 'No owner';  ownerId = $null;   ownerName = $null })
        )
    }

    It 'turns the owner column into an ownership resource, a link and an assignment' {
        $script:rowsToReplay = $script:ownerRows
        $state = New-OwnerState
        $r = Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $true }) -Connection 'conn' -State $state
        $r.rows | Should -Be 3

        @((Get-SentRecords 'ingest/resources' @{ resourceType = 'Entitlement' }).externalId) | Should -Be @('ent-1', 'ent-2', 'ent-3')
        $own = Get-SentRecords 'ingest/resources' @{ resourceType = 'ResourceOwnership' }
        @($own.externalId) | Should -Be @('ownership:ent-1', 'ownership:ent-2')
        @($own.displayName) | Should -Be @('CRM Reader', 'CRM Writer')

        $rels = Get-SentRecords 'ingest/resource-relationships'
        @($rels.parentExternalId) | Should -Be @('ent-1', 'ent-2')
        @($rels.relationshipType) | Should -Be @('HasOwnership', 'HasOwnership')

        $asg = Get-SentRecords 'ingest/resource-assignments'
        @($asg.resourceExternalId)  | Should -Be @('ownership:ent-1', 'ownership:ent-2')
        # The second owner arrived as an employee number and is stored as the account.
        @($asg.principalExternalId) | Should -Be @('id-ann', 'id-bob')

        $r.ownership.ownershipsEmitted | Should -Be 2
        $r.ownership.ownersKeyed  | Should -Be 1
        $r.ownership.ownersMapped | Should -Be 1
    }

    It 'keeps ownerId and ownerName in extendedAttributes, owner link or not' {
        foreach ($ownership in @($true, $false)) {
            Reset-SqlTestState
            $script:rowsToReplay = $script:ownerRows   # Reset-SqlTestState clears it
            Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $ownership }) -Connection 'conn' -State (New-OwnerState) | Out-Null
            $ent = (Get-SentRecords 'ingest/resources' @{ resourceType = 'Entitlement' })[0]
            $ent.extendedAttributes.ownerId   | Should -Be 'id-ann'
            $ent.extendedAttributes.ownerName | Should -Be 'Ann'
        }
    }

    It 'sends nothing extra at all when the slot does not ask for owners' {
        $script:rowsToReplay = $script:ownerRows
        $state = New-OwnerState
        $r = Invoke-SqlSlot -Slot (New-ResourceSlot) -Connection 'conn' -State $state
        (Get-SentRecords 'ingest/resources' @{ resourceType = 'ResourceOwnership' }).Count | Should -Be 0
        (Get-SentRecords 'ingest/resource-relationships').Count | Should -Be 0
        (Get-SentRecords 'ingest/resource-assignments').Count | Should -Be 0
        $r.ownership | Should -BeNullOrEmpty
        # …and the run registers no ownership scope, so its reconcile cannot run.
        @($state.Scopes | Where-Object { $_.Scope.resourceType -eq 'ResourceOwnership' }).Count | Should -Be 0
    }

    It 'reports an owner that matches nobody without counting it against the unplaced bound' {
        # The 5% unplaced bound fails a job. An entitlement whose OWNER cannot be
        # found is still a perfectly placed entitlement, so an owner column that
        # resolves for nothing must report loudly and load everything.
        $script:rowsToReplay = @(
            (New-TestRow @{ id = 'ent-1'; displayName = 'A'; ownerId = 'ghost-1' })
            (New-TestRow @{ id = 'ent-2'; displayName = 'B'; ownerId = 'ghost-1' })
            (New-TestRow @{ id = 'ent-3'; displayName = 'C'; ownerId = 'ghost-2' })
        )
        $r = Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $true }) -Connection 'conn' -State (New-OwnerState)
        $r.skipped  | Should -Be 0
        $r.dangling | Should -Be 0
        (Get-SentRecords 'ingest/resources' @{ resourceType = 'Entitlement' }).Count | Should -Be 3
        (Get-SentRecords 'ingest/resource-assignments').Count | Should -Be 0
        $r.ownership.ownersUnresolved     | Should -Be 2
        $r.ownership.ownersUnresolvedRows | Should -Be 3
        (Get-SqlReadVerdict -Read @{ Read = 3; Source = 3; Unplaced = $r.skipped + $r.dangling; Misrouted = 0; Reason = $null }).ok | Should -BeTrue
    }

    It 'leaves the owner link out, but the resource in, when the run read no accounts' {
        $script:rowsToReplay = $script:ownerRows
        $r = Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $true }) -Connection 'conn' -State (New-OwnerState -Accounts @{})
        (Get-SentRecords 'ingest/resources' @{ resourceType = 'Entitlement' }).Count | Should -Be 3
        (Get-SentRecords 'ingest/resource-assignments').Count | Should -Be 0
        $r.ownership.ownersWithoutAccounts | Should -Be 2
        $r.ownership.ownersUnresolved      | Should -Be 0
    }

    It 'registers the owner scopes for the reconcile only once the first owner lands' {
        $script:rowsToReplay = @((New-TestRow @{ id = 'ent-3'; displayName = 'No owner'; ownerId = $null }))
        $state = New-OwnerState
        Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $true }) -Connection 'conn' -State $state | Out-Null
        # A statement that produced no owner must not reconcile the ownership
        # scope, or it would delete every owner a previous run stored.
        @($state.Scopes | Where-Object { $_.Endpoint -eq 'ingest/resource-assignments' }).Count | Should -Be 0
        @($state.Scopes | Where-Object { $_.Scope.relationshipType -eq 'HasOwnership' }).Count | Should -Be 0
    }

    It 'sends the same records on a second identical run, so a repeat deletes and recreates nothing' {
        $shape = {
            Reset-SqlTestState
            $script:rowsToReplay = $script:ownerRows   # Reset-SqlTestState clears it
            $state = New-OwnerState
            Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $true }) -Connection 'conn' -State $state | Out-Null
            return @{
                records = ($script:sent | ForEach-Object { "$($_.Endpoint)|$($_.Body.scope | ConvertTo-Json -Compress)|$($_.Body.records | ConvertTo-Json -Compress -Depth 6)" }) -join "`n"
                scopes  = (@($state.Scopes.Key) | Sort-Object) -join ';'
                modes   = (@($script:sent | ForEach-Object { $_.Body.syncMode }) | Sort-Object -Unique) -join ','
            }
        }
        $first = & $shape
        $second = & $shape
        # Guard against the comparison passing because both runs sent nothing.
        $first.records | Should -Match 'ownership:ent-1'
        $second.records | Should -BeExactly $first.records
        $second.scopes  | Should -BeExactly $first.scopes
        # Every batch is a delta upsert on a deterministic id: the second run
        # updates the same rows in place, and the timestamp reconcile then finds
        # nothing older than the run to remove.
        $second.modes | Should -Be 'delta'
    }

    It 'keeps an owner link in the same system as the resource it is about' {
        $state = New-OwnerState
        # A run that already registered a second connector, the way a `systems`
        # statement leaves the catalogue.
        $state.Systems.ByKey['APP-2'] = 42
        $state.Systems.Names['APP-2'] = 'Payroll'
        $script:rowsToReplay = @((New-TestRow @{ id = 'ent-1'; displayName = 'CRM Reader'; systemId = 'APP-2'; ownerId = 'id-ann' }))
        Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $true }) -Connection 'conn' -State $state | Out-Null
        foreach ($endpoint in @('ingest/resources', 'ingest/resource-relationships', 'ingest/resource-assignments')) {
            @((Get-Sent $endpoint).Body.systemId | Sort-Object -Unique) | Should -Be @(42)
        }
    }

    It 'lets a later statement reference an ownership resource instead of holding it back as dangling' {
        $script:rowsToReplay = @((New-TestRow @{ id = 'ent-1'; displayName = 'CRM Reader'; ownerId = 'id-ann' }))
        $state = New-OwnerState
        Invoke-SqlSlot -Slot (New-ResourceSlot @{ ownership = $true }) -Connection 'conn' -State $state | Out-Null
        $state.KnownResources.ContainsKey('ownership:ent-1') | Should -BeTrue
    }
}
