<#
.SYNOPSIS
    Sync Azure Resource Manager RBAC into Identity Atlas via the Ingest API.

.DESCRIPTION
    Emits the Azure scope hierarchy (management groups → subscriptions → resource groups →
    optionally resources) as Resources linked by `Contains` relationships, plus one synthetic
    "<role> @ <scope>" capability-resource per declared role assignment, with the assignment
    itself. Inheritance (a role at a parent scope applying to descendants) is NOT materialised —
    the effective-access engine computes it on demand from the Contains hierarchy.

    Auth: service-principal client-credentials against management.azure.com (reuses
    Get-FGAccessToken). Reader at the crawled scope is sufficient.

    See docs/sync/building-a-crawler.md → "Feeding the Effective-Access Engine".
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

$Cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$SyncMode = if ($Cfg._syncMode -in @('full', 'delta')) { $Cfg._syncMode } else { 'full' }
$IncludeResourceLevel = [bool]$Cfg.includeResourceLevel
$IncludeCustomRoles   = if ($null -ne $Cfg.includeCustomRoles) { [bool]$Cfg.includeCustomRoles } else { $true }
$SubscriptionFilter   = if ($Cfg.subscriptionIds) { @($Cfg.subscriptionIds) } else { @() }
$ManagementGroupId    = if ($Cfg.managementGroupId) { [string]$Cfg.managementGroupId } else { $null }

# ─── Shared helpers ──────────────────────────────────────────────
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot '..' 'shared' 'Get-CapabilityId.ps1')
# Get-AzureRMHelpers.ps1 is dot-sourced automatically by the dispatcher (same-folder library).

# ARM api-versions (pinned).
$API_SUBS    = '2022-12-01'
$API_RG      = '2021-04-01'
$API_RES     = '2021-04-01'
$API_MG      = '2021-04-01'
$API_AUTH    = '2022-04-01'   # roleAssignments + roleDefinitions

# A scope's stable Identity Atlas node id = deterministic UUID of its ARM path.
# ARM resource IDs can legitimately contain '|' (e.g. some Insights / alert resources), which
# Get-CapabilityId reserves as its field separator. Percent-encode '%' then '|' so the id-hash
# input stays injective (no two distinct ARM paths collide) and pipe-free. Only the hash input
# is encoded — the raw armPath / externalId is stored unchanged. Subscription/RG/MG paths never
# contain either character, so their ids are unaffected.
function Get-ScopeNodeId { param([string]$ArmScopePath)
    $safe = $ArmScopePath -replace '%', '%25' -replace '\|', '%7C'
    Get-CapabilityId -TargetNodeId $safe -CapabilityId 'azure-scope'
}

function Send-IngestBatch {
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode = 'full',
        [hashtable]$Scope = @{},
        [array]$Records = @()
    )
    if (-not $Records -or $Records.Count -eq 0) {
        return Invoke-IngestAPI -Endpoint $Endpoint -Body @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = @() }
    }
    $body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = ConvertTo-JsonArray $Records }
    Invoke-IngestAPI -Endpoint $Endpoint -Body $body
}

Write-Host "`n=== Azure RM Crawler ===" -ForegroundColor Cyan

# ─── Connectivity + auth ─────────────────────────────────────────
Update-CrawlerProgress -Step 'Authenticating to Azure RM' -Pct 2
Connect-AzureRM -TenantId $Cfg.tenantId -ClientId $Cfg.clientId -ClientSecret $Cfg.clientSecret

# ─── Register system ─────────────────────────────────────────────
$sysResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
    syncMode = 'delta'
    records  = @(@{ systemType = 'AzureRM'; displayName = "Azure RM ($($Cfg.tenantId))"; tenantId = [string]$Cfg.tenantId; enabled = $true; syncEnabled = $true })
}
$SystemId = if ($sysResult.systemIds -and $sysResult.systemIds.Count -gt 0) { [int]$sysResult.systemIds[0] } else { 1 }
Write-Host "  System ID: $SystemId" -ForegroundColor Green

