#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/mssql/SqlCrawler.Contexts.ps1 and the
    contexts / context-members targets it adds to the SQL crawler.

.DESCRIPTION
    The inputs are chosen to discriminate: names that differ ONLY by case or a
    trailing space (the drift a case-insensitive source collation hides), a
    Turkish current culture (where ToLower and ToLowerInvariant disagree on "I"),
    two catalogue rows folding to one name, and a member naming an application
    the catalogue does not have.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerContexts.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:ApiBaseUrl = 'http://localhost:3001/api'; $script:ApiKey = 'fgc_test'; $script:JobId = 0
    foreach ($f in @(
        @('shared', 'Invoke-CrawlerIngest.ps1'), @('shared', 'Invoke-CrawlerIngestStream.ps1'), @('shared', 'Get-CrawlerSystemName.ps1'),
        @('mssql', 'SqlCrawler.Functions.ps1'), @('mssql', 'SqlCrawler.Transform.ps1'), @('mssql', 'SqlCrawler.Contexts.ps1'), @('mssql', 'SqlCrawler.Phases.ps1'), @('mssql', 'SqlCrawler.Verify.ps1'))) {
        . (Join-Path $root 'tools' 'crawlers' $f[0] $f[1])
    }

    # A normalised slot, the way Resolve-SqlQuerySlot returns it.
    function Get-Slot([string]$Target, [hashtable]$Over = @{}) {
        $raw = @{ name = $Target; target = $Target; sql = 'SELECT 1'; resourceType = 'Entitlement'; contextType = 'Application' }
        foreach ($k in $Over.Keys) { $raw[$k] = $Over[$k] }
        Resolve-SqlQuerySlot -Slot $raw
    }
    function Get-Row([hashtable]$Cells) { $o = [ordered]@{}; foreach ($k in ($Cells.Keys | Sort-Object)) { $o[$k] = $Cells[$k] }; $o }
    # Feed rows through a slot's real row handler with its real column map.
    function Invoke-Rows([hashtable]$Slot, [hashtable]$State, [object[]]$Rows) {
        $ctx = @{ Slot = $Slot; State = $State; Map = $null; Skipped = 0; Dangling = 0; Unresolved = 0 }
        foreach ($r in $Rows) {
            if (-not $ctx.Map) { $ctx.Map = Resolve-SqlColumnMap -Columns @($r.Keys) -Target $Slot.target -ColumnMap $Slot.columnMap }
            & (Get-SqlRowHandler -Target $Slot.target) $r $ctx
        }
        return $ctx
    }
    function New-State([string]$Mode = 'full', [string[]]$Resources = @()) {
        $s = New-SqlRunState -SystemId 9 -ServerTime '2026-09-26T00:00:00Z' -Slots @() -BatchSize 1000 -SyncMode $Mode
        foreach ($r in $Resources) { [void]$s.KnownResources.Add($r) }
        $s.HasResources = $Resources.Count -gt 0
        return $s
    }
    # A run that has already read accounts, the way a principals slot leaves it:
    # keyed on the directory's id, indexed by employee number.
    function Add-KnownPrincipal([hashtable]$State, [string]$Key, [string]$EmployeeId) {
        $State.HasPrincipals = $true
        [void]$State.KnownPrincipals.Add($Key)
        Register-SqlPrincipalAlias -Record ([ordered]@{ externalId = $Key; employeeId = $EmployeeId }) -State $State
    }
    # The catalogue used throughout: one entry keyed by a CMDB reference, one keyed
    # by its name, and two that fold to the same name.
    function New-Catalogued([string]$Mode = 'full', [string[]]$Resources = @('e1', 'e2', 'e3', 'e4', 'e5')) {
        $state = New-State $Mode $Resources
        Invoke-Rows (Get-Slot 'contexts' @{ columnMap = @{ cmdb = 'id'; name = 'displayName'; owner = 'ownerUserId' } }) $state @(
            (Get-Row @{ cmdb = 'CI001'; name = 'Finance'; owner = '1001'; abbreviation = 'FIN' })
            (Get-Row @{ cmdb = $null; name = 'Payroll Portal'; owner = $null; abbreviation = 'PAY' })
            (Get-Row @{ cmdb = 'CI003'; name = 'Twin'; owner = $null; abbreviation = 'T1' })
            (Get-Row @{ cmdb = 'CI004'; name = 'twin '; owner = $null; abbreviation = 'T2' })
        ) | Out-Null
        return $state
    }
}

