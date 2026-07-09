<#
.SYNOPSIS
    Sync phases + shared state for the Azure RM crawler, extracted from
    Start-AzureRMCrawler.ps1.

.DESCRIPTION
    The crawler builds several interdependent accumulators across its phases
    (scope nodes, Contains edges, role definitions, capability-resources, grants,
    principal stubs, dedup sets) and some later phases REASSIGN them (dedup, orphan
    filtering). To make that threadable and testable, all of it lives in a single
    state hashtable `$Ctx` created by New-AzureRMState; every phase takes `$Ctx` and
    mutates (or reassigns) its keys. Because `$Ctx` is one shared reference,
    reassigning `$Ctx.Grants = @(...)` in one phase is visible to the next — which a
    scope-captured local could not do.

    The ARM/ARG library calls (Invoke-ARMList/Get/…, Get-ARG*) come from the
    same-folder Get-AzureRMHelpers.ps1 / Get-AzureRGHelpers.ps1 (dot-sourced by the
    dispatcher); the pure shapers come from AzureRMCrawler.Transform.ps1; the pure
    helpers (Get-ScopeNodeId, Get-ScopeTypeLabel, …) from AzureRMCrawler.Functions.ps1.
    Behaviour is unchanged from the original inline phases.
#>

# ARM api-versions (pinned). Subscriptions + the management-group hierarchy are read
# over the ARM REST API; resource groups, resources, role definitions and role
# assignments come from Azure Resource Graph.
$script:AZ_API_SUBS = '2022-12-01'
$script:AZ_API_MG   = '2021-04-01'

# ─── State ───────────────────────────────────────────────────────
function New-AzureRMState {
    [CmdletBinding()]
    param([hashtable]$Config, [int]$SystemId)
    return @{
        Config         = $Config
        SystemId       = $SystemId
        Subs           = @()
        SubIds         = @()
        ScopeResources = [System.Collections.Generic.List[object]]::new()
        ContainsEdges  = [System.Collections.Generic.List[object]]::new()
        ScopePaths     = [System.Collections.Generic.List[string]]::new()
        KnownPaths     = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        RoleDefs       = @{}
        RoleResources  = [System.Collections.Generic.List[object]]::new()
        RoleResSeen    = [System.Collections.Generic.HashSet[string]]::new()
        Grants         = [System.Collections.Generic.List[object]]::new()
        PrincipalStubs = @{ User = [System.Collections.Generic.List[object]]::new(); ServicePrincipal = [System.Collections.Generic.List[object]]::new() }
        StubSeen       = [System.Collections.Generic.HashSet[string]]::new()
        MgNameCache    = @{}
        AssignSeen     = [System.Collections.Generic.HashSet[string]]::new()
    }
}

# ─── Setup: config / auth / system ───────────────────────────────
function Resolve-AzureRMConfig {
    [CmdletBinding()]
    param([string]$ConfigPath)
    $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    return @{
        syncMode             = if ($cfg._syncMode -in @('full', 'delta')) { $cfg._syncMode } else { 'full' }
        includeResourceLevel = [bool]$cfg.includeResourceLevel
        includeCustomRoles   = if ($null -ne $cfg.includeCustomRoles) { [bool]$cfg.includeCustomRoles } else { $true }
        onlyEntraPrincipals  = if ($null -ne $cfg.onlyEntraPrincipals) { [bool]$cfg.onlyEntraPrincipals } else { $true }
        subscriptionFilter   = if ($cfg.subscriptionIds) { @($cfg.subscriptionIds) } else { @() }
        managementGroupId    = if ($cfg.managementGroupId) { [string]$cfg.managementGroupId } else { $null }
        tenantId             = [string]$cfg.tenantId
        clientId             = [string]$cfg.clientId
        clientSecret         = $cfg.clientSecret
    }
}

function Connect-AzureRMSession {
    [CmdletBinding()]
    param([hashtable]$Config)
    Connect-AzureRM -TenantId $Config.tenantId -ClientId $Config.clientId -ClientSecret $Config.clientSecret
}

