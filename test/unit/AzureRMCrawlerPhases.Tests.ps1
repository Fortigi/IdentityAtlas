#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the Azure RM crawler sync phases (AzureRMCrawler.Phases.ps1).

.DESCRIPTION
    Each phase mutates a shared $Ctx state object. The ARM/ARG library boundary
    (Invoke-ARMList/Get, Get-ARG*), the Ingest API (Invoke-IngestAPI / Send-IngestBatch)
    and Connect-AzureRM are mocked; the pure shapers (AzureRMCrawler.Transform.ps1) and
    pure helpers (AzureRMCrawler.Functions.ps1) run for real.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:azDir    = Join-Path $script:repoRoot 'tools\crawlers\azure-rm'

    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Get-CapabilityId.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:azDir 'Get-AzureRMHelpers.ps1')   # Connect-AzureRM, Invoke-ARM*
    . (Join-Path $script:azDir 'Get-AzureRGHelpers.ps1')   # Get-ARG*
    . (Join-Path $script:azDir 'AzureRMCrawler.Functions.ps1')
    . (Join-Path $script:azDir 'AzureRMCrawler.Transform.ps1')
    . (Join-Path $script:azDir 'AzureRMCrawler.Phases.ps1')

    $Global:AzCallCount = 0
    $script:ApiKey = 'fgc_test'

    function New-TestConfig {
        param([hashtable]$Over = @{})
        $c = @{
            syncMode = 'full'; includeResourceLevel = $false; includeCustomRoles = $true
            onlyEntraPrincipals = $true; subscriptionFilter = @(); managementGroupId = $null
            tenantId = 'tenant-1'; clientId = 'client-1'; clientSecret = 'secret'
        }
        foreach ($k in $Over.Keys) { $c[$k] = $Over[$k] }
        return $c
    }
    function New-TestCtx {
        param([hashtable]$ConfigOver = @{})
        New-AzureRMState -Config (New-TestConfig -Over $ConfigOver) -SystemId 7
    }
}

Describe 'New-AzureRMState' {
    It 'creates empty accumulators and stores config + systemId' {
        $ctx = New-AzureRMState -Config (New-TestConfig) -SystemId 9
        $ctx.SystemId | Should -Be 9
        $ctx.ScopeResources.Count | Should -Be 0
        $ctx.PrincipalStubs.Keys | Should -Contain 'User'
        $ctx.PrincipalStubs.Keys | Should -Contain 'ServicePrincipal'
    }
}

Describe 'Resolve-AzureRMConfig' {
    It 'applies defaults (custom roles + orphan filter on, full sync)' {
        $p = Join-Path $TestDrive 'cfg1.json'
        '{ "tenantId": "t1", "clientId": "c1", "clientSecret": "s1" }' | Set-Content -Path $p
        $c = Resolve-AzureRMConfig -ConfigPath $p
        $c.syncMode             | Should -Be 'full'
        $c.includeCustomRoles   | Should -BeTrue
        $c.onlyEntraPrincipals  | Should -BeTrue
        $c.includeResourceLevel | Should -BeFalse
        $c.managementGroupId    | Should -BeNullOrEmpty
        $c.tenantId             | Should -Be 't1'
    }
    It 'reads overrides including a subscription filter and MG id' {
        $p = Join-Path $TestDrive 'cfg2.json'
        '{ "_syncMode": "delta", "includeResourceLevel": true, "includeCustomRoles": false, "onlyEntraPrincipals": false, "subscriptionIds": ["a","b"], "managementGroupId": "mg1" }' | Set-Content -Path $p
        $c = Resolve-AzureRMConfig -ConfigPath $p
        $c.syncMode             | Should -Be 'delta'
        $c.includeResourceLevel | Should -BeTrue
        $c.includeCustomRoles   | Should -BeFalse
        $c.onlyEntraPrincipals  | Should -BeFalse
        $c.subscriptionFilter.Count | Should -Be 2
        $c.managementGroupId    | Should -Be 'mg1'
    }
}

