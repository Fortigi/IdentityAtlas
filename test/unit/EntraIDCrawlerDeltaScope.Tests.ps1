#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for EntraIDCrawler.DeltaScope.ps1 — which phases a delta
    run of the Entra ID crawler executes.

.USAGE
    Invoke-Pester -Path test/unit/EntraIDCrawlerDeltaScope.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entraDir = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerDeltaToken.ps1')
    # Get-FGDeltaToken (the boundary Test-EntraDeltaBaseline calls).
    . (Join-Path $script:entraDir 'EntraIDCrawler.Functions.ps1')
    # Resolve-EntraSyncConfig — so the tests narrow a config shaped exactly like a real run's.
    . (Join-Path $script:entraDir 'EntraIDCrawler.Phases.ps1')
    # Get-EntraGroupDeltaEndpoint — the group token key the baseline check asks for.
    . (Join-Path $script:entraDir 'EntraIDCrawler.GroupDelta.ps1')
    # The unit under test.
    . (Join-Path $script:entraDir 'EntraIDCrawler.DeltaScope.ps1')

    # Every phase a job config can switch on, so "what survives a delta" is
    # asserted against a config where everything was requested.
    function New-AllPhasesConfig {
        param([string]$SyncMode)
        Resolve-EntraSyncConfig -RawConfig @{
            _syncMode       = $SyncMode
            selectedObjects = @{
                usersGroupsMembers = $true; servicePrincipals = $true; identityGovernance = $true
                pim = $true; signInLogs = $true; oauth2Grants = $true; appsAppRoles = $true
                appOwners = $true; appPermissions = $true; principalRelationships = $true
                directoryRoles = $true; profilePhotos = $true
            }
        }
    }
}

Describe 'Limit-EntraSyncToDeltaPhases' {
    It 'leaves a full run untouched' {
        $cfg = New-AllPhasesConfig -SyncMode 'full'
        $skipped = Limit-EntraSyncToDeltaPhases -Cfg $cfg -HasBaseline $true

        $skipped | Should -BeNullOrEmpty
        $cfg.SyncMode | Should -Be 'full'
        $cfg.SyncAssignments | Should -BeTrue
        $cfg.SyncPim | Should -BeTrue
        $cfg.SyncDirectoryRoles | Should -BeTrue
    }

    It 'keeps only users, service principals, groups + memberships and the view refresh on a delta run' {
        $cfg = New-AllPhasesConfig -SyncMode 'delta'
        Limit-EntraSyncToDeltaPhases -Cfg $cfg -HasBaseline $true | Out-Null

        $cfg.SyncMode | Should -Be 'delta'
        $cfg.RefreshViews | Should -BeTrue
        $stillOn = @($cfg.Keys | Where-Object { $_ -like 'Sync*' -and $_ -ne 'SyncMode' -and $cfg[$_] } | Sort-Object)
        $stillOn | Should -Be @('SyncAssignments', 'SyncPrincipals', 'SyncResources', 'SyncServicePrincipals')
    }

    It 'reports exactly the phases it switched off, not the ones that were already off' {
        # Defaults: Resources, Assignments and Governance on; PIM, app roles etc. off.
        $cfg = Resolve-EntraSyncConfig -RawConfig @{ _syncMode = 'delta' }
        $skipped = Limit-EntraSyncToDeltaPhases -Cfg $cfg -HasBaseline $true

        $skipped | Should -Be @('SyncGovernance')
        $cfg.SyncPim | Should -BeFalse
        $cfg.SyncResources | Should -BeTrue
    }

    It 'switches off a phase toggle it does not know (allow list, not deny list)' {
        $cfg = Resolve-EntraSyncConfig -RawConfig @{ _syncMode = 'delta' }
        $cfg['SyncSomethingNew'] = $true
        $skipped = Limit-EntraSyncToDeltaPhases -Cfg $cfg -HasBaseline $true

        $cfg.SyncSomethingNew | Should -BeFalse
        $skipped | Should -Be @('SyncGovernance', 'SyncSomethingNew')
    }

    It 'does not touch non-phase settings' {
        $cfg = Resolve-EntraSyncConfig -RawConfig @{ _syncMode = 'delta'; signInLogsDays = 14; customGroupAttributes = @('extensionAttribute1') }
        Limit-EntraSyncToDeltaPhases -Cfg $cfg -HasBaseline $true | Out-Null

        $cfg.SignInLogsDays | Should -Be 14
        $cfg.CustomGroupAttributes | Should -Be @('extensionAttribute1')
    }

    It 'promotes a delta run without a baseline to a full run and keeps every phase' {
        $cfg = New-AllPhasesConfig -SyncMode 'delta'
        $skipped = Limit-EntraSyncToDeltaPhases -Cfg $cfg -HasBaseline $false

        $skipped | Should -BeNullOrEmpty
        $cfg.SyncMode | Should -Be 'full'
        $cfg.SyncAssignments | Should -BeTrue
        $cfg.SyncPim | Should -BeTrue
    }
}