function Register-AzureRMSystem {
    [CmdletBinding()]
    param([hashtable]$Config)
    $sysResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'delta'
        records  = @(@{ systemType = 'AzureRM'; displayName = "Azure RM ($($Config.tenantId))"; tenantId = [string]$Config.tenantId; enabled = $true; syncEnabled = $true })
    }
    $id = if ($sysResult.systemIds -and $sysResult.systemIds.Count -gt 0) { [int]$sysResult.systemIds[0] } else { 1 }
    Write-Host "  System ID: $id" -ForegroundColor Green
    return $id
}

# ─── Scope helpers (mutate $Ctx) ─────────────────────────────────
# Register a scope node + (optional) parent Contains edge; returns the node id.
function Add-AzureScope {
    [CmdletBinding()]
    param([hashtable]$Ctx, [string]$ArmPath, [string]$DisplayName, [string]$ResourceType, [string]$ParentArmPath, [string]$ScopeKind, [hashtable]$ExtraExt)
    $nodeId = Get-ScopeNodeId -ArmScopePath $ArmPath
    $ext = @{ armPath = $ArmPath; scopeKind = $ScopeKind; scopeTypeLabel = (Get-ScopeTypeLabel -ScopeKind $ScopeKind) }
    if ($ResourceType -eq 'AzureResource') { $ext['azureResourceType'] = (Get-AzureResourceType -ArmPath $ArmPath) }
    if ($ExtraExt) { foreach ($k in $ExtraExt.Keys) { $ext[$k] = $ExtraExt[$k] } }
    $Ctx.ScopeResources.Add(@{
        id = $nodeId; displayName = $DisplayName; resourceType = $ResourceType; externalId = $ArmPath
        extendedAttributes = $ext
    })
    if ($ParentArmPath) {
        $Ctx.ContainsEdges.Add(@{
            parentResourceId = (Get-ScopeNodeId -ArmScopePath $ParentArmPath)
            childResourceId  = $nodeId
            relationshipType = 'Contains'
            extendedAttributes = @{ propagates = $true }
        })
    }
    $Ctx.ScopePaths.Add($ArmPath)
    return $nodeId
}

function Add-AzureContainsEdge {
    [CmdletBinding()]
    param([hashtable]$Ctx, [string]$ParentPath, [string]$ChildPath)
    $Ctx.ContainsEdges.Add(@{
        parentResourceId = (Get-ScopeNodeId -ArmScopePath $ParentPath)
        childResourceId  = (Get-ScopeNodeId -ArmScopePath $ChildPath)
        relationshipType = 'Contains'; extendedAttributes = @{ propagates = $true }
    })
}

# ─── Phase: Scope discovery ──────────────────────────────────────
# Pull every resource group (and, if requested, every resource) for the whole tenant
# up front in a handful of paged Resource Graph queries, indexed by parent so the
# scope-building loop does no per-subscription / per-resource-group network calls.
function Build-AzureScopeIndex {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    $rgsBySub = @{}
    $resByRg  = @{}
    foreach ($rg in (Get-ARGResourceGroups -SubscriptionIds $Ctx.SubIds)) {
        $k = [string]$rg.subscriptionId
        if (-not $rgsBySub.ContainsKey($k)) { $rgsBySub[$k] = [System.Collections.Generic.List[object]]::new() }
        $rgsBySub[$k].Add($rg)
    }
    if ($Ctx.Config.includeResourceLevel) {
        foreach ($r in (Get-ARGResources -SubscriptionIds $Ctx.SubIds)) {
            $rgKey = "/subscriptions/$($r.subscriptionId)/resourcegroups/$($r.resourceGroup)".ToLowerInvariant()
            if (-not $resByRg.ContainsKey($rgKey)) { $resByRg[$rgKey] = [System.Collections.Generic.List[object]]::new() }
            $resByRg[$rgKey].Add($r)
        }
    }
    return @{ rgsBySub = $rgsBySub; resByRg = $resByRg }
}