Describe 'ConvertTo-SqlContextName' {
    It 'trims and folds case, so drifted spellings of one name meet' {
        ConvertTo-SqlContextName '  Finance ' | Should -BeExactly 'finance'
        ConvertTo-SqlContextName 'FINANCE' | Should -BeExactly (ConvertTo-SqlContextName 'finance ')
        ConvertTo-SqlContextName $null | Should -BeExactly ''
    }

    It 'folds with the invariant culture, so a Turkish locale cannot split a name in two' {
        $before = [System.Globalization.CultureInfo]::CurrentCulture
        try {
            [System.Globalization.CultureInfo]::CurrentCulture = [System.Globalization.CultureInfo]::new('tr-TR')
            # Under tr-TR, 'INVOICING'.ToLower() is 'ınvoıcıng' (dotless ı), which
            # would no longer match 'invoicing'.
            ConvertTo-SqlContextName 'INVOICING' | Should -BeExactly 'invoicing'
            ConvertTo-SqlContextName 'INVOICING' | Should -BeExactly (ConvertTo-SqlContextName 'invoicing')
        } finally { [System.Globalization.CultureInfo]::CurrentCulture = $before }
    }
}

Describe 'the catalogue (contexts target)' {
    BeforeAll {
        # The columns arrive under the operator's own names, mapped to the contract.
        $script:map = @{ cmdb = 'id'; name = 'displayName'; owner = 'ownerUserId' }
    }

    It 'keys a context by its id column, else by its normalised name, and keeps the source display name' {
        $state = New-State
        $slot = Get-Slot 'contexts' @{ columnMap = $script:map; targetType = 'Resource' }
        $ctx = Invoke-Rows $slot $state @(
            (Get-Row @{ cmdb = 'CI001'; name = 'Finance '; owner = '1001' })
            (Get-Row @{ cmdb = ''; name = 'Payroll Portal'; owner = $null })
        )
        $recs = $state.Contexts.Records
        $recs[0].externalId | Should -BeExactly 'CI001'
        $recs[0].displayName | Should -BeExactly 'Finance ' -Because 'the canonical key must not leak into what users see'
        $recs[0].ownerUserId | Should -BeExactly '1001'
        $recs[1].externalId | Should -BeExactly 'payroll portal'
        $recs[1].Contains('ownerUserId') | Should -BeFalse
        $recs[0].contextType | Should -BeExactly 'Application'
        $recs[0].targetType | Should -BeExactly 'Resource'
        $recs[0].variant | Should -BeExactly 'synced'
        $ctx.Skipped | Should -Be 0
    }

    It 'counts a repeated key and keeps the first; skips a row with no name' {
        $state = New-State
        $ctx = Invoke-Rows (Get-Slot 'contexts' @{ columnMap = $script:map }) $state @(
            (Get-Row @{ cmdb = 'CI1'; name = 'First'; owner = $null })
            (Get-Row @{ cmdb = 'CI1'; name = 'Second'; owner = $null })
            (Get-Row @{ cmdb = 'CI2'; name = '  '; owner = $null })
        )
        @($state.Contexts.Records).Count | Should -Be 1
        $state.Contexts.Records[0].displayName | Should -BeExactly 'First'
        @($state.Contexts.Duplicates) | Should -Be @('CI1')
        $ctx.Skipped | Should -Be 2
    }
}