# Accumulators
$ScopeResources = [System.Collections.Generic.List[object]]::new()   # scope nodes
$ContainsEdges  = [System.Collections.Generic.List[object]]::new()   # scope → child scope
$ScopeContexts  = [System.Collections.Generic.List[object]]::new()   # MG/Subscription contexts
$ScopePaths     = [System.Collections.Generic.List[string]]::new()   # all ARM scope paths to read assignments at

# Short type label shown in capability names ("Owner @ RG: name") and stored on the scope node so
# the effective-access engine labels synthesized inherited rows the same way.
function Get-ScopeTypeLabel { param([string]$ScopeKind)
    switch ($ScopeKind) {
        'ManagementGroup' { 'MG' }
        'Subscription'    { 'Sub' }
        'ResourceGroup'   { 'RG' }
        'Resource'        { 'Res' }
        default { '' }
    }
}

# helper to register a scope node + (optional) parent edge
function Add-Scope {
    param([string]$ArmPath, [string]$DisplayName, [string]$ResourceType, [string]$ParentArmPath, [string]$ScopeKind)
    $nodeId = Get-ScopeNodeId -ArmScopePath $ArmPath
    $ScopeResources.Add(@{
        id = $nodeId; displayName = $DisplayName; resourceType = $ResourceType; externalId = $ArmPath
        extendedAttributes = @{ armPath = $ArmPath; scopeKind = $ScopeKind; scopeTypeLabel = (Get-ScopeTypeLabel -ScopeKind $ScopeKind) }
    })
    if ($ParentArmPath) {
        $ContainsEdges.Add(@{
            parentResourceId = (Get-ScopeNodeId -ArmScopePath $ParentArmPath)
            childResourceId  = $nodeId
            relationshipType = 'Contains'
            extendedAttributes = @{ propagates = $true }
        })
    }
    $ScopePaths.Add($ArmPath)
    return $nodeId
}

# ─── Phase: Scope discovery ──────────────────────────────────────
Update-CrawlerProgress -Step 'Discovering scopes' -Pct 8

# Subscriptions (auto-discover all accessible, or the configured subset).
$subs = Invoke-ARMList -Path "/subscriptions?api-version=$API_SUBS"
if ($SubscriptionFilter.Count -gt 0) {
    $subs = @($subs | Where-Object { $SubscriptionFilter -contains $_.subscriptionId })
}
Write-Host "  $($subs.Count) subscription(s)" -ForegroundColor Gray

foreach ($sub in $subs) {
    $subPath = "/subscriptions/$($sub.subscriptionId)"
    Add-Scope -ArmPath $subPath -DisplayName $sub.displayName -ResourceType 'AzureSubscription' -ParentArmPath $null -ScopeKind 'Subscription' | Out-Null
    # Subscription as a Context (filterable dimension).
    $ScopeContexts.Add(@{
        id = (Get-ScopeNodeId -ArmScopePath $subPath); externalId = $subPath; displayName = $sub.displayName
        contextType = 'AzureSubscription'; variant = 'synced'; targetType = 'Resource'
    })

    # Resource groups.
    $rgs = Invoke-ARMList -Path "$subPath/resourcegroups?api-version=$API_RG"
    foreach ($rg in $rgs) {
        Add-Scope -ArmPath $rg.id -DisplayName $rg.name -ResourceType 'AzureResourceGroup' -ParentArmPath $subPath -ScopeKind 'ResourceGroup' | Out-Null
        if ($IncludeResourceLevel) {
            $resources = Invoke-ARMList -Path "$($rg.id)/resources?api-version=$API_RES"
            foreach ($r in $resources) {
                Add-Scope -ArmPath $r.id -DisplayName $r.name -ResourceType 'AzureResource' -ParentArmPath $rg.id -ScopeKind 'Resource' | Out-Null
            }
        }
    }
}