# Emit the (optional) resource-level scope nodes for one resource group.
function Add-AzureResourceGroupResourceScopes {
    [CmdletBinding()]
    param([hashtable]$Ctx, [hashtable]$Index, $ResourceGroup)
    if (-not $Ctx.Config.includeResourceLevel) { return }
    $rgKey = ([string]$ResourceGroup.id).ToLowerInvariant()
    $resources = if ($Index.resByRg.ContainsKey($rgKey)) { $Index.resByRg[$rgKey] } else { @() }
    foreach ($r in $resources) {
        Add-AzureScope -Ctx $Ctx -ArmPath $r.id -DisplayName $r.name -ResourceType 'AzureResource' -ParentArmPath $ResourceGroup.id -ScopeKind 'Resource' -ExtraExt (Get-ResourceAttributes -Resource $r) | Out-Null
    }
}

# Emit the resource-group node (+ its resource subtree) for one subscription.
function Add-AzureSubscriptionRgScopes {
    [CmdletBinding()]
    param([hashtable]$Ctx, [hashtable]$Index, $Sub, [string]$SubPath)
    $rgs = if ($Index.rgsBySub.ContainsKey([string]$Sub.subscriptionId)) { $Index.rgsBySub[[string]$Sub.subscriptionId] } else { @() }
    foreach ($rg in $rgs) {
        Add-AzureScope -Ctx $Ctx -ArmPath $rg.id -DisplayName $rg.name -ResourceType 'AzureResourceGroup' -ParentArmPath $SubPath -ScopeKind 'ResourceGroup' | Out-Null
        Add-AzureResourceGroupResourceScopes -Ctx $Ctx -Index $Index -ResourceGroup $rg
    }
}

# Subscription → resource-group → (optional) resource scope nodes.
function Add-AzureSubscriptionScopes {
    [CmdletBinding()]
    param([hashtable]$Ctx, [hashtable]$Index)
    foreach ($sub in $Ctx.Subs) {
        $subPath = "/subscriptions/$($sub.subscriptionId)"
        Add-AzureScope -Ctx $Ctx -ArmPath $subPath -DisplayName $sub.displayName -ResourceType 'AzureSubscription' -ParentArmPath $null -ScopeKind 'Subscription' | Out-Null
        Add-AzureSubscriptionRgScopes -Ctx $Ctx -Index $Index -Sub $sub -SubPath $subPath
    }
}

# Process one node popped off the management-group walk stack: emit an MG scope node
# (pushing its children back onto $Stack), or link a discovered subscription to its MG
# parent. Subscriptions are edge-only — the node was built during discovery.
function Add-AzureManagementGroupNode {
    [CmdletBinding()]
    param([hashtable]$Ctx, $Current, $Stack)
    $node = $Current.node
    $path = $node.id
    if ($node.type -eq 'Microsoft.Management/managementGroups' -or $node.type -eq '/providers/Microsoft.Management/managementGroups') {
        $name = if ($node.properties.displayName) { $node.properties.displayName } else { $node.name }
        Add-AzureScope -Ctx $Ctx -ArmPath $path -DisplayName $name -ResourceType 'AzureManagementGroup' -ParentArmPath $Current.parentPath -ScopeKind 'ManagementGroup' | Out-Null
        foreach ($child in @($node.properties.children)) { $Stack.Push(@{ node = $child; parentPath = $path }) }
        return
    }
    if ($node.type -notmatch 'subscriptions') { return }
    $subPath = "/subscriptions/$($node.name)"
    if (($Ctx.ScopePaths -contains $subPath) -and $Current.parentPath) {
        Add-AzureContainsEdge -Ctx $Ctx -ParentPath $Current.parentPath -ChildPath $subPath
    }
}