Describe 'Resolve-SqlContextOwner' {
    # The real defect: IdentityIQ's application catalogue names the owner by
    # employee number (spt_identity.name) while every account is keyed on the
    # identity id (spt_identity.id). The values below are chosen to tell the two
    # apart — an id that is not an employee number, an employee number that is
    # not an id, and a third value that is neither.
    BeforeEach {
        $script:state = New-State
        Add-KnownPrincipal $script:state '8a8080f1-id-4711' '10000737'
        Add-KnownPrincipal $script:state '8a8080f1-id-9002' '10000901'
        $script:cat = $script:state.Contexts
    }

    It 'turns an employee number into the account key the principal is stored under' {
        Resolve-SqlContextOwner -Catalog $cat -Owner '10000737' -State $state | Should -BeExactly '8a8080f1-id-4711'
        Resolve-SqlContextOwner -Catalog $cat -Owner ' 10000901 ' -State $state | Should -BeExactly '8a8080f1-id-9002'
        $cat.OwnerMapped | Should -Be 2
        $cat.OwnerDirect | Should -Be 0
        $cat.OwnerUnresolved.Count | Should -Be 0
    }

    It 'leaves an owner that already names an account alone' {
        Resolve-SqlContextOwner -Catalog $cat -Owner '8a8080f1-id-4711' -State $state | Should -BeExactly '8a8080f1-id-4711'
        $cat.OwnerDirect | Should -Be 1
        $cat.OwnerMapped | Should -Be 0
    }

    It 'keeps an owner that matches nothing, exactly as the source spells it, and counts it' {
        Resolve-SqlContextOwner -Catalog $cat -Owner '99999999' -State $state | Should -BeExactly '99999999'
        Resolve-SqlContextOwner -Catalog $cat -Owner '99999999' -State $state | Should -BeExactly '99999999'
        Resolve-SqlContextOwner -Catalog $cat -Owner 'ghost@example.test' -State $state | Should -BeExactly 'ghost@example.test'
        $cat.OwnerUnresolved['99999999'] | Should -Be 2
        $cat.OwnerUnresolved.Count | Should -Be 2
        $cat.OwnerMapped | Should -Be 0
    }

    It 'keeps the first account when two share an employee number, rather than flapping between them' {
        Add-KnownPrincipal $state '8a8080f1-id-zzzz' '10000737'
        Resolve-SqlContextOwner -Catalog $cat -Owner '10000737' -State $state | Should -BeExactly '8a8080f1-id-4711'
    }

    It 'passes the owner through untouched, and counts nothing, when the run read no accounts' {
        $bare = New-State
        Resolve-SqlContextOwner -Catalog $bare.Contexts -Owner '10000737' -State $bare | Should -BeExactly '10000737'
        Resolve-SqlContextOwner -Catalog $bare.Contexts -Owner '10000737' | Should -BeExactly '10000737'
        $bare.Contexts.OwnerUnresolved.Count | Should -Be 0 -Because 'unresolved must mean "we looked and found nobody", not "we did not look"'
    }

    It 'resolves the owner as the catalogue is read, so the record carries the account key' {
        $slot = Get-Slot 'contexts' @{ columnMap = @{ cmdb = 'id'; name = 'displayName'; owner = 'ownerUserId' } }
        Invoke-Rows $slot $state @(
            (Get-Row @{ cmdb = 'CI001'; name = 'Finance'; owner = '10000737' })
            (Get-Row @{ cmdb = 'CI002'; name = 'Payroll'; owner = '99999999' })
            (Get-Row @{ cmdb = 'CI003'; name = 'Ledger'; owner = '' })
        ) | Out-Null
        $recs = $state.Contexts.Records
        $recs[0].ownerUserId | Should -BeExactly '8a8080f1-id-4711'
        $recs[1].ownerUserId | Should -BeExactly '99999999'
        $recs[2].Contains('ownerUserId') | Should -BeFalse
        (Get-SqlContextReport -Catalog $state.Contexts).ownersUnresolvedRows | Should -Be 1
    }
}

Describe 'Register-SqlPrincipalAlias' {
    It 'indexes an account by its employee number and ignores one without' {
        $s = New-State
        Register-SqlPrincipalAlias -Record ([ordered]@{ externalId = 'k1'; employeeId = ' 1001 ' }) -State $s
        Register-SqlPrincipalAlias -Record ([ordered]@{ externalId = 'k2' }) -State $s
        Register-SqlPrincipalAlias -Record ([ordered]@{ externalId = 'k3'; employeeId = '' }) -State $s
        $s.PrincipalsByEmployeeId.Count | Should -Be 1
        $s.PrincipalsByEmployeeId['1001'] | Should -BeExactly 'k1'
    }
}