# Management groups (only when explicitly configured — walks the tree beneath it).
if ($ManagementGroupId) {
    Update-CrawlerProgress -Step 'Discovering management groups' -Pct 14
    $mgRoot = Invoke-ARMGet -Path "/providers/Microsoft.Management/managementGroups/$ManagementGroupId`?api-version=$API_MG&`$expand=children&`$recurse=true"
    # Recursive walk of the MG tree; each MG/subscription child links to its parent.
    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push(@{ node = $mgRoot; parentPath = $null })
    while ($stack.Count -gt 0) {
        $cur = $stack.Pop(); $node = $cur.node
        $path = $node.id
        if ($node.type -eq 'Microsoft.Management/managementGroups' -or $node.type -eq '/providers/Microsoft.Management/managementGroups') {
            $name = if ($node.properties.displayName) { $node.properties.displayName } else { $node.name }
            Add-Scope -ArmPath $path -DisplayName $name -ResourceType 'AzureManagementGroup' -ParentArmPath $cur.parentPath -ScopeKind 'ManagementGroup' | Out-Null
            $ScopeContexts.Add(@{ id = (Get-ScopeNodeId -ArmScopePath $path); externalId = $path; displayName = $name; contextType = 'AzureManagementGroup'; variant = 'synced'; targetType = 'Resource' })
            foreach ($child in @($node.properties.children)) { $stack.Push(@{ node = $child; parentPath = $path }) }
        } elseif ($node.type -match 'subscriptions') {
            # Link an already-discovered subscription to this MG parent (edge only).
            $subPath = "/subscriptions/$($node.name)"
            if ($ScopePaths -contains $subPath -and $cur.parentPath) {
                $ContainsEdges.Add(@{ parentResourceId = (Get-ScopeNodeId -ArmScopePath $cur.parentPath); childResourceId = (Get-ScopeNodeId -ArmScopePath $subPath); relationshipType = 'Contains'; extendedAttributes = @{ propagates = $true } })
            }
        }
    }
}

Write-Host "  $($ScopeResources.Count) scope nodes, $($ContainsEdges.Count) Contains edges (pre-assignment)" -ForegroundColor Gray
# Scope nodes + Contains edges are deduped and ingested AFTER the assignment phase below: that phase
# adds management-group / resource scope nodes on demand, because an assignment's real declared scope
# can sit above (a management group / tenant root) or below (an individual resource) what we
# enumerated here.

# ─── Phase: Role definitions ─────────────────────────────────────
Update-CrawlerProgress -Step 'Fetching role definitions' -Pct 35
# Role definitions are visible at any subscription scope; fetch once per subscription and merge.
$roleDefs = @{}   # roleDefId (GUID) → @{ name; isCustom }
foreach ($sub in $subs) {
    $defs = Invoke-ARMList -Path "/subscriptions/$($sub.subscriptionId)/providers/Microsoft.Authorization/roleDefinitions?api-version=$API_AUTH"
    foreach ($d in $defs) {
        $guid = $d.name   # the roleDefinition's GUID
        if (-not $roleDefs.ContainsKey($guid)) {
            $isCustom = ($d.properties.type -eq 'CustomRole')
            if ($isCustom -and -not $IncludeCustomRoles) { continue }
            $roleDefs[$guid] = @{ name = $d.properties.roleName; isCustom = $isCustom }
        }
    }
}
Write-Host "  $($roleDefs.Count) role definitions" -ForegroundColor Gray

# ─── Phase: Role assignments ─────────────────────────────────────
Update-CrawlerProgress -Step 'Fetching role assignments' -Pct 55
$RoleResources   = [System.Collections.Generic.List[object]]::new()  # Role@Scope capability-resources (deduped)
$RoleResSeen     = [System.Collections.Generic.HashSet[string]]::new()
$Grants          = [System.Collections.Generic.List[object]]::new()
$PrincipalStubs  = @{ User = [System.Collections.Generic.List[object]]::new(); ServicePrincipal = [System.Collections.Generic.List[object]]::new() }
$StubSeen        = [System.Collections.Generic.HashSet[string]]::new()
$ContextMembers  = [System.Collections.Generic.List[object]]::new()