# Management-group tree beneath the configured root; each MG/subscription child links
# to its parent (subscriptions are edge-only — the node was built during discovery).
function Add-AzureManagementGroupScopes {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    Update-CrawlerProgress -Step 'Discovering management groups' -Pct 14
    $mgRoot = Invoke-ARMGet -Path "/providers/Microsoft.Management/managementGroups/$($Ctx.Config.managementGroupId)`?api-version=$script:AZ_API_MG&`$expand=children&`$recurse=true"
    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push(@{ node = $mgRoot; parentPath = $null })
    while ($stack.Count -gt 0) {
        $cur = $stack.Pop()
        Add-AzureManagementGroupNode -Ctx $Ctx -Current $cur -Stack $stack
    }
}

# Scope discovery: subscriptions (+ configured filter), their RG/resource subtree, and
# — when a management group is configured — the MG hierarchy above them.
function Sync-AzureRMScopes {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    Update-CrawlerProgress -Step 'Discovering scopes' -Pct 8
    $sw = [System.Diagnostics.Stopwatch]::StartNew(); $callsBefore = $Global:AzCallCount

    $subs = Invoke-ARMList -Path "/subscriptions?api-version=$script:AZ_API_SUBS"
    if ($Ctx.Config.subscriptionFilter.Count -gt 0) {
        $subs = @($subs | Where-Object { $Ctx.Config.subscriptionFilter -contains $_.subscriptionId })
    }
    $Ctx.Subs   = $subs
    $Ctx.SubIds = @($subs | ForEach-Object { [string]$_.subscriptionId })
    Write-Host "  $($subs.Count) subscription(s)" -ForegroundColor Gray

    if ($Ctx.SubIds.Count -gt 0) {
        $index = Build-AzureScopeIndex -Ctx $Ctx
        Add-AzureSubscriptionScopes -Ctx $Ctx -Index $index
    }
    $sw.Stop()
    Write-PhaseTiming -Name 'scope discovery' -Sw $sw -CallsBefore $callsBefore

    if ($Ctx.Config.managementGroupId) { Add-AzureManagementGroupScopes -Ctx $Ctx }
    Write-Host "  $($Ctx.ScopeResources.Count) scope nodes, $($Ctx.ContainsEdges.Count) Contains edges (pre-assignment)" -ForegroundColor Gray
}

# ─── Phase: Role definitions ─────────────────────────────────────
# Resource Graph returns every visible role definition (built-in catalog included) in
# one paged query; deduped by GUID and classified control/data/both.
function Sync-AzureRMRoleDefinitions {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    Update-CrawlerProgress -Step 'Fetching role definitions' -Pct 35
    $sw = [System.Diagnostics.Stopwatch]::StartNew(); $callsBefore = $Global:AzCallCount
    $allDefs = if ($Ctx.Config.managementGroupId) { Get-ARGRoleDefinitions -ManagementGroups @($Ctx.Config.managementGroupId) }
               else { Get-ARGRoleDefinitions -SubscriptionIds $Ctx.SubIds }
    foreach ($d in $allDefs) {
        $guid = $d.name
        if ($Ctx.RoleDefs.ContainsKey($guid)) { continue }
        $isCustom = ($d.properties.type -eq 'CustomRole')
        if ($isCustom -and -not $Ctx.Config.includeCustomRoles) { continue }
        $plane = Get-AzureRolePlane -Permissions $d.properties.permissions
        $Ctx.RoleDefs[$guid] = @{ name = $d.properties.roleName; isCustom = $isCustom; plane = $plane }
    }
    $sw.Stop()
    Write-Host "  $($Ctx.RoleDefs.Count) role definitions" -ForegroundColor Gray
    Write-PhaseTiming -Name 'role definitions' -Sw $sw -CallsBefore $callsBefore
}

# ─── Phase: Role assignments ─────────────────────────────────────
# Resolve a management group's friendly display name (cached).
function Get-AzureMgDisplayName {
    [CmdletBinding()]
    param([hashtable]$Ctx, [string]$MgId)
    if ($Ctx.MgNameCache.ContainsKey($MgId)) { return $Ctx.MgNameCache[$MgId] }
    $name = $MgId
    try {
        $mg = Invoke-ARMGet -Path "/providers/Microsoft.Management/managementGroups/$MgId`?api-version=$script:AZ_API_MG"
        if ($mg.properties.displayName) { $name = [string]$mg.properties.displayName }
    } catch { }
    $Ctx.MgNameCache[$MgId] = $name
    return $name
}

