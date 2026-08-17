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

Describe 'Connect-AzureRMSession' {
    It 'authenticates with the tenant/client/secret from config' {
        Mock Connect-AzureRM { }
        Connect-AzureRMSession -Config (New-TestConfig -Over @{ tenantId = 't9'; clientId = 'c9'; clientSecret = 's9' })
        Should -Invoke Connect-AzureRM -Exactly 1 -ParameterFilter { $TenantId -eq 't9' -and $ClientId -eq 'c9' -and $ClientSecret -eq 's9' }
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

    It 'includes resource-level nodes (with lifted tag attributes) when configured' {
        Mock Invoke-ARMList { @([pscustomobject]@{ subscriptionId = 'sub-1'; displayName = 'One' }) }
        Mock Get-ARGResourceGroups { @([pscustomobject]@{ subscriptionId = 'sub-1'; id = '/subscriptions/sub-1/resourceGroups/rg1'; name = 'rg1' }) }
        Mock Get-ARGResources { @([pscustomobject]@{ subscriptionId = 'sub-1'; resourceGroup = 'rg1'; id = '/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/sa1'; name = 'sa1'; location = 'westeurope'; tags = [pscustomobject]@{ Prio = 'High' } }) }
        $ctx = New-TestCtx -ConfigOver @{ includeResourceLevel = $true }
        Sync-AzureRMScopes -Ctx $ctx
        $res = $ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureResource' }
        @($res).Count | Should -Be 1
        $res.extendedAttributes.azureLocation | Should -Be 'westeurope'   # ExtraExt merged
        $res.extendedAttributes.'tag.Prio'    | Should -Be 'High'
    }

    It 'walks the management-group tree and links MGs down to already-discovered subscriptions' {
        Mock Invoke-ARMList { @([pscustomobject]@{ subscriptionId = 'sub-1'; displayName = 'One' }) }
        Mock Get-ARGResourceGroups { @() }
        Mock Get-ARGResources { @() }
        Mock Invoke-ARMGet {
            @{ id = '/providers/Microsoft.Management/managementGroups/mg1'; name = 'mg1'; type = 'Microsoft.Management/managementGroups'
               properties = @{ displayName = 'Root MG'; children = @(
                   @{ id = '/providers/Microsoft.Management/managementGroups/mg2'; name = 'mg2'; type = 'Microsoft.Management/managementGroups'; properties = @{ displayName = 'Child MG'; children = @() } }
                   @{ id = '/subscriptions/sub-1'; name = 'sub-1'; type = '/subscriptions'; properties = @{} }
               ) } }
        }
        $ctx = New-TestCtx -ConfigOver @{ managementGroupId = 'mg1' }
        Sync-AzureRMScopes -Ctx $ctx
        @($ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureManagementGroup' }).Count | Should -Be 2
        $edge = $ctx.ContainsEdges | Where-Object { $_.parentResourceId -eq (Get-ScopeNodeId -ArmScopePath '/providers/Microsoft.Management/managementGroups/mg1') -and $_.childResourceId -eq (Get-ScopeNodeId -ArmScopePath '/subscriptions/sub-1') }
        @($edge).Count | Should -Be 1
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

    It 'queries by management group when one is configured' {
        Mock Get-ARGRoleDefinitions -ParameterFilter { $ManagementGroups } -MockWith {
            @([pscustomobject]@{ name = 'g1'; properties = [pscustomobject]@{ roleName = 'Reader'; type = 'BuiltInRole'; permissions = @() } })
        }
        $ctx = New-TestCtx -ConfigOver @{ managementGroupId = 'mg1' }
        Sync-AzureRMRoleDefinitions -Ctx $ctx
        $ctx.RoleDefs['g1'].name | Should -Be 'Reader'
        Should -Invoke Get-ARGRoleDefinitions -Exactly 1 -ParameterFilter { $ManagementGroups -contains 'mg1' }
    }
}

Describe 'Get-AzureMgDisplayName' {
    It 'returns the ARM display name and caches it (one ARM call for two lookups)' {
        Mock Invoke-ARMGet { @{ properties = @{ displayName = 'Platform' } } }
        $ctx = New-TestCtx
        (Get-AzureMgDisplayName -Ctx $ctx -MgId 'mg1') | Should -Be 'Platform'
        (Get-AzureMgDisplayName -Ctx $ctx -MgId 'mg1') | Should -Be 'Platform'   # served from cache
        Should -Invoke Invoke-ARMGet -Exactly 1
    }
    It 'falls back to the raw id when the ARM lookup throws' {
        Mock Invoke-ARMGet { throw 'nope' }
        (Get-AzureMgDisplayName -Ctx (New-TestCtx) -MgId 'mg-x') | Should -Be 'mg-x'
    }
}

Describe 'Confirm-AzureAssignmentScope' {
    It 'creates a resource-group node + ancestor sub edge, tracked in KnownPaths' {
        $ctx = New-TestCtx
        [void]$ctx.KnownPaths.Add('/subscriptions/sub-1')
        $ctx.ScopePaths.Add('/subscriptions/sub-1')
        $rg = '/subscriptions/sub-1/resourceGroups/rg1'
        $id = Confirm-AzureAssignmentScope -Ctx $ctx -ScopePath $rg -OwningSubPath '/subscriptions/sub-1'
        $id | Should -Be (Get-ScopeNodeId -ArmScopePath $rg)
        $ctx.KnownPaths.Contains($rg) | Should -BeTrue
        @($ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureResourceGroup' }).Count | Should -Be 1
        @($ctx.ContainsEdges).Count | Should -BeGreaterThan 0
    }

    It 'links a management group down to the owning subscription' {
        Mock Invoke-ARMGet { @{ properties = @{ displayName = 'Platform MG' } } }
        $ctx = New-TestCtx
        $mg = '/providers/Microsoft.Management/managementGroups/mg1'
        Confirm-AzureAssignmentScope -Ctx $ctx -ScopePath $mg -OwningSubPath '/subscriptions/sub-1' | Out-Null
        @($ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureManagementGroup' }).Count | Should -Be 1
        $edge = $ctx.ContainsEdges | Where-Object { $_.parentResourceId -eq (Get-ScopeNodeId -ArmScopePath $mg) -and $_.childResourceId -eq (Get-ScopeNodeId -ArmScopePath '/subscriptions/sub-1') }
        @($edge).Count | Should -Be 1
    }

    It 'shapes the tenant root (/) as an AzureScope named Tenant Root' {
        $ctx = New-TestCtx
        Confirm-AzureAssignmentScope -Ctx $ctx -ScopePath '/' -OwningSubPath '/subscriptions/sub-1' | Out-Null
        $root = $ctx.ScopeResources | Where-Object { $_.externalId -eq '/' }
        @($root).Count | Should -Be 1
        $root.displayName  | Should -Be 'Tenant Root'
        $root.resourceType | Should -Be 'AzureScope'
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
        # A discovered scope node (with a type label) so the capability display name uses
        # the labelled "<role> @ <label>: <name>" form.
        [void]$ctx.KnownPaths.Add('/subscriptions/sub-1')
        $ctx.ScopeResources.Add(@{ id = (Get-ScopeNodeId -ArmScopePath '/subscriptions/sub-1'); displayName = 'Sub One'; extendedAttributes = @{ scopeTypeLabel = 'Sub' } })
        $ctx.RoleDefs['g1'] = @{ name = 'Owner'; isCustom = $false; plane = 'control' }
        Sync-AzureRMAssignments -Ctx $ctx
        $ctx.Grants.Count | Should -Be 1   # duplicate assignment name deduped
        $ctx.RoleResources.Count | Should -Be 1
        $ctx.RoleResources[0].displayName | Should -Be 'Owner @ Sub: Sub One'
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

# ---------------------------------------------------------------------------
# Payload shape and branch conditions in the Azure RM phases.
#
# The tests above assert how MANY nodes and edges a phase produces. What they
# do not assert is what is IN them — the flags the API stores, and the branch
# that decides a node's type. A mutant that flips `enabled = $true` to $false,
# or drops the propagates flag off a Contains edge, leaves every count correct
# and ships a tenant that looks synced but is not.
# ---------------------------------------------------------------------------
Describe 'Register-AzureRMSystem — the record it registers' {
    It 'registers the system enabled and sync-enabled, keyed on the tenant' {
        $script:body = $null
        Mock Invoke-IngestAPI { $script:body = $Body; @{ systemIds = @(7) } }
        Register-AzureRMSystem -Config (New-TestConfig) | Out-Null

        $rec = $script:body.records[0]
        $rec.systemType  | Should -Be 'AzureRM'
        $rec.enabled     | Should -BeTrue
        $rec.syncEnabled | Should -BeTrue
        $rec.tenantId    | Should -Not -BeNullOrEmpty
        $rec.displayName | Should -Match 'Azure RM'
        # Registering the system must never wipe it: delta, not full.
        $script:body.syncMode | Should -Be 'delta'
    }

    It 'falls back to 1 only when the response carries no usable id' {
        # The guard is `systemIds -and systemIds.Count -gt 0`; relaxing it to -or
        # would index an empty array on a response that has the key but no values.
        Mock Invoke-IngestAPI { @{ systemIds = @() } }
        Register-AzureRMSystem -Config (New-TestConfig) | Should -Be 1
    }
}

Describe 'Add-AzureScope / Add-AzureContainsEdge — edge and node shape' {
    It 'marks a Contains edge as propagating' {
        # Azure RBAC inherits down the scope tree; an edge that does not say so
        # leaves every child scope looking unaffected by its parent's assignments.
        $ctx = New-TestCtx
        Add-AzureContainsEdge -Ctx $ctx -ParentPath '/subscriptions/s' -ChildPath '/subscriptions/s/resourceGroups/rg'
        $edge = $ctx.ContainsEdges[0]
        $edge.relationshipType            | Should -Be 'Contains'
        $edge.extendedAttributes.propagates | Should -BeTrue
    }

    It 'marks the parent edge it creates as propagating too' {
        $ctx = New-TestCtx
        Add-AzureScope -Ctx $ctx -ArmPath '/subscriptions/s/resourceGroups/rg' -DisplayName 'rg' `
            -ResourceType 'AzureResourceGroup' -ParentArmPath '/subscriptions/s' -ScopeKind 'resourcegroup' | Out-Null
        $ctx.ContainsEdges[0].extendedAttributes.propagates | Should -BeTrue
    }

    It 'adds an azureResourceType only for AzureResource nodes' {
        # The branch is `-eq 'AzureResource'`; inverting it stamps the attribute on
        # subscriptions and resource groups and omits it where it matters.
        $ctx = New-TestCtx
        Add-AzureScope -Ctx $ctx -ArmPath '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa' `
            -DisplayName 'sa' -ResourceType 'AzureResource' -ScopeKind 'resource' | Out-Null
        Add-AzureScope -Ctx $ctx -ArmPath '/subscriptions/s' -DisplayName 'Sub' `
            -ResourceType 'AzureSubscription' -ScopeKind 'subscription' | Out-Null

        $res = $ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureResource' }
        $sub = $ctx.ScopeResources | Where-Object { $_.resourceType -eq 'AzureSubscription' }
        $res.extendedAttributes.ContainsKey('azureResourceType') | Should -BeTrue
        $sub.extendedAttributes.ContainsKey('azureResourceType') | Should -BeFalse
    }

    It 'records the arm path and scope kind on every node' {
        $ctx = New-TestCtx
        Add-AzureScope -Ctx $ctx -ArmPath '/subscriptions/s' -DisplayName 'Sub' `
            -ResourceType 'AzureSubscription' -ScopeKind 'subscription' | Out-Null
        $n = $ctx.ScopeResources[0]
        $n.externalId                        | Should -Be '/subscriptions/s'
        $n.extendedAttributes.armPath        | Should -Be '/subscriptions/s'
        $n.extendedAttributes.scopeKind      | Should -Be 'subscription'
        $n.extendedAttributes.scopeTypeLabel | Should -Not -BeNullOrEmpty
        $ctx.ScopePaths                      | Should -Contain '/subscriptions/s'
    }

    It 'merges caller-supplied extra attributes without dropping the built-in ones' {
        $ctx = New-TestCtx
        Add-AzureScope -Ctx $ctx -ArmPath '/subscriptions/s' -DisplayName 'Sub' `
            -ResourceType 'AzureSubscription' -ScopeKind 'subscription' `
            -ExtraExt @{ tagOwner = 'team-a'; tagEnv = 'prod' } | Out-Null
        $ext = $ctx.ScopeResources[0].extendedAttributes
        $ext.tagOwner  | Should -Be 'team-a'
        $ext.tagEnv    | Should -Be 'prod'
        $ext.armPath   | Should -Be '/subscriptions/s'
        $ext.scopeKind | Should -Be 'subscription'
    }

    It 'creates no parent edge when there is no parent path' {
        # A tenant-root node has no ancestor; inventing an edge to '' would attach
        # every root scope to a phantom parent.
        $ctx = New-TestCtx
        Add-AzureScope -Ctx $ctx -ArmPath '/' -DisplayName 'Tenant Root' `
            -ResourceType 'AzureScope' -ScopeKind 'tenant' | Out-Null
        $ctx.ContainsEdges.Count | Should -Be 0
    }
}

