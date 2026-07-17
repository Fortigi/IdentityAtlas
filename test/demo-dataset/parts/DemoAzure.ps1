<#
.SYNOPSIS
    Fortigi Demo Corp — the AzureRM system (CTF Track 2, flag 10).

.DESCRIPTION
    A small but structurally faithful copy of what the real Azure RM crawler
    emits (tools/crawlers/azure-rm/AzureRMCrawler.Transform.ps1):

      * Scope nodes — 'AzureScope' (root), 'AzureResourceGroup', 'AzureResource'
        — carrying `armPath` / `scopeKind` / `scopeTypeLabel`, linked into a tree
        by `Contains`.
      * One synthetic 'AzureRoleAssignment' capability resource per
        (scope, role definition), named "<Role> @ <scope>", carrying
        `capabilityId` / `targetNodeId` / `roleName` / `isCustom` / `plane`.
      * RBAC grants as Direct assignments from Entra principals onto those
        capability resources — which is also the demo's cross-system case: an
        Entra account holding access in a different system.

    Region: the real crawler stores the region as `azureLocation` in the scope
    node's extendedAttributes (AzureRMCrawler.Functions.ps1). We ALSO stamp
    azureLocation on the capability resource. That is a deliberate
    denormalisation: the capability is "role at scope", so the scope's region is
    an intrinsic property of it — and it is the only way a matrix resource-filter
    can select "everything in Azure US", since the assignments hang off the
    capability, not the scope node. The real crawler should arguably do the same;
    noted as a follow-up rather than fixed here.

    Flag 10 answers "which users have access to a resource in Azure US" =
    everyone assigned to an eastus capability. rg-prod-westeurope exists purely
    as the distractor, and Victor Wang holds roles in BOTH regions so the answer
    can't be reached by "whoever isn't in westeurope".
#>

Set-StrictMode -Version Latest

$script:DemoSubId = '11111111-2222-3333-4444-555555555555'

function Add-DemoAzure {
    param([Parameter(Mandatory)]$State)

    $sysAz = $State.SystemIds['azurerm']
    $sub   = $script:DemoSubId

    $rootId = New-DemoGuid 'res-az-scope-root'
    $null = Add-DemoResource $State -Id $rootId -DisplayName 'Fortigi Demo Tenant' -ResourceType 'AzureScope' `
        -SystemId $sysAz -ExternalId '/' `
        -Extended @{ armPath = '/'; scopeKind = 'Root'; scopeTypeLabel = 'Root' }

    $scopes = @(
        @{ Key = 'rg-eastus';  Name = 'rg-prod-eastus';      Location = 'eastus';      Kind = 'ResourceGroup' }
        @{ Key = 'rg-weu';     Name = 'rg-prod-westeurope';  Location = 'westeurope';  Kind = 'ResourceGroup' }
    )
    $scopeIds = @{}
    foreach ($s in $scopes) {
        $armPath = "/subscriptions/$sub/resourceGroups/$($s.Name)"
        $id = New-DemoGuid "res-az-scope-$($s.Key)"
        $scopeIds[$s.Key] = $id
        $null = Add-DemoResource $State -Id $id -DisplayName $s.Name -ResourceType 'AzureResourceGroup' `
            -SystemId $sysAz -ExternalId $armPath `
            -Extended @{ armPath = $armPath; scopeKind = 'ResourceGroup'; scopeTypeLabel = 'RG'; azureLocation = $s.Location }
        Add-DemoRelationship $State -ParentResourceId $rootId -ChildResourceId $id -RelationshipType 'Contains'
    }

    $storage = @(
        @{ Key = 'st-eastus'; Name = 'stprodeastus01'; Rg = 'rg-eastus'; RgName = 'rg-prod-eastus'; Location = 'eastus' }
        @{ Key = 'st-weu';    Name = 'stprodweu01';    Rg = 'rg-weu';    RgName = 'rg-prod-westeurope'; Location = 'westeurope' }
    )
    foreach ($st in $storage) {
        $armPath = "/subscriptions/$sub/resourceGroups/$($st.RgName)/providers/Microsoft.Storage/storageAccounts/$($st.Name)"
        $id = New-DemoGuid "res-az-scope-$($st.Key)"
        $scopeIds[$st.Key] = $id
        $null = Add-DemoResource $State -Id $id -DisplayName $st.Name -ResourceType 'AzureResource' `
            -SystemId $sysAz -ExternalId $armPath `
            -Extended @{
                armPath = $armPath; scopeKind = 'Resource'; scopeTypeLabel = 'Res'
                azureResourceType = 'Microsoft.Storage/storageAccounts'; azureLocation = $st.Location
            }
        Add-DemoRelationship $State -ParentResourceId $scopeIds[$st.Rg] -ChildResourceId $id -RelationshipType 'Contains'
    }

    Add-DemoAzureRoleAssignments $State -ScopeIds $scopeIds
}

# The synthetic "<role> @ <scope>" capability resources plus who holds them.
function Add-DemoAzureRoleAssignments {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][hashtable]$ScopeIds
    )

    $sysAz = $State.SystemIds['azurerm']

    # Well-known Azure built-in role definition ids.
    $roleDefs = @{
        'Contributor'                  = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
        'Reader'                       = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
        'Storage Blob Data Contributor' = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
    }

    $caps = @(
        # ── Azure US (eastus) — flag 10's answer lives here ──────────────────
        @{ Key = 'contrib-rg-eastus'; Role = 'Contributor'; Scope = 'rg-eastus'; ScopeName = 'rg-prod-eastus'
           Location = 'eastus'; Holders = @('E0029'); ServicePrincipals = @('SvcPrinc') }
        @{ Key = 'blob-st-eastus'; Role = 'Storage Blob Data Contributor'; Scope = 'st-eastus'; ScopeName = 'stprodeastus01'
           Location = 'eastus'; Holders = @('E0030'); ServicePrincipals = @() }
        # ── EU (westeurope) — the distractor ─────────────────────────────────
        @{ Key = 'reader-rg-weu'; Role = 'Reader'; Scope = 'rg-weu'; ScopeName = 'rg-prod-westeurope'
           Location = 'westeurope'; Holders = @('E0020', 'E0010'); ServicePrincipals = @() }
        # Victor holds roles in both regions, so "not in westeurope" is not a
        # shortcut to the answer.
        @{ Key = 'contrib-rg-weu'; Role = 'Contributor'; Scope = 'rg-weu'; ScopeName = 'rg-prod-westeurope'
           Location = 'westeurope'; Holders = @('E0029'); ServicePrincipals = @() }
    )

    foreach ($cap in $caps) {
        $capId = New-DemoGuid "res-az-cap-$($cap.Key)"
        $null = Add-DemoResource $State -Id $capId -DisplayName "$($cap.Role) @ $($cap.ScopeName)" `
            -ResourceType 'AzureRoleAssignment' -SystemId $sysAz `
            -Extended @{
                capabilityId  = $roleDefs[$cap.Role]
                targetNodeId  = $ScopeIds[$cap.Scope]
                roleName      = $cap.Role
                isCustom      = $false
                plane         = 'control'
                azureLocation = $cap.Location
            }

        foreach ($e in $cap.Holders) {
            Add-DemoAssignment $State -ResourceId $capId -PrincipalId (Get-DemoPrincipalId $e) -AssignmentType 'Direct'
        }
        foreach ($spKey in $cap.ServicePrincipals) {
            Add-DemoAssignment $State -ResourceId $capId -PrincipalId $State.EdgeCaseIds[$spKey] `
                -AssignmentType 'Direct' -ResourceType 'AzureRoleAssignment'
        }
    }
}