# Ensure a scope node exists for an assignment's declared scope, creating it (and any
# missing ancestors) so the effective-access engine can inherit through the Contains
# hierarchy. Management groups / the tenant root sit above the subscription, so they
# link down to the owning subscription. Returns the scope node id.
function Confirm-AzureAssignmentScope {
    [CmdletBinding()]
    param([hashtable]$Ctx, [string]$ScopePath, [string]$OwningSubPath)
    $aboveSub = ($ScopePath -eq '/' -or $ScopePath -match '^/providers/Microsoft\.Management/managementGroups/')
    if (-not $Ctx.KnownPaths.Contains($ScopePath)) {
        if ($aboveSub) {
            $name = if ($ScopePath -eq '/') { 'Tenant Root' } else { Get-AzureMgDisplayName -Ctx $Ctx -MgId (($ScopePath -split '/')[-1]) }
            $Ctx.ScopeResources.Add((New-AzureAboveSubScopeRecord -ScopePath $ScopePath -DisplayName $name))
        } else {
            $parentPath = Get-ParentScopePath -ScopePath $ScopePath
            $Ctx.ScopeResources.Add((New-AzureBelowSubScopeRecord -ScopePath $ScopePath))
            if ($parentPath) {
                [void](Confirm-AzureAssignmentScope -Ctx $Ctx -ScopePath $parentPath -OwningSubPath $OwningSubPath)
                Add-AzureContainsEdge -Ctx $Ctx -ParentPath $parentPath -ChildPath $ScopePath
            }
        }
        [void]$Ctx.KnownPaths.Add($ScopePath)
    }
    # Always (re)link a management group / tenant root to the owning subscription so its
    # assignments inherit into every crawled subscription beneath it (edges deduped later).
    if ($aboveSub -and $OwningSubPath) { Add-AzureContainsEdge -Ctx $Ctx -ParentPath $ScopePath -ChildPath $OwningSubPath }
    return Get-ScopeNodeId -ArmScopePath $ScopePath
}

# Fetch every assignment once (AtScopeAboveAndBelow), then rebuild each subscription's
# "visible set": an assignment in a subscription's own subtree is seen only by that
# subscription; one at a management-group ancestor by every subscription beneath that
# MG; one at the tenant root ('/') by all. Returns lowercase-subId → List[assignment].
# Invert the per-subscription MG chains into lowercase-mgId → List[subId].
function Get-AzureSubsByMg {
    [CmdletBinding()]
    param([hashtable]$Ctx, $MgChains)
    $subsByMg = @{}
    foreach ($sid in $Ctx.SubIds) {
        foreach ($mg in @($MgChains[$sid])) {
            $mgKey = ([string]$mg).ToLowerInvariant()
            if (-not $subsByMg.ContainsKey($mgKey)) { $subsByMg[$mgKey] = [System.Collections.Generic.List[string]]::new() }
            $subsByMg[$mgKey].Add($sid)
        }
    }
    return $subsByMg
}

# Fan one assignment into every subscription bucket that should see it: its owning
# subscription, all subscriptions (tenant root), or the subscriptions beneath its MG.
function Add-AzureAssignmentToBuckets {
    [CmdletBinding()]
    param($BySub, $SubsByMg, $Assignment)
    $scope = [string]$Assignment.properties.scope
    if ($scope -match '^/subscriptions/([^/]+)') {
        $owner = $matches[1].ToLowerInvariant()
        if ($BySub.ContainsKey($owner)) { $BySub[$owner].Add($Assignment) }
        return
    }
    if ($scope -eq '/') {
        foreach ($k in $BySub.Keys) { $BySub[$k].Add($Assignment) }
        return
    }
    if ($scope -notmatch '^/providers/[Mm]icrosoft\.[Mm]anagement/managementGroups/([^/]+)') { return }
    $mgKey = $matches[1].ToLowerInvariant()
    if (-not $SubsByMg.ContainsKey($mgKey)) { return }
    foreach ($sid in $SubsByMg[$mgKey]) { $BySub[([string]$sid).ToLowerInvariant()].Add($Assignment) }
}