Describe 'Test-EntraDeltaBaseline' {
    It 'is true when the users delta token exists' {
        Mock Get-FGDeltaToken { if ($Endpoint -eq 'users/delta') { 'tok-users' } }
        $cfg = @{ SyncPrincipals = $true; SyncServicePrincipals = $false }

        Test-EntraDeltaBaseline -Cfg $cfg -SystemId 42 | Should -BeTrue
        Should -Invoke Get-FGDeltaToken -Exactly -Times 1 -ParameterFilter { $SystemId -eq 42 -and $Endpoint -eq 'users/delta' }
    }

    It 'falls back to the service-principal token when users have none' {
        Mock Get-FGDeltaToken { if ($Endpoint -eq 'servicePrincipals/delta') { 'tok-sps' } }
        $cfg = @{ SyncPrincipals = $true; SyncServicePrincipals = $true }

        Test-EntraDeltaBaseline -Cfg $cfg -SystemId 7 | Should -BeTrue
    }

    It 'ignores the token of a phase that is switched off' {
        Mock Get-FGDeltaToken { if ($Endpoint -eq 'servicePrincipals/delta') { 'tok-sps' } }
        $cfg = @{ SyncPrincipals = $true; SyncServicePrincipals = $false }

        Test-EntraDeltaBaseline -Cfg $cfg -SystemId 7 | Should -BeFalse
        Should -Invoke Get-FGDeltaToken -Exactly -Times 0 -ParameterFilter { $Endpoint -eq 'servicePrincipals/delta' }
    }

    It 'is false without any delta-capable phase enabled, and asks nothing' {
        Mock Get-FGDeltaToken { 'tok' }
        $cfg = @{ SyncPrincipals = $false; SyncServicePrincipals = $false; SyncResources = $false }

        Test-EntraDeltaBaseline -Cfg $cfg -SystemId 7 | Should -BeFalse
        Should -Invoke Get-FGDeltaToken -Exactly -Times 0
    }

    It 'counts a group token as a baseline, keyed on whether memberships are read' {
        Mock Get-FGDeltaToken { if ($Endpoint -eq 'groups/delta/members-owners') { 'tok-groups' } }

        Test-EntraDeltaBaseline -Cfg @{ SyncResources = $true; SyncAssignments = $true } -SystemId 7 | Should -BeTrue
        # A groups-only token is a different query shape — the members token does not count for it.
        Test-EntraDeltaBaseline -Cfg @{ SyncResources = $true; SyncAssignments = $false } -SystemId 7 | Should -BeFalse
    }
}

Describe 'Get-EntraDeltaEndpoints' {
    It 'lists the endpoint of every enabled delta-capable phase, in order' {
        Get-EntraDeltaEndpoints -Cfg @{ SyncPrincipals = $true; SyncServicePrincipals = $true; SyncResources = $true; SyncAssignments = $true } |
            Should -Be @('users/delta', 'servicePrincipals/delta', 'groups/delta/members-owners')
        Get-EntraDeltaEndpoints -Cfg @{ SyncResources = $true } | Should -Be @('groups/delta')
        @(Get-EntraDeltaEndpoints -Cfg @{ SyncAssignments = $true }).Count | Should -Be 0
    }
}
