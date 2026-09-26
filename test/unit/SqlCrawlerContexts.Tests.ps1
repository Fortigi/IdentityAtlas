#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for tools/crawlers/sql/SqlCrawler.Contexts.ps1 and the
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
        @('sql', 'SqlCrawler.Functions.ps1'), @('sql', 'SqlCrawler.Transform.ps1'), @('sql', 'SqlCrawler.Contexts.ps1'), @('sql', 'SqlCrawler.Phases.ps1'), @('sql', 'SqlCrawler.Verify.ps1'))) {
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
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $state | Should -Be 4
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

    It 'a delta run upserts without removing, and an empty buffer sends nothing at all' {
        $state = New-Catalogued -Mode 'delta'
        Send-SqlContextBuffer -Slot (Get-Slot 'contexts') -State $state | Out-Null
        $calls[0].Body.syncMode | Should -Be 'delta'
        Send-SqlContextBuffer -Slot (Get-Slot 'context-members') -State $state | Should -Be 0
        @($calls).Count | Should -Be 1 -Because 'an empty full sync would wipe every membership of the system'
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
        $t.sent | Should -Be 1
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