function Build-AzureAssignmentsBySub {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    $bySub = @{}
    if ($Ctx.SubIds.Count -eq 0) { return $bySub }
    $allAssign = Get-ARGRoleAssignments -SubscriptionIds $Ctx.SubIds
    $mgChains  = Get-ARGSubscriptionMgChains -SubscriptionIds $Ctx.SubIds
    $subsByMg  = Get-AzureSubsByMg -Ctx $Ctx -MgChains $mgChains
    foreach ($sid in $Ctx.SubIds) { $bySub[([string]$sid).ToLowerInvariant()] = [System.Collections.Generic.List[object]]::new() }
    foreach ($a in $allAssign) {
        Add-AzureAssignmentToBuckets -BySub $bySub -SubsByMg $subsByMg -Assignment $a
    }
    return $bySub
}

# Process one role assignment: ensure its scope node, emit the capability-resource
# (once per scope+role), the grant, and a thin principal stub. Mutates $Ctx.
function Add-AzureAssignment {
    [CmdletBinding()]
    param([hashtable]$Ctx, $Assignment, [string]$SubPath)
    $declaredScope = [string]$Assignment.properties.scope
    if (-not $declaredScope) { return }
    $roleDefId = ($Assignment.properties.roleDefinitionId -split '/')[-1]
    if (-not $Ctx.RoleDefs.ContainsKey($roleDefId)) { return }   # filtered (e.g. custom role excluded)

    $scopeNodeId = Confirm-AzureAssignmentScope -Ctx $Ctx -ScopePath $declaredScope -OwningSubPath $SubPath
    if (-not $Ctx.AssignSeen.Add([string]$Assignment.name)) { return }   # same Azure assignment via another sub

    $roleName = $Ctx.RoleDefs[$roleDefId].name
    $capResId = Get-CapabilityId -TargetNodeId $scopeNodeId -CapabilityId $roleDefId
    if ($Ctx.RoleResSeen.Add($capResId)) {
        $scopeRes = $Ctx.ScopeResources | Where-Object { $_.id -eq $scopeNodeId } | Select-Object -First 1
        $scopeName = $scopeRes.displayName
        $scopeLabel = $scopeRes.extendedAttributes.scopeTypeLabel
        $dn = if ($scopeLabel) { "$roleName @ ${scopeLabel}: $scopeName" } else { "$roleName @ $scopeName" }
        $Ctx.RoleResources.Add((New-AzureRoleAtScopeRecord -CapResId $capResId -DisplayName $dn -RoleDefId $roleDefId -ScopeNodeId $scopeNodeId -RoleName $roleName -IsCustom $Ctx.RoleDefs[$roleDefId].isCustom -Plane $Ctx.RoleDefs[$roleDefId].plane))
    }

    $pType = [string]$Assignment.properties.principalType
    $Ctx.Grants.Add((New-AzureGrantRecord -CapResId $capResId -Assignment $Assignment -PrincipalType $pType))

    if ($pType -in @('User', 'ServicePrincipal') -and $Ctx.StubSeen.Add([string]$Assignment.properties.principalId)) {
        $Ctx.PrincipalStubs[$pType].Add((New-AzurePrincipalStub -PrincipalId ([string]$Assignment.properties.principalId) -PrincipalType $pType))
    }
}