Describe 'Resolve-SqlContextReference' {
    BeforeEach {
        $script:state = New-State
        Invoke-Rows (Get-Slot 'contexts' @{ columnMap = @{ cmdb = 'id'; name = 'displayName' } }) $script:state @(
            (Get-Row @{ cmdb = 'CI001'; name = 'Finance' })
            (Get-Row @{ cmdb = ''; name = 'Payroll Portal' })
            (Get-Row @{ cmdb = 'CI003'; name = 'Twin' })
            (Get-Row @{ cmdb = 'CI004'; name = 'twin ' })
        ) | Out-Null
        $script:cat = $script:state.Contexts
    }

    It 'resolves an exact name without recording a fold' {
        Resolve-SqlContextReference -Catalog $cat -ContextName 'Finance' | Should -BeExactly 'CI001'
        $cat.Folded.Count | Should -Be 0
    }

    It 'resolves a spelling that differs only by case or spaces, and records it as folded' {
        Resolve-SqlContextReference -Catalog $cat -ContextName 'FINANCE' | Should -BeExactly 'CI001'
        Resolve-SqlContextReference -Catalog $cat -ContextName 'finance ' | Should -BeExactly 'CI001'
        $cat.Folded['CI001'].Count | Should -Be 2
        $cat.Folded['CI001'].Contains('FINANCE') | Should -BeTrue
        $cat.Folded['CI001'].Contains('finance ') | Should -BeTrue
    }

    It 'resolves by id before name, and an unknown id is unresolved rather than matched by name' {
        Resolve-SqlContextReference -Catalog $cat -ContextId ' CI001 ' -ContextName 'Payroll Portal' | Should -BeExactly 'CI001'
        Resolve-SqlContextReference -Catalog $cat -ContextId 'CI999' -ContextName 'Finance' | Should -BeNullOrEmpty
        $cat.Unresolved['CI999'] | Should -Be 1
    }

    It 'refuses a name the catalogue does not have, and one that two entries fold to' {
        Resolve-SqlContextReference -Catalog $cat -ContextName 'Ghost App' | Should -BeNullOrEmpty
        Resolve-SqlContextReference -Catalog $cat -ContextName 'Ghost App' | Should -BeNullOrEmpty
        Resolve-SqlContextReference -Catalog $cat -ContextName 'TWIN' | Should -BeNullOrEmpty
        $cat.Unresolved['Ghost App'] | Should -Be 2
        $cat.Unresolved['TWIN'] | Should -Be 1
        $cat.Ambiguous | Should -Contain 'twin'
    }
}