Describe 'Register-AzureRMSystem' {
    It 'returns the id from systemIds' {
        Mock Invoke-IngestAPI { @{ systemIds = @(42) } }
        Register-AzureRMSystem -Config (New-TestConfig) | Should -Be 42
    }
    It 'defaults to 1 when no id is returned' {
        Mock Invoke-IngestAPI { @{} }
        Register-AzureRMSystem -Config (New-TestConfig) | Should -Be 1
    }
}

Describe 'Sync-AzureRMScopes' {
    BeforeEach { Mock Update-CrawlerProgress { } }

    It 'discovers subscriptions + resource groups as scope nodes with Contains edges' {
        Mock Invoke-ARMList { @([pscustomobject]@{ subscriptionId = 'sub-1'; displayName = 'Sub One' }) }
        Mock Get-ARGResourceGroups { @([pscustomobject]@{ subscriptionId = 'sub-1'; id = '/subscriptions/sub-1/resourceGroups/rg1'; name = 'rg1' }) }
        Mock Get-ARGResources { @() }
        $ctx = New-TestCtx
        Sync-AzureRMScopes -Ctx $ctx
        $ctx.SubIds | Should -Contain 'sub-1'
        @($ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureSubscription' }).Count | Should -Be 1
        @($ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureResourceGroup' }).Count | Should -Be 1
        $ctx.ContainsEdges.Count | Should -Be 1
    }

    It 'honours the subscription filter' {
        Mock Invoke-ARMList { @(
            [pscustomobject]@{ subscriptionId = 'sub-1'; displayName = 'One' }
            [pscustomobject]@{ subscriptionId = 'sub-2'; displayName = 'Two' }
        ) }
        Mock Get-ARGResourceGroups { @() }
        Mock Get-ARGResources { @() }
        $ctx = New-TestCtx -ConfigOver @{ subscriptionFilter = @('sub-2') }
        Sync-AzureRMScopes -Ctx $ctx
        $ctx.SubIds | Should -Be @('sub-2')
    }

    It 'includes resource-level nodes when configured' {
        Mock Invoke-ARMList { @([pscustomobject]@{ subscriptionId = 'sub-1'; displayName = 'One' }) }
        Mock Get-ARGResourceGroups { @([pscustomobject]@{ subscriptionId = 'sub-1'; id = '/subscriptions/sub-1/resourceGroups/rg1'; name = 'rg1' }) }
        Mock Get-ARGResources { @([pscustomobject]@{ subscriptionId = 'sub-1'; resourceGroup = 'rg1'; id = '/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/sa1'; name = 'sa1' }) }
        $ctx = New-TestCtx -ConfigOver @{ includeResourceLevel = $true }
        Sync-AzureRMScopes -Ctx $ctx
        @($ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureResource' }).Count | Should -Be 1
    }
}

Describe 'Sync-AzureRMRoleDefinitions' {
    BeforeEach { Mock Update-CrawlerProgress { } }

    It 'indexes role definitions by GUID with plane classification' {
        Mock Get-ARGRoleDefinitions { @(
            [pscustomobject]@{ name = 'g1'; properties = [pscustomobject]@{ roleName = 'Owner'; type = 'BuiltInRole'; permissions = @([pscustomobject]@{ actions = @('*'); dataActions = @() }) } }
            [pscustomobject]@{ name = 'g2'; properties = [pscustomobject]@{ roleName = 'Blob Reader'; type = 'BuiltInRole'; permissions = @([pscustomobject]@{ actions = @(); dataActions = @('x/read') }) } }
        ) }
        $ctx = New-TestCtx
        Sync-AzureRMRoleDefinitions -Ctx $ctx
        $ctx.RoleDefs['g1'].name  | Should -Be 'Owner'
        $ctx.RoleDefs['g1'].plane | Should -Be 'control'
        $ctx.RoleDefs['g2'].plane | Should -Be 'data'
    }

    It 'excludes custom roles when includeCustomRoles is false' {
        Mock Get-ARGRoleDefinitions { @(
            [pscustomobject]@{ name = 'g1'; properties = [pscustomobject]@{ roleName = 'Custom'; type = 'CustomRole'; permissions = @() } }
        ) }
        $ctx = New-TestCtx -ConfigOver @{ includeCustomRoles = $false }
        Sync-AzureRMRoleDefinitions -Ctx $ctx
        $ctx.RoleDefs.ContainsKey('g1') | Should -BeFalse
    }
}

Describe 'Ensure-AzureAssignmentScope' {
    It 'creates a resource-group node + ancestor sub edge, tracked in KnownPaths' {
        $ctx = New-TestCtx
        [void]$ctx.KnownPaths.Add('/subscriptions/sub-1')
        $ctx.ScopePaths.Add('/subscriptions/sub-1')
        $rg = '/subscriptions/sub-1/resourceGroups/rg1'
        $id = Ensure-AzureAssignmentScope -Ctx $ctx -ScopePath $rg -OwningSubPath '/subscriptions/sub-1'
        $id | Should -Be (Get-ScopeNodeId -ArmScopePath $rg)
        $ctx.KnownPaths.Contains($rg) | Should -BeTrue
        @($ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureResourceGroup' }).Count | Should -Be 1
        @($ctx.ContainsEdges).Count | Should -BeGreaterThan 0
    }

    It 'links a management group down to the owning subscription' {
        Mock Invoke-ARMGet { @{ properties = @{ displayName = 'Platform MG' } } }
        $ctx = New-TestCtx
        $mg = '/providers/Microsoft.Management/managementGroups/mg1'
        Ensure-AzureAssignmentScope -Ctx $ctx -ScopePath $mg -OwningSubPath '/subscriptions/sub-1' | Out-Null
        @($ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureManagementGroup' }).Count | Should -Be 1
        $edge = $ctx.ContainsEdges | Where-Object { $_.parentResourceId -eq (Get-ScopeNodeId -ArmScopePath $mg) -and $_.childResourceId -eq (Get-ScopeNodeId -ArmScopePath '/subscriptions/sub-1') }
        @($edge).Count | Should -Be 1
    }
}

Describe 'Build-AzureAssignmentsBySub' {
    It 'makes a root assignment visible to every subscription and a sub-scoped one only to its owner' {
        Mock Get-ARGRoleAssignments { @(
            [pscustomobject]@{ name = 'ra-root'; properties = [pscustomobject]@{ scope = '/' } }
            [pscustomobject]@{ name = 'ra-sub1'; properties = [pscustomobject]@{ scope = '/subscriptions/sub-1' } }
        ) }
        Mock Get-ARGSubscriptionMgChains { @{ 'sub-1' = @(); 'sub-2' = @() } }
        $ctx = New-TestCtx
        $ctx.SubIds = @('sub-1', 'sub-2')
        $bySub = Build-AzureAssignmentsBySub -Ctx $ctx
        @($bySub['sub-1']).Count | Should -Be 2   # root + own
        @($bySub['sub-2']).Count | Should -Be 1   # root only
    }

    It 'makes a management-group assignment visible to subscriptions beneath that MG' {
        Mock Get-ARGRoleAssignments { @(
            [pscustomobject]@{ name = 'ra-mg'; properties = [pscustomobject]@{ scope = '/providers/Microsoft.Management/managementGroups/mg1' } }
        ) }
        Mock Get-ARGSubscriptionMgChains { @{ 'sub-1' = @('mg1'); 'sub-2' = @() } }
        $ctx = New-TestCtx
        $ctx.SubIds = @('sub-1', 'sub-2')
        $bySub = Build-AzureAssignmentsBySub -Ctx $ctx
        @($bySub['sub-1']).Count | Should -Be 1
        @($bySub['sub-2']).Count | Should -Be 0
    }
}

Describe 'Sync-AzureRMAssignments' {
    BeforeEach { Mock Update-CrawlerProgress { } }

    It 'builds capability-resources, grants and principal stubs, deduping across subscriptions' {
        Mock Get-ARGSubscriptionMgChains { @{ 'sub-1' = @() } }
        Mock Get-ARGRoleAssignments { @(
            [pscustomobject]@{ name = 'ra1'; properties = [pscustomobject]@{ scope = '/subscriptions/sub-1'; roleDefinitionId = '/x/g1'; principalId = 'u1'; principalType = 'User' } }
            [pscustomobject]@{ name = 'ra1'; properties = [pscustomobject]@{ scope = '/subscriptions/sub-1'; roleDefinitionId = '/x/g1'; principalId = 'u1'; principalType = 'User' } }
        ) }
        $ctx = New-TestCtx
        $ctx.Subs = @([pscustomobject]@{ subscriptionId = 'sub-1' })
        $ctx.SubIds = @('sub-1')
        $ctx.ScopePaths.Add('/subscriptions/sub-1')
        $ctx.RoleDefs['g1'] = @{ name = 'Owner'; isCustom = $false; plane = 'control' }
        Sync-AzureRMAssignments -Ctx $ctx
        $ctx.Grants.Count | Should -Be 1   # duplicate assignment name deduped
        $ctx.RoleResources.Count | Should -Be 1
        $ctx.PrincipalStubs['User'].Count | Should -Be 1
    }

    It 'skips assignments whose role definition was filtered out' {
        Mock Get-ARGSubscriptionMgChains { @{ 'sub-1' = @() } }
        Mock Get-ARGRoleAssignments { @(
            [pscustomobject]@{ name = 'ra1'; properties = [pscustomobject]@{ scope = '/subscriptions/sub-1'; roleDefinitionId = '/x/unknown'; principalId = 'u1'; principalType = 'User' } }
        ) }
        $ctx = New-TestCtx
        $ctx.Subs = @([pscustomobject]@{ subscriptionId = 'sub-1' })
        $ctx.SubIds = @('sub-1')
        $ctx.ScopePaths.Add('/subscriptions/sub-1')
        Sync-AzureRMAssignments -Ctx $ctx
        $ctx.Grants.Count | Should -Be 0
    }
}

Describe 'Optimize-AzureRecords' {
    It 'dedups scope nodes, Contains edges and grants on their primary keys' {
        $ctx = New-TestCtx
        $ctx.ScopeResources.Add(@{ id = 'n1' }); $ctx.ScopeResources.Add(@{ id = 'n1' })
        $ctx.ContainsEdges.Add(@{ parentResourceId = 'a'; childResourceId = 'b'; relationshipType = 'Contains' })
        $ctx.ContainsEdges.Add(@{ parentResourceId = 'a'; childResourceId = 'b'; relationshipType = 'Contains' })
        $ctx.Grants.Add(@{ resourceId = 'r'; principalId = 'p'; assignmentType = 'Direct' })
        $ctx.Grants.Add(@{ resourceId = 'r'; principalId = 'p'; assignmentType = 'Direct' })
        Optimize-AzureRecords -Ctx $ctx
        @($ctx.ScopeResources).Count | Should -Be 1
        @($ctx.ContainsEdges).Count | Should -Be 1
        @($ctx.Grants).Count | Should -Be 1
    }
}

Describe 'Send-AzureScopeRecords' {
    It 'sends one resources batch per resourceType plus the Contains relationships' {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Send-IngestBatch { $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Scope = $Scope }) }
        $ctx = New-TestCtx
        $ctx.ScopeResources = @(@{ id = 'n1'; resourceType = 'AzureSubscription' }, @{ id = 'n2'; resourceType = 'AzureResourceGroup' })
        Send-AzureScopeRecords -Ctx $ctx
        @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/resources' }).Count | Should -Be 2
        @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/resource-relationships' }).Count | Should -Be 1
    }
}

Describe 'Resolve-AzureRMOrphans' {
    It 'skips when no Entra data is loaded yet (grants untouched)' {
        Mock Invoke-IngestAPI { @{ crawlerDataAvailable = $false } }
        $ctx = New-TestCtx
        $ctx.Grants.Add(@{ resourceId = 'r'; principalId = 'p1'; assignmentType = 'Direct' })
        Resolve-AzureRMOrphans -Ctx $ctx
        @($ctx.Grants).Count | Should -Be 1
    }

    It 'drops grants for principals absent from Entra when the filter is ON' {
        Mock Invoke-IngestAPI { @{ crawlerDataAvailable = $true; present = @('p1') } }
        $ctx = New-TestCtx
        $ctx.Grants.Add(@{ resourceId = 'cap1'; principalId = 'p1'; assignmentType = 'Direct' })
        $ctx.Grants.Add(@{ resourceId = 'cap2'; principalId = 'p2'; assignmentType = 'Direct' })
        $ctx.RoleResources.Add(@{ id = 'cap1' }); $ctx.RoleResources.Add(@{ id = 'cap2' })
        $ctx.PrincipalStubs['User'].Add(@{ id = 'p1' }); $ctx.PrincipalStubs['User'].Add(@{ id = 'p2' })
        Resolve-AzureRMOrphans -Ctx $ctx
        @($ctx.Grants).Count | Should -Be 1
        @($ctx.Grants)[0].principalId | Should -Be 'p1'
        @($ctx.RoleResources).Count | Should -Be 1   # cap2 pruned (nobody holds it)
        @($ctx.PrincipalStubs['User']).Count | Should -Be 1
    }

    It 'flags orphan stubs but keeps assignments when the filter is OFF' {
        Mock Invoke-IngestAPI { @{ crawlerDataAvailable = $true; present = @('p1') } }
        $ctx = New-TestCtx -ConfigOver @{ onlyEntraPrincipals = $false }
        $ctx.Grants.Add(@{ resourceId = 'cap2'; principalId = 'p2'; assignmentType = 'Direct' })
        $ctx.PrincipalStubs['User'].Add(@{ id = 'p2' })
        Resolve-AzureRMOrphans -Ctx $ctx
        @($ctx.Grants).Count | Should -Be 1
        $ctx.PrincipalStubs['User'][0].extendedAttributes.directoryStatus | Should -Be 'orphaned'
    }
}

Describe 'Send-AzurePrincipalsAndGrants' {
    It 'sends non-empty principal stubs plus role resources and grants' {
        $script:sent = [System.Collections.Generic.List[object]]::new()
        Mock Send-IngestBatch { $script:sent.Add([pscustomobject]@{ Endpoint = $Endpoint; Scope = $Scope }) }
        $ctx = New-TestCtx
        $ctx.PrincipalStubs['User'].Add(@{ id = 'p1' })
        Send-AzurePrincipalsAndGrants -Ctx $ctx
        @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/principals' -and $_.Scope.principalType -eq 'User' }).Count | Should -Be 1
        @($script:sent | Where-Object { $_.Scope.resourceType -eq 'AzureRoleAssignment' }).Count | Should -Be 1
        @($script:sent | Where-Object { $_.Endpoint -eq 'ingest/resource-assignments' }).Count | Should -Be 1
    }
}

Describe 'Complete-AzureRMRun' {
    It 'refreshes views and does not throw on a non-fatal refresh failure' {
        Mock Update-CrawlerProgress { }
        Mock Invoke-RestMethod { throw 'boom' }
        { Complete-AzureRMRun -ApiBaseUrl 'https://x/api' -ApiKey 'k' } | Should -Not -Throw
    }
}