# Every role assignment is stored at its OWN declared scope; the engine computes
# inheritance on demand from the Contains hierarchy.
function Sync-AzureRMAssignments {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    Update-CrawlerProgress -Step 'Fetching role assignments' -Pct 55
    foreach ($p in $Ctx.ScopePaths) { [void]$Ctx.KnownPaths.Add($p) }
    $sw = [System.Diagnostics.Stopwatch]::StartNew(); $callsBefore = $Global:AzCallCount
    $argAssignBySub = Build-AzureAssignmentsBySub -Ctx $Ctx
    foreach ($sub in $Ctx.Subs) {
        $sk = ([string]$sub.subscriptionId).ToLowerInvariant()
        $subPath = "/subscriptions/$($sub.subscriptionId)"
        $assignments = if ($argAssignBySub.ContainsKey($sk)) { $argAssignBySub[$sk] } else { @() }
        foreach ($a in $assignments) { Add-AzureAssignment -Ctx $Ctx -Assignment $a -SubPath $subPath }
    }
    $sw.Stop()
    Write-Host "  $($Ctx.RoleResources.Count) role-at-scope resources, $($Ctx.Grants.Count) assignments" -ForegroundColor Gray
    Write-PhaseTiming -Name 'role assignments' -Sw $sw -CallsBefore $callsBefore
}

# ─── Dedup + sends ───────────────────────────────────────────────
# Dedup scope nodes / Contains edges / grants on their primary keys — the assignment
# phase adds nodes on demand, and Azure can declare the same principal+role at one
# scope twice; the ingest engine's ON CONFLICT can't touch a row twice.
function Optimize-AzureRecords {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    $sSeen = [System.Collections.Generic.HashSet[string]]::new()
    $Ctx.ScopeResources = @($Ctx.ScopeResources | Where-Object { $sSeen.Add([string]$_.id) })
    $eSeen = [System.Collections.Generic.HashSet[string]]::new()
    $Ctx.ContainsEdges = @($Ctx.ContainsEdges | Where-Object { $eSeen.Add("$($_.parentResourceId)|$($_.childResourceId)|$($_.relationshipType)") })
    $gSeen = [System.Collections.Generic.HashSet[string]]::new()
    $Ctx.Grants = @($Ctx.Grants | Where-Object { $gSeen.Add("$($_.resourceId)|$($_.principalId)|$($_.assignmentType)") })
    Write-Host "  $($Ctx.ScopeResources.Count) scope nodes, $($Ctx.ContainsEdges.Count) Contains edges (final)" -ForegroundColor Gray
}

# Scope nodes (grouped by resourceType so each batch reconciles its own rows) + edges.
function Send-AzureScopeRecords {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    $rtGroups = Group-FGRecordsByResourceType -Records $Ctx.ScopeResources
    foreach ($rt in $rtGroups.Keys) {
        Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $Ctx.SystemId -SyncMode $Ctx.Config.syncMode -Scope @{ resourceType = $rt } -Records @($rtGroups[$rt]) | Out-Null
    }
    Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $Ctx.SystemId -SyncMode $Ctx.Config.syncMode -Scope @{ relationshipType = 'Contains' } -Records $Ctx.ContainsEdges | Out-Null
}

# ─── Orphan handling ─────────────────────────────────────────────
# Drop grants + stubs for principals not present in the Entra directory, then prune the
# role-at-scope resources nobody holds anymore (full sync removes previously-loaded orphans).
function Remove-AzureOrphanGrants {
    [CmdletBinding()]
    param([hashtable]$Ctx, $Present, [int]$OrphanCount)
    $before = $Ctx.Grants.Count
    $Ctx.Grants = @($Ctx.Grants | Where-Object { $Present.Contains([string]$_.principalId) })
    foreach ($pt in @($Ctx.PrincipalStubs.Keys)) {
        $kept = [System.Collections.Generic.List[object]]::new()
        foreach ($stub in $Ctx.PrincipalStubs[$pt]) { if ($Present.Contains([string]$stub.id)) { $kept.Add($stub) } }
        $Ctx.PrincipalStubs[$pt] = $kept
    }
    $keptCaps = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($g in $Ctx.Grants) { [void]$keptCaps.Add([string]$g.resourceId) }
    $Ctx.RoleResources = @($Ctx.RoleResources | Where-Object { $keptCaps.Contains([string]$_.id) })
    Write-Host "  Orphan filter ON: dropped $($before - $Ctx.Grants.Count) assignment(s) for $OrphanCount principal(s) not in Entra ID." -ForegroundColor Gray
}