Describe 'memberships (context-members target)' {
    BeforeEach {
        $script:state = New-State -Resources @('e1', 'e2', 'e3', 'e4')
        Invoke-Rows (Get-Slot 'contexts' @{ columnMap = @{ cmdb = 'id'; name = 'displayName' } }) $script:state @(
            (Get-Row @{ cmdb = 'CI001'; name = 'Finance' })
            (Get-Row @{ cmdb = ''; name = 'Payroll Portal' })
        ) | Out-Null
        $script:slot = Get-Slot 'context-members' @{ columnMap = @{ EntitlementID = 'memberId'; LogicalApplication = 'contextName' } }
    }

    It 'places each resource in its context, drops only the membership of an unknown one, and never invents it' {
        $ctx = Invoke-Rows $slot $state @(
            (Get-Row @{ EntitlementID = 'e1'; LogicalApplication = 'Finance' })
            (Get-Row @{ EntitlementID = 'e2'; LogicalApplication = 'finance ' })
            (Get-Row @{ EntitlementID = 'e3'; LogicalApplication = 'Ghost App' })
            (Get-Row @{ EntitlementID = 'e4'; LogicalApplication = 'PAYROLL PORTAL' })
        )
        $m = $state.Contexts.Members
        @($m | ForEach-Object { "$($_.contextExternalId)=$($_.memberExternalId)" }) | Should -Be @('CI001=e1', 'CI001=e2', 'payroll portal=e4')
        @($m.memberType | Select-Object -Unique) | Should -Be @('Resource')
        $ctx.Unresolved | Should -Be 1
        @($state.Contexts.Records.externalId) | Should -Not -Contain 'ghost app'
    }

    It 'skips a row naming no context or no member, counts an unknown resource as dangling, and collapses repeats' {
        $ctx = Invoke-Rows $slot $state @(
            (Get-Row @{ EntitlementID = 'e1'; LogicalApplication = $null })
            (Get-Row @{ EntitlementID = ''; LogicalApplication = 'Finance' })
            (Get-Row @{ EntitlementID = 'zz'; LogicalApplication = 'Finance' })
            (Get-Row @{ EntitlementID = 'e2'; LogicalApplication = 'Finance' })
            (Get-Row @{ EntitlementID = 'e2'; LogicalApplication = 'FINANCE' })
        )
        $ctx.Skipped | Should -Be 2
        $ctx.Dangling | Should -Be 1
        $ctx.Unresolved | Should -Be 0
        @($state.Contexts.Members).Count | Should -Be 1
    }
}

Describe 'Get-SqlContextReport' {
    It 'reports folded spellings, unresolved names with counts, ambiguous names and duplicate keys' {
        $state = New-Catalogued
        $state.Contexts.Duplicates.Add('CI001')
        $slot = Get-Slot 'context-members' @{ columnMap = @{ id = 'memberId'; app = 'contextName' } }
        Invoke-Rows $slot $state @(
            (Get-Row @{ id = 'e1'; app = 'FINANCE' })
            (Get-Row @{ id = 'e2'; app = 'Ghost' })
            (Get-Row @{ id = 'e3'; app = 'Ghost' })
            (Get-Row @{ id = 'e4'; app = 'Other Ghost' })
            (Get-Row @{ id = 'e5'; app = 'Twin' })
        ) | Out-Null
        $r = Get-SqlContextReport -Catalog $state.Contexts
        $r.contexts | Should -Be 4
        $r.members | Should -Be 1
        $r.foldedSpellings | Should -Be 1
        $r.foldedSample | Should -Be @("'FINANCE' -> 'Finance'")
        $r.unresolvedNames | Should -Be 3
        $r.unresolvedMembers | Should -Be 4
        $r.unresolvedSample[0] | Should -BeExactly "'Ghost' (2)" -Because 'the most frequent orphan name is listed first'
        $r.ambiguousNames | Should -Be @('twin')
        $r.duplicateKeyCount | Should -Be 1
    }
}

Describe 'Send-SqlContextBuffer' {
    BeforeEach {
        $script:calls = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $script:calls.Add([pscustomobject]@{ Endpoint = $Endpoint; Body = $Body }); @{ inserted = @($Body.records).Count; updated = 0; deleted = 0 } }
    }

    It 'sends the catalogue as a synced full sync in the crawler namespace, and the members after it' {
        $state = New-Catalogued
        Invoke-Rows (Get-Slot 'context-members' @{ columnMap = @{ id = 'memberId'; app = 'contextName' } }) $state @(
            (Get-Row @{ id = 'e1'; app = 'Finance' })) | Out-Null
        # 4 catalogue entries + the one root they hang under.
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $state | Should -Be 5
        Send-SqlContextBuffer -Slot (Get-Slot 'context-members') -State $state | Should -Be 1
        $calls[0].Endpoint | Should -Be 'ingest/contexts'
        $calls[0].Body.syncMode | Should -Be 'full'
        $calls[0].Body.scope.variant | Should -Be 'synced'
        $calls[0].Body.idPrefix | Should -Be 'sql-9-contexts'
        $calls[1].Endpoint | Should -Be 'ingest/context-members'
        $calls[1].Body.idPrefix | Should -Be 'sql-9-context-members'
        @($calls[1].Body.records)[0].contextExternalId | Should -Be 'CI001'
        $state.ContextReport.members | Should -Be 1
    }

    # Contexts are shared by every crawler. Unstamped and scoped by variant alone,
    # a full sync removed other systems' catalogues and every membership outside
    # its own batch; the stamp is what lets the ingest bound it to this system.
    It 'stamps every context as owned by this system and scopes the sync to it and the context type' {
        $state = New-Catalogued
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $state | Out-Null
        @($calls[0].Body.records).Count | Should -Be 5
        @($calls[0].Body.records | Where-Object { $_.scopeSystemId -ne 9 }).Count | Should -Be 0 -Because 'the root has to be owned exactly like its children or the next sync removes it'
        $calls[0].Body.scope.scopeSystemId | Should -Be 9
        $calls[0].Body.scope.contextType | Should -Be (Get-Slot 'contexts').contextType
    }

    It 'a delta run upserts without removing, and an empty buffer sends nothing at all' {
        $state = New-Catalogued -Mode 'delta'
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $state | Out-Null
        $calls[0].Body.syncMode | Should -Be 'delta'
        Send-SqlContextBuffer -Slot (Get-Slot 'context-members') -State $state | Should -Be 0
        @($calls).Count | Should -Be 1 -Because 'an empty full sync would wipe every membership of the system'
    }
}

