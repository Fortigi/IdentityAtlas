#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the Azure RM crawler helper functions.

.DESCRIPTION
    Tests the pure/standalone functions extracted into
    tools/crawlers/azure-rm/AzureRMCrawler.Functions.ps1:
        Get-ScopeNodeId, Send-IngestBatch, Write-PhaseTiming,
        Get-ScopeTypeLabel, Get-AzureResourceType, Get-ResourceAttributes,
        Get-ParentScopePath.

    Get-ScopeNodeId calls Get-CapabilityId; Send-IngestBatch calls
    Invoke-IngestAPI / ConvertTo-JsonArray — both shared helpers are
    dot-sourced here exactly as they are into Start-AzureRMCrawler.ps1.
    Only the Ingest API boundary (Invoke-IngestAPI) is mocked.

.USAGE
    Invoke-Pester -Path test/unit/AzureRMCrawlerFunctions.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Get-CapabilityId.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Invoke-CrawlerIngest.ps1')
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'azure-rm' 'AzureRMCrawler.Functions.ps1')
}

Describe 'Get-ScopeNodeId' {
    It 'is deterministic for the same ARM path' {
        $a = Get-ScopeNodeId -ArmScopePath '/subscriptions/abc/resourceGroups/rg1'
        $b = Get-ScopeNodeId -ArmScopePath '/subscriptions/abc/resourceGroups/rg1'
        $a | Should -Be $b
    }

    It 'is case-insensitive (same id regardless of ARM-path casing)' {
        $lower = Get-ScopeNodeId -ArmScopePath '/subscriptions/abc/resourcegroups/foo'
        $mixed = Get-ScopeNodeId -ArmScopePath '/subscriptions/ABC/resourceGroups/Foo'
        $lower | Should -Be $mixed
    }

    It 'produces distinct ids for distinct paths' {
        $a = Get-ScopeNodeId -ArmScopePath '/subscriptions/abc/resourceGroups/rg1'
        $b = Get-ScopeNodeId -ArmScopePath '/subscriptions/abc/resourceGroups/rg2'
        $a | Should -Not -Be $b
    }

    It 'does not collide for paths differing only by a reserved | / % character' {
        # The percent-then-pipe encoding must keep the hash input injective.
        $pipe    = Get-ScopeNodeId -ArmScopePath '/subscriptions/abc/providers/foo|bar'
        $percent = Get-ScopeNodeId -ArmScopePath '/subscriptions/abc/providers/foo%7Cbar'
        $pipe | Should -Not -Be $percent
    }
}

Describe 'Send-IngestBatch' {
    It 'posts an empty records array when there are no records' {
        Mock Invoke-IngestAPI { @{ ok = $true } }
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 7 -SyncMode 'full' -Records @() | Out-Null
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter {
            $Endpoint -eq 'ingest/resources' -and
            $Body.systemId -eq 7 -and
            $Body.syncMode -eq 'full' -and
            $Body.records.Count -eq 0
        }
    }

    It 'wraps non-empty records and forwards systemId / syncMode / scope' {
        Mock Invoke-IngestAPI { @{ ok = $true } }
        $records = @(@{ id = 'r1' }, @{ id = 'r2' })
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 3 -SyncMode 'delta' -Scope @{ resourceType = 'AzureScope' } -Records $records | Out-Null
        Should -Invoke Invoke-IngestAPI -Exactly 1 -ParameterFilter {
            $Endpoint -eq 'ingest/resources' -and
            $Body.systemId -eq 3 -and
            $Body.syncMode -eq 'delta' -and
            $Body.scope.resourceType -eq 'AzureScope' -and
            $null -ne $Body.records
        }
    }

    It 'returns the Ingest API result' {
        Mock Invoke-IngestAPI { @{ inserted = 2 } }
        $r = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId 1 -Records @(@{ id = 'x' })
        $r.inserted | Should -Be 2
    }
}

Describe 'Write-PhaseTiming' {
    It 'reports the phase name and the delta of Azure calls since the phase start' {
        Mock Write-Host { }
        $Global:AzCallCount = 10
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $sw.Stop()
        Write-PhaseTiming -Name 'role definitions' -Sw $sw -CallsBefore 4
        Should -Invoke Write-Host -Exactly 1 -ParameterFilter {
            $Object -like '*role definitions*' -and $Object -like '*6 Azure call(s)*'
        }
        $Global:AzCallCount = $null
    }
}

Describe 'Get-ScopeTypeLabel' {
    It 'maps each scope kind to its short label' {
        Get-ScopeTypeLabel -ScopeKind 'ManagementGroup' | Should -Be 'MG'
        Get-ScopeTypeLabel -ScopeKind 'Subscription'    | Should -Be 'Sub'
        Get-ScopeTypeLabel -ScopeKind 'ResourceGroup'   | Should -Be 'RG'
        Get-ScopeTypeLabel -ScopeKind 'Resource'        | Should -Be 'Res'
    }

    It 'returns an empty string for an unknown kind' {
        Get-ScopeTypeLabel -ScopeKind 'Nope' | Should -Be ''
    }
}