# Flag orphan stubs; leave assignments as-is.
function Set-AzureOrphanFlags {
    [CmdletBinding()]
    param([hashtable]$Ctx, $Present)
    $tagged = 0
    foreach ($pt in $Ctx.PrincipalStubs.Keys) {
        foreach ($stub in $Ctx.PrincipalStubs[$pt]) {
            if (-not $Present.Contains([string]$stub.id)) {
                if (-not $stub.ContainsKey('extendedAttributes')) { $stub['extendedAttributes'] = @{} }
                $stub['extendedAttributes']['directoryStatus'] = 'orphaned'
                $tagged++
            }
        }
    }
    Write-Host "  Orphan flag OFF: tagged $tagged principal(s) not in Entra ID as 'orphaned' (assignments kept)." -ForegroundColor Gray
}

# Azure RBAC can reference principals the Entra crawler hasn't loaded (deleted SPs, or
# principals intentionally out of scope). ON (default) drops them; OFF flags them. A
# tenant with no Entra data yet is left untouched.
function Resolve-AzureRMOrphans {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    $distinctPids = @($Ctx.Grants | ForEach-Object { [string]$_.principalId } | Sort-Object -Unique)
    if ($distinctPids.Count -eq 0) { return }
    $lookup = Invoke-IngestAPI -Endpoint 'ingest/principals-presence' -Body @{ tenantId = [string]$Ctx.Config.tenantId; ids = $distinctPids }
    if (-not $lookup.crawlerDataAvailable) {
        Write-Host "  No Entra ID data loaded by the crawler for this tenant yet — skipping orphan handling (run the Entra ID crawler first)." -ForegroundColor Yellow
        return
    }
    $present = [System.Collections.Generic.HashSet[string]]::new([string[]]@($lookup.present), [System.StringComparer]::OrdinalIgnoreCase)
    $orphanCount = 0
    foreach ($objId in $distinctPids) { if (-not $present.Contains($objId)) { $orphanCount++ } }
    if ($Ctx.Config.onlyEntraPrincipals) {
        Remove-AzureOrphanGrants -Ctx $Ctx -Present $present -OrphanCount $orphanCount
    } else {
        Set-AzureOrphanFlags -Ctx $Ctx -Present $present
    }
}

# Principal stubs (delta upsert only, never scoped-delete the Entra crawler's principals)
# + the capability-resources + the grants.
function Send-AzurePrincipalsAndGrants {
    [CmdletBinding()]
    param([hashtable]$Ctx)
    foreach ($pt in $Ctx.PrincipalStubs.Keys) {
        if ($Ctx.PrincipalStubs[$pt].Count -gt 0) {
            Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $Ctx.SystemId -SyncMode 'delta' -Scope @{ principalType = $pt } -Records $Ctx.PrincipalStubs[$pt] | Out-Null
        }
    }
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $Ctx.SystemId -SyncMode $Ctx.Config.syncMode -Scope @{ resourceType = 'AzureRoleAssignment' } -Records $Ctx.RoleResources | Out-Null
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $Ctx.SystemId -SyncMode $Ctx.Config.syncMode -Scope @{ assignmentType = 'Direct' } -Records $Ctx.Grants | Out-Null
}

# ─── Finalize ────────────────────────────────────────────────────
function Complete-AzureRMRun {
    [CmdletBinding()]
    param([string]$ApiBaseUrl, [string]$ApiKey)
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
    try {
        Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 300 | Out-Null
    } catch {
        Write-Host "  refresh-views failed (non-fatal): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    Update-CrawlerProgress -Step 'Complete' -Pct 100
    Write-Host "`n=== Azure RM crawl complete ===" -ForegroundColor Green
}