# Map a scope ARM path to the subscription/MG context it belongs to (for ContextMembers).
function Get-OwningContextNodeId { param([string]$ArmPath)
    if ($ArmPath -match '^(/providers/Microsoft\.Management/managementGroups/[^/]+)') { return Get-ScopeNodeId -ArmScopePath $matches[1] }
    if ($ArmPath -match '^(/subscriptions/[^/]+)') { return Get-ScopeNodeId -ArmScopePath $matches[1] }
    return $null
}

# Scope paths we already built a node for during discovery. Ensure-AssignmentScope adds to this.
$KnownPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($p in $ScopePaths) { [void]$KnownPaths.Add($p) }

# Contexts exist only for scopes we discovered (subscriptions, plus management groups in MG mode).
# A Role@Scope resource at an on-demand management-group node has no context, so gate membership on
# the context actually existing — otherwise ContextMembers hits a foreign-key violation.
$ContextIds = [System.Collections.Generic.HashSet[string]]::new()
foreach ($c in $ScopeContexts) { [void]$ContextIds.Add([string]$c.id) }

function Add-ContainsEdge { param([string]$ParentPath, [string]$ChildPath)
    $ContainsEdges.Add(@{
        parentResourceId = (Get-ScopeNodeId -ArmScopePath $ParentPath)
        childResourceId  = (Get-ScopeNodeId -ArmScopePath $ChildPath)
        relationshipType = 'Contains'; extendedAttributes = @{ propagates = $true }
    })
}

# Parent of a sub-subscription scope: a resource → its resource group, a resource group → its
# subscription, a subscription-level resource → its subscription. $null for subscription / management
# group / tenant-root scopes (those are handled as "above the subscription").
function Get-ParentScopePath { param([string]$ScopePath)
    if ($ScopePath -match '^(/subscriptions/[^/]+/resourceGroups/[^/]+)/providers/') { return $matches[1] }
    if ($ScopePath -match '^(/subscriptions/[^/]+)/resourceGroups/[^/]+$')           { return $matches[1] }
    if ($ScopePath -match '^(/subscriptions/[^/]+)/providers/')                       { return $matches[1] }
    return $null
}

# Resolve a management group's friendly display name (cached). On-demand MG nodes would otherwise
# show only their bare id (a GUID for the tenant root), which is opaque in the matrix.
$mgNameCache = @{}
function Get-MgDisplayName { param([string]$MgId)
    if ($mgNameCache.ContainsKey($MgId)) { return $mgNameCache[$MgId] }
    $name = $MgId
    try {
        $mg = Invoke-ARMGet -Path "/providers/Microsoft.Management/managementGroups/$MgId`?api-version=$API_MG"
        if ($mg.properties.displayName) { $name = [string]$mg.properties.displayName }
    } catch { }
    $mgNameCache[$MgId] = $name
    return $name
}

# Ensure a scope node exists for an assignment's declared scope, creating it (and any missing
# ancestors) so the effective-access engine can inherit through the Contains hierarchy. Management
# groups / the tenant root sit above the subscription, so we link them down to the owning
# subscription. Returns the scope node id.
function Ensure-AssignmentScope { param([string]$ScopePath, [string]$OwningSubPath)
    $aboveSub = ($ScopePath -eq '/' -or $ScopePath -match '^/providers/Microsoft\.Management/managementGroups/')
    if (-not $KnownPaths.Contains($ScopePath)) {
        if ($aboveSub) {
            $isRoot = ($ScopePath -eq '/')
            $ScopeResources.Add(@{
                id = (Get-ScopeNodeId -ArmScopePath $ScopePath)
                displayName = $(if ($isRoot) { 'Tenant Root' } else { Get-MgDisplayName -MgId (($ScopePath -split '/')[-1]) })
                resourceType = $(if ($isRoot) { 'AzureScope' } else { 'AzureManagementGroup' })
                externalId = $ScopePath
                extendedAttributes = @{ armPath = $ScopePath; scopeKind = $(if ($isRoot) { 'Root' } else { 'ManagementGroup' }); scopeTypeLabel = $(if ($isRoot) { 'Root' } else { 'MG' }) }
            })
        } else {
            $parentPath = Get-ParentScopePath -ScopePath $ScopePath
            $isRg = ($ScopePath -match '^/subscriptions/[^/]+/resourceGroups/[^/]+$')
            $ScopeResources.Add(@{
                id = (Get-ScopeNodeId -ArmScopePath $ScopePath)
                displayName = ($ScopePath -split '/')[-1]
                resourceType = $(if ($isRg) { 'AzureResourceGroup' } else { 'AzureResource' })
                externalId = $ScopePath
                extendedAttributes = @{ armPath = $ScopePath; scopeKind = $(if ($isRg) { 'ResourceGroup' } else { 'Resource' }); scopeTypeLabel = $(if ($isRg) { 'RG' } else { 'Res' }) }
            })
            if ($parentPath) {
                [void](Ensure-AssignmentScope -ScopePath $parentPath -OwningSubPath $OwningSubPath)
                Add-ContainsEdge -ParentPath $parentPath -ChildPath $ScopePath
            }
        }
        [void]$KnownPaths.Add($ScopePath)
    }
    # Always (re)link a management group / tenant root to the owning subscription so its assignments
    # inherit into every crawled subscription beneath it (edges are deduped before ingest).
    if ($aboveSub -and $OwningSubPath) { Add-ContainsEdge -ParentPath $ScopePath -ChildPath $OwningSubPath }
    return Get-ScopeNodeId -ArmScopePath $ScopePath
}