Describe 'Get-AzureResourceType' {
    It 'parses provider namespace + type from a resource id' {
        $path = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1'
        Get-AzureResourceType -ArmPath $path | Should -Be 'Microsoft.Compute/virtualMachines'
    }

    It 'keeps only type segments for nested (sub-resource) types' {
        $path = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa/blobServices/default'
        Get-AzureResourceType -ArmPath $path | Should -Be 'Microsoft.Storage/storageAccounts/blobServices'
    }

    It 'returns an empty string when there is no provider segment' {
        Get-AzureResourceType -ArmPath '/subscriptions/s/resourceGroups/rg' | Should -Be ''
    }
}

Describe 'Get-ResourceAttributes' {
    It 'lifts location, tags, and managed identity into extended attributes' {
        $res = [pscustomobject]@{
            location = 'westeurope'
            tags     = [pscustomobject]@{ Prio = 'High'; Env = 'Prod' }
            identity = [pscustomobject]@{ type = 'SystemAssigned'; principalId = 'mi-123' }
        }
        $ext = Get-ResourceAttributes -Resource $res
        $ext['azureLocation']              | Should -Be 'westeurope'
        $ext['tag.Prio']                   | Should -Be 'High'
        $ext['tag.Env']                    | Should -Be 'Prod'
        $ext['managedIdentity']            | Should -Be 'SystemAssigned'
        $ext['managedIdentityPrincipalId'] | Should -Be 'mi-123'
    }

    It 'returns an empty hashtable for a bare resource' {
        $ext = Get-ResourceAttributes -Resource ([pscustomobject]@{ name = 'x' })
        $ext.Keys.Count | Should -Be 0
    }

    It 'ignores an identity of type None' {
        $res = [pscustomobject]@{ identity = [pscustomobject]@{ type = 'None' } }
        $ext = Get-ResourceAttributes -Resource $res
        $ext.ContainsKey('managedIdentity') | Should -BeFalse
    }

    It 'omits the principalId attribute when the managed identity has none' {
        $res = [pscustomobject]@{ identity = [pscustomobject]@{ type = 'UserAssigned' } }
        $ext = Get-ResourceAttributes -Resource $res
        $ext['managedIdentity'] | Should -Be 'UserAssigned'
        $ext.ContainsKey('managedIdentityPrincipalId') | Should -BeFalse
    }
}

Describe 'Get-ParentScopePath' {
    It 'returns the resource group for a resource' {
        $r = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1'
        Get-ParentScopePath -ScopePath $r | Should -Be '/subscriptions/s/resourceGroups/rg'
    }

    It 'returns the subscription for a resource group' {
        Get-ParentScopePath -ScopePath '/subscriptions/s/resourceGroups/rg' | Should -Be '/subscriptions/s'
    }

    It 'returns the subscription for a subscription-level provider resource' {
        $r = '/subscriptions/s/providers/Microsoft.Authorization/policyAssignments/pa1'
        Get-ParentScopePath -ScopePath $r | Should -Be '/subscriptions/s'
    }

    It 'returns $null for a bare subscription scope' {
        Get-ParentScopePath -ScopePath '/subscriptions/s' | Should -BeNullOrEmpty
    }

    It 'returns $null for a management-group scope' {
        Get-ParentScopePath -ScopePath '/providers/Microsoft.Management/managementGroups/mg1' | Should -BeNullOrEmpty
    }
}

# ─── Group-FGRecordsByResourceType ───────────────────────────────────────────────
Describe 'Group-FGRecordsByResourceType' {
    It 'groups records by resourceType so each type can be reconciled in its own full-sync batch' {
        $recs = @(
            @{ id = 's1';  resourceType = 'AzureSubscription' },
            @{ id = 'rg1'; resourceType = 'AzureResourceGroup' },
            @{ id = 'r1';  resourceType = 'AzureResource' },
            @{ id = 'r2';  resourceType = 'AzureResource' }
        )
        $g = Group-FGRecordsByResourceType -Records $recs
        $g.Keys.Count | Should -Be 3
        @($g['AzureResource']).Count | Should -Be 2
        @($g['AzureSubscription']).Count | Should -Be 1
        @($g['AzureResourceGroup']).Count | Should -Be 1
    }

    It 'preserves first-seen type order' {
        $recs = @(
            @{ id = 'a'; resourceType = 'AzureSubscription' },
            @{ id = 'b'; resourceType = 'AzureResource' }
        )
        (Group-FGRecordsByResourceType -Records $recs).Keys | Select-Object -First 1 | Should -Be 'AzureSubscription'
    }

    It 'returns an empty map for no records (so a run reconciles nothing rather than wiping rows)' {
        (Group-FGRecordsByResourceType -Records @()).Keys.Count | Should -Be 0
    }
}