Describe 'the catalogue root' {
    BeforeEach {
        $script:calls = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-IngestAPI { $script:calls.Add([pscustomobject]@{ Endpoint = $Endpoint; Body = $Body }); @{ inserted = @($Body.records).Count; updated = 0; deleted = 0 } }
    }

    It 'names the root after the slot, else after the context type, pluralised' {
        Get-SqlContextRootName -Slot (Get-Slot 'contexts' @{ contextType = 'LogicalApplication'; rootDisplayName = ' Logical Applications ' }) | Should -BeExactly 'Logical Applications'
        Get-SqlContextRootName -Slot (Get-Slot 'contexts' @{ contextType = 'LogicalApplication' }) | Should -BeExactly 'Logical Applications'
        ConvertTo-SqlPluralLabel 'BusinessProcess' | Should -BeExactly 'Business Processes'
        ConvertTo-SqlPluralLabel 'Category'        | Should -BeExactly 'Categories'
        ConvertTo-SqlPluralLabel 'Application'     | Should -BeExactly 'Applications'
        ConvertTo-SqlPluralLabel ''                | Should -BeExactly 'Contexts'
    }

    It 'sends one root first and parents every catalogue entry to it' {
        $state = New-Catalogued
        $slot = Get-Slot 'contexts' @{ rootDisplayName = 'Logical Applications' }
        Send-SqlContextBuffer -Slot $slot -State $state | Should -Be 5
        $sent = @($calls[0].Body.records)
        $sent[0].externalId | Should -BeExactly 'root:Application'
        $sent[0].displayName | Should -BeExactly 'Logical Applications'
        $sent[0].Contains('parentExternalId') | Should -BeFalse
        $sent[0].contextType | Should -BeExactly $slot.contextType -Because 'a root outside the reconcile scope is never refreshed'
        $sent[0].targetType | Should -BeExactly $slot.targetType
        $sent[0].variant | Should -BeExactly 'synced'
        @($sent | Select-Object -Skip 1 | Where-Object { $_.parentExternalId -ne 'root:Application' }).Count | Should -Be 0
    }

    # The trap the handover called out: the reconcile only removes contexts the
    # system owns, bounded by (variant, contextType, scopeSystemId). A second
    # identical run must send the same root, under the same key, inside the same
    # scope — otherwise the sync that follows deletes it and orphans the tree.
    It 'a second identical run sends exactly one root, the same one, in the same scope' {
        $first = New-Catalogued
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $first | Out-Null
        $second = New-Catalogued
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $second | Out-Null

        $a = @($calls[0].Body.records); $b = @($calls[1].Body.records)
        @($a | Where-Object { -not $_.Contains('parentExternalId') }).Count | Should -Be 1
        @($b | Where-Object { -not $_.Contains('parentExternalId') }).Count | Should -Be 1
        $b[0].externalId | Should -BeExactly $a[0].externalId -Because 'a new key each run would leave the old root behind'
        @($b.externalId) | Should -Be @($a.externalId)
        # Same deterministic namespace and the same scope, so the second run
        # upserts the first run's rows instead of deleting them.
        $calls[1].Body.idPrefix | Should -Be $calls[0].Body.idPrefix
        $calls[1].Body.scope.contextType | Should -Be $calls[0].Body.scope.contextType
        $calls[1].Body.scope.scopeSystemId | Should -Be $calls[0].Body.scope.scopeSystemId
        $b[0].scopeSystemId | Should -Be 9
    }

    It 'makes no root for an empty catalogue, so an empty full sync still sends nothing' {
        $state = New-State
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $state | Should -Be 0
        @($calls).Count | Should -Be 0 -Because 'a batch of nothing but a root would reconcile away every context the last run wrote'
    }

    It 'leaves a catalogue that already uses the root key flat rather than overwriting the entry' {
        $state = New-State
        Invoke-Rows (Get-Slot 'contexts' @{ columnMap = @{ cmdb = 'id'; name = 'displayName' } }) $state @(
            (Get-Row @{ cmdb = 'root:Application'; name = 'A real application that happens to be keyed like the root' })
        ) | Out-Null
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $state | Should -Be 1
        $sent = @($calls[0].Body.records)
        $sent[0].displayName | Should -BeExactly 'A real application that happens to be keyed like the root'
        $sent[0].Contains('parentExternalId') | Should -BeFalse
    }
}