# One un-filtered roleAssignments list per subscription returns every assignment in that
# subscription's subtree PLUS those inherited from above (management groups / tenant root). We store
# each at its OWN declared scope (properties.scope) and let the engine compute inheritance — never
# materialising an inherited assignment as Direct on the scopes below it. (atScope() is NOT used: it
# means "effective at this scope", i.e. this scope AND everything inherited from above.)
$assignSeen = [System.Collections.Generic.HashSet[string]]::new()
foreach ($sub in $subs) {
    $subPath = "/subscriptions/$($sub.subscriptionId)"
    $assignments = Invoke-ARMList -Path "$subPath/providers/Microsoft.Authorization/roleAssignments?api-version=$API_AUTH"
    foreach ($a in $assignments) {
        $declaredScope = [string]$a.properties.scope
        if (-not $declaredScope) { continue }
        $roleDefId = ($a.properties.roleDefinitionId -split '/')[-1]
        if (-not $roleDefs.ContainsKey($roleDefId)) { continue }   # filtered (e.g. custom role with includeCustomRoles=false)

        # Ensure the scope node exists for THIS subscription's view (re-adds management-group → sub
        # edges even when the assignment itself was already processed via another subscription).
        $scopeNodeId = Ensure-AssignmentScope -ScopePath $declaredScope -OwningSubPath $subPath
        if (-not $assignSeen.Add([string]$a.name)) { continue }   # same Azure assignment seen via another sub

        $roleName = $roleDefs[$roleDefId].name
        $capResId = Get-CapabilityId -TargetNodeId $scopeNodeId -CapabilityId $roleDefId
        if ($RoleResSeen.Add($capResId)) {
            $scopeRes = $ScopeResources | Where-Object { $_.id -eq $scopeNodeId } | Select-Object -First 1
            $scopeName = $scopeRes.displayName
            $scopeLabel = $scopeRes.extendedAttributes.scopeTypeLabel
            $dn = if ($scopeLabel) { "$roleName @ ${scopeLabel}: $scopeName" } else { "$roleName @ $scopeName" }
            $RoleResources.Add(@{
                id = $capResId; displayName = $dn; resourceType = 'AzureRoleAssignment'; enabled = $true
                extendedAttributes = @{ capabilityId = $roleDefId; targetNodeId = $scopeNodeId; roleName = $roleName; isCustom = $roleDefs[$roleDefId].isCustom }
            })
            # Role@Scope resources count toward the owning subscription/MG context.
            $ctxNode = Get-OwningContextNodeId -ArmPath $declaredScope
            if ($ctxNode -and $ContextIds.Contains($ctxNode)) { $ContextMembers.Add(@{ contextId = $ctxNode; memberId = $capResId; memberType = 'Resource'; addedBy = 'sync' }) }
        }

        $pType = [string]$a.properties.principalType
        $Grants.Add(@{
            resourceId = $capResId; principalId = [string]$a.properties.principalId; assignmentType = 'Direct'
            effect = 'allow'; propagationScope = 'selfAndDescendants'; principalType = $pType
            extendedAttributes = @{ roleAssignmentId = $a.name }
        })

        # Thin principal stubs for User / ServicePrincipal. Groups are Resources (synced by the
        # Entra crawler) — referenced by id, not stubbed here.
        if ($pType -in @('User', 'ServicePrincipal') -and $StubSeen.Add([string]$a.properties.principalId)) {
            $PrincipalStubs[$pType].Add(@{ id = [string]$a.properties.principalId; principalType = $pType; accountEnabled = $true })
        }
    }
}
Write-Host "  $($RoleResources.Count) role-at-scope resources, $($Grants.Count) assignments" -ForegroundColor Gray

# The assignment phase may have added management-group / resource scope nodes on demand, so dedup and
# ingest the scope nodes + Contains edges now — before the capability-resources and grants below that
# reference them. Dedup by primary key — the ingest engine's ON CONFLICT can't touch a row twice.
$sSeen = [System.Collections.Generic.HashSet[string]]::new()
$ScopeResources = @($ScopeResources | Where-Object { $sSeen.Add([string]$_.id) })
$eSeen = [System.Collections.Generic.HashSet[string]]::new()
$ContainsEdges = @($ContainsEdges | Where-Object { $eSeen.Add("$($_.parentResourceId)|$($_.childResourceId)|$($_.relationshipType)") })
Write-Host "  $($ScopeResources.Count) scope nodes, $($ContainsEdges.Count) Contains edges (final)" -ForegroundColor Gray
Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ resourceType = 'AzureScope' } -Records $ScopeResources | Out-Null
Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ relationshipType = 'Contains' } -Records $ContainsEdges | Out-Null

# Stubs use delta (upsert-only) so they never scoped-delete principals the Entra crawler owns.
foreach ($pt in $PrincipalStubs.Keys) {
    if ($PrincipalStubs[$pt].Count -gt 0) {
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode 'delta' -Scope @{ principalType = $pt } -Records $PrincipalStubs[$pt] | Out-Null
    }
}
Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ resourceType = 'AzureRoleAssignment' } -Records $RoleResources | Out-Null
# Dedup grants on their PK (resourceId, principalId, assignmentType) — Azure can declare the same
# principal+role at one scope more than once, which would touch the same upsert row twice.
$gSeen = [System.Collections.Generic.HashSet[string]]::new()
$Grants = @($Grants | Where-Object { $gSeen.Add("$($_.resourceId)|$($_.principalId)|$($_.assignmentType)") })
Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ assignmentType = 'Direct' } -Records $Grants | Out-Null

# ─── Phase: Contexts ─────────────────────────────────────────────
Update-CrawlerProgress -Step 'Syncing contexts' -Pct 80
$ctxSeen = [System.Collections.Generic.HashSet[string]]::new()
$ScopeContexts = @($ScopeContexts | Where-Object { $ctxSeen.Add([string]$_.id) })
Send-IngestBatch -Endpoint 'ingest/contexts' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ variant = 'synced' } -Records $ScopeContexts | Out-Null
# Deduplicate context members (a scope can be touched by multiple assignments).
$cmSeen = [System.Collections.Generic.HashSet[string]]::new()
$cmDedup = @($ContextMembers | Where-Object { $cmSeen.Add("$($_.contextId)|$($_.memberId)") })
Send-IngestBatch -Endpoint 'ingest/context-members' -SystemId $SystemId -SyncMode $SyncMode -Records $cmDedup | Out-Null

# ─── Refresh views (also bumps the effective-access cache version) ──
Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
try {
    Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 300 | Out-Null
} catch {
    Write-Host "  refresh-views failed (non-fatal): $($_.Exception.Message)" -ForegroundColor Yellow
}

Update-CrawlerProgress -Step 'Complete' -Pct 100
Write-Host "`n=== Azure RM crawl complete ===" -ForegroundColor Green