Describe 'contexts in the run' {
    It 'orders contexts after resources and memberships after contexts' {
        $slots = @((Get-Slot 'context-members'), (Get-Slot 'assignments'), (Get-Slot 'contexts'), (Get-Slot 'resources'))
        @((Get-SqlSlotsInOrder -Slots $slots).target) | Should -Be @('resources', 'contexts', 'context-members', 'assignments')
    }

    It 'streams nothing for a buffered target and sends it when the slot ends' {
        Mock Invoke-IngestAPI { @{ inserted = @($Body.records).Count; updated = 0; deleted = 0 } }
        Mock Update-CrawlerProgress { }
        Mock Invoke-SqlQueryStream { & $OnRow (Get-Row @{ id = 'CI1'; displayName = 'Finance' }); [long]1 }
        $state = New-State
        (New-SqlSlotStreams -Slot (Get-Slot 'contexts') -State $state).Count | Should -Be 0
        $t = Invoke-SqlSlot -Slot (Get-Slot 'contexts') -Connection 'c' -State $state
        $t.sent | Should -Be 2 -Because 'the one catalogue row goes up with the root it hangs under'
        $t.unresolved | Should -Be 0
        Should -Invoke Invoke-IngestAPI -Times 1 -Exactly -ParameterFilter { $Endpoint -eq 'ingest/contexts' }
    }
}

Describe 'context slot configuration' {
    It 'requires a contextType on a contexts query and defaults the member type to the target type' {
        { Resolve-SqlQuerySlot -Slot @{ name = 'c'; target = 'contexts'; sql = 'SELECT 1' } } | Should -Throw '*needs a contextType*'
        (Get-Slot 'context-members' @{ targetType = 'Identity' }).memberType | Should -Be 'Identity'
        (Get-Slot 'contexts').targetType | Should -Be 'Resource'
        { Get-Slot 'contexts' @{ targetType = 'Group' } } | Should -Throw "*targetType 'Group'*"
    }

    It 'allows one catalogue and one membership query, and memberships only with a catalogue' {
        { Assert-SqlContextSlots -Slots @((Get-Slot 'contexts'), (Get-Slot 'contexts')) } | Should -Throw "*Only one enabled 'contexts'*"
        { Assert-SqlContextSlots -Slots @((Get-Slot 'context-members')) } | Should -Throw '*needs an enabled*'
        { Assert-SqlContextSlots -Slots @((Get-Slot 'contexts'), (Get-Slot 'contexts' @{ enabled = $false }), (Get-Slot 'context-members')) } | Should -Not -Throw
    }
}
