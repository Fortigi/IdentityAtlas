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
$OnlyEntraPrincipals  = if ($null -ne $Cfg.onlyEntraPrincipals) { [bool]$Cfg.onlyEntraPrincipals } else { $true }
$SubscriptionFilter   = if ($Cfg.subscriptionIds) { @($Cfg.subscriptionIds) } else { @() }
$ManagementGroupId    = if ($Cfg.managementGroupId) { [string]$Cfg.managementGroupId } else { $null }

# Round-trip counter (bumped by the request helpers) for the per-phase timing report.
$Global:AzCallCount = 0

# ─── Shared helpers ──────────────────────────────────────────────
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot '..' 'shared' 'Get-CapabilityId.ps1')
# Get-AzureRMHelpers.ps1 (ARM auth + enumeration) and Get-AzureRGHelpers.ps1 (Resource Graph reads)
# are dot-sourced automatically by the dispatcher (same-folder libraries).

# ARM api-versions (pinned). Subscriptions and the management-group hierarchy are still read over the
# ARM REST API — single enumeration calls, not per-subscription fan-out. Resource groups, resources,
# role definitions and role assignments all come from Azure Resource Graph.
$API_SUBS = '2022-12-01'
$API_MG   = '2021-04-01'

# A scope's stable Identity Atlas node id = deterministic UUID of its ARM path.
# ARM resource IDs can legitimately contain '|' (e.g. some Insights / alert resources), which
# Get-CapabilityId reserves as its field separator. Percent-encode '%' then '|' so the id-hash
# input stays injective (no two distinct ARM paths collide) and pipe-free. Only the hash input
# is encoded — the raw armPath / externalId is stored unchanged. Subscription/RG/MG paths never
# contain either character, so their ids are unaffected.
function Get-ScopeNodeId { param([string]$ArmScopePath)
    # Lower-case the path before hashing so the node id is stable regardless of casing. Azure Resource
    # Graph lower-cases every id, and Azure itself is inconsistent about ARM-path casing (a role
    # assignment's properties.scope may read ".../resourceGroups/Foo" while a resource id reads
    # ".../resourcegroups/foo"). Canonicalising here means the same physical scope never splits into
    # two nodes because of casing. Only the hash input is canonicalised; the raw armPath / externalId
    # is still stored as received.
    $safe = $ArmScopePath.ToLowerInvariant() -replace '%', '%25' -replace '\|', '%7C'
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

# Per-phase wall-clock + round-trip report — the call counts make the cross-subscription savings of
# the Resource Graph queries visible (a few paged queries instead of per-subscription fan-out).
function Write-PhaseTiming {
    param([string]$Name, [System.Diagnostics.Stopwatch]$Sw, [int]$CallsBefore)
    Write-Host ("  [timing] {0}: {1:n1}s, {2} Azure call(s)" -f $Name, $Sw.Elapsed.TotalSeconds, ($Global:AzCallCount - $CallsBefore)) -ForegroundColor DarkGray
}

Write-Host "`n=== Azure RM Crawler (Resource Graph) ===" -ForegroundColor Cyan

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

# The Azure resource type (provider namespace + type) parsed out of an ARM resource id, e.g.
# /subscriptions/../resourceGroups/../providers/Microsoft.Compute/virtualMachines/vm1
#   -> "Microsoft.Compute/virtualMachines". Lets the UI/matrix answer "who can touch any VM?".
function Get-AzureResourceType { param([string]$ArmPath)
    if ($ArmPath -match '/providers/(.+)$') {
        $segs = $matches[1] -split '/'              # ns / type / name [ / subtype / subname ... ]
        $parts = @($segs[0])
        for ($i = 1; $i -lt $segs.Count; $i += 2) { $parts += $segs[$i] }   # type segments only
        return ($parts -join '/')
    }
    return ''
}

# Governance/filtering attributes lifted off a resource object (from the Resource Graph resources query):
#   azureLocation              – region, e.g. "westeurope"  -> "access to any resource in West Europe"
#   tag.<Key>                  – each portal tag as its own key -> "access to anything tagged Prio High"
#   managedIdentity            – identity type (SystemAssigned/UserAssigned) when the resource has one
#                                -> the "resources that have a managed identity" context
#   managedIdentityPrincipalId – the system-assigned identity's principal id, soft-linking the resource
#                                to its managed-identity principal (no model change; attribute only)
# Everything here is generic extendedAttributes the context plugins group by — no new core needed.
function Get-ResourceAttributes { param($Resource)
    $ext = @{}
    if ($Resource.location) { $ext['azureLocation'] = [string]$Resource.location }
    if ($Resource.tags) {
        foreach ($p in $Resource.tags.PSObject.Properties) {
            if ($p.Name) { $ext["tag.$($p.Name)"] = [string]$p.Value }
        }
    }
    if ($Resource.identity -and $Resource.identity.type -and $Resource.identity.type -ne 'None') {
        $ext['managedIdentity'] = [string]$Resource.identity.type
        if ($Resource.identity.principalId) { $ext['managedIdentityPrincipalId'] = [string]$Resource.identity.principalId }
    }
    return $ext
}

# helper to register a scope node + (optional) parent edge
function Add-Scope {
    param([string]$ArmPath, [string]$DisplayName, [string]$ResourceType, [string]$ParentArmPath, [string]$ScopeKind, [hashtable]$ExtraExt)
    $nodeId = Get-ScopeNodeId -ArmScopePath $ArmPath
    $ext = @{ armPath = $ArmPath; scopeKind = $ScopeKind; scopeTypeLabel = (Get-ScopeTypeLabel -ScopeKind $ScopeKind) }
    if ($ResourceType -eq 'AzureResource') { $ext['azureResourceType'] = (Get-AzureResourceType -ArmPath $ArmPath) }
    if ($ExtraExt) { foreach ($k in $ExtraExt.Keys) { $ext[$k] = $ExtraExt[$k] } }
    $ScopeResources.Add(@{
        id = $nodeId; displayName = $DisplayName; resourceType = $ResourceType; externalId = $ArmPath
        extendedAttributes = $ext
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
$swDisc = [System.Diagnostics.Stopwatch]::StartNew()
$callsDisc = $Global:AzCallCount

# Subscriptions (auto-discover all accessible, or the configured subset). Always one ARM list call —
# subscription enumeration is not the fan-out problem, and its ids scope the ARG queries below.
$subs = Invoke-ARMList -Path "/subscriptions?api-version=$API_SUBS"
if ($SubscriptionFilter.Count -gt 0) {
    $subs = @($subs | Where-Object { $SubscriptionFilter -contains $_.subscriptionId })
}
$subIds = @($subs | ForEach-Object { [string]$_.subscriptionId })
Write-Host "  $($subs.Count) subscription(s)" -ForegroundColor Gray

# Pull every resource group (and, if requested, every resource) for the whole tenant up front in a
# handful of paged Resource Graph queries, then index them by parent so the loop below does no
# per-subscription / per-resource-group network calls.
$argRgsBySub = @{}
$argResByRg  = @{}
if ($subIds.Count -gt 0) {
    foreach ($rg in (Get-ARGResourceGroups -SubscriptionIds $subIds)) {
        $k = [string]$rg.subscriptionId
        if (-not $argRgsBySub.ContainsKey($k)) { $argRgsBySub[$k] = [System.Collections.Generic.List[object]]::new() }
        $argRgsBySub[$k].Add($rg)
    }
    if ($IncludeResourceLevel) {
        foreach ($r in (Get-ARGResources -SubscriptionIds $subIds)) {
            # Index by the resource's parent resource-group path (lower-cased — Resource Graph ids are
            # already lower-case, and Get-ScopeNodeId canonicalises the same way).
            $rgKey = "/subscriptions/$($r.subscriptionId)/resourcegroups/$($r.resourceGroup)".ToLowerInvariant()
            if (-not $argResByRg.ContainsKey($rgKey)) { $argResByRg[$rgKey] = [System.Collections.Generic.List[object]]::new() }
            $argResByRg[$rgKey].Add($r)
        }
    }
}

foreach ($sub in $subs) {
    $subPath = "/subscriptions/$($sub.subscriptionId)"
    Add-Scope -ArmPath $subPath -DisplayName $sub.displayName -ResourceType 'AzureSubscription' -ParentArmPath $null -ScopeKind 'Subscription' | Out-Null

    $rgs = if ($argRgsBySub.ContainsKey([string]$sub.subscriptionId)) { $argRgsBySub[[string]$sub.subscriptionId] } else { @() }
    foreach ($rg in $rgs) {
        Add-Scope -ArmPath $rg.id -DisplayName $rg.name -ResourceType 'AzureResourceGroup' -ParentArmPath $subPath -ScopeKind 'ResourceGroup' | Out-Null
        if ($IncludeResourceLevel) {
            $rgKey = ([string]$rg.id).ToLowerInvariant()
            $resources = if ($argResByRg.ContainsKey($rgKey)) { $argResByRg[$rgKey] } else { @() }
            foreach ($r in $resources) {
                Add-Scope -ArmPath $r.id -DisplayName $r.name -ResourceType 'AzureResource' -ParentArmPath $rg.id -ScopeKind 'Resource' -ExtraExt (Get-ResourceAttributes -Resource $r) | Out-Null
            }
        }
    }
}
$swDisc.Stop()
Write-PhaseTiming -Name 'scope discovery' -Sw $swDisc -CallsBefore $callsDisc

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
$swDefs = [System.Diagnostics.Stopwatch]::StartNew()
$callsDefs = $Global:AzCallCount
$roleDefs = @{}   # roleDefId (GUID) → @{ name; isCustom; plane }

# Resource Graph returns every visible role definition (built-in catalog included, via AtScopeAndAbove)
# in one paged query. Deduped below by GUID.
$allDefs = if ($ManagementGroupId) { Get-ARGRoleDefinitions -ManagementGroups @($ManagementGroupId) }
           else { Get-ARGRoleDefinitions -SubscriptionIds $subIds }

foreach ($d in $allDefs) {
    $guid = $d.name   # the roleDefinition's GUID
    if (-not $roleDefs.ContainsKey($guid)) {
        $isCustom = ($d.properties.type -eq 'CustomRole')
        if ($isCustom -and -not $IncludeCustomRoles) { continue }
        # Plane classification: control-plane `actions` (manage the resource) vs
        # data-plane `dataActions` (read/write the data inside it). Owner/Contributor
        # are control; "Storage Blob Data Reader", "Key Vault Secrets User" etc. are
        # data. A role can grant both. Lets you ask "who has any data-plane access?".
        $ctlActions  = @($d.properties.permissions | ForEach-Object { $_.actions }     | Where-Object { $_ })
        $dataActions = @($d.properties.permissions | ForEach-Object { $_.dataActions } | Where-Object { $_ })
        $plane = if ($dataActions.Count -gt 0 -and $ctlActions.Count -gt 0) { 'both' }
                 elseif ($dataActions.Count -gt 0) { 'data' } else { 'control' }
        $roleDefs[$guid] = @{ name = $d.properties.roleName; isCustom = $isCustom; plane = $plane }
    }
}
$swDefs.Stop()
Write-Host "  $($roleDefs.Count) role definitions" -ForegroundColor Gray
Write-PhaseTiming -Name 'role definitions' -Sw $swDefs -CallsBefore $callsDefs

# ─── Phase: Role assignments ─────────────────────────────────────
Update-CrawlerProgress -Step 'Fetching role assignments' -Pct 55
$RoleResources   = [System.Collections.Generic.List[object]]::new()  # Role@Scope capability-resources (deduped)
$RoleResSeen     = [System.Collections.Generic.HashSet[string]]::new()
$Grants          = [System.Collections.Generic.List[object]]::new()
$PrincipalStubs  = @{ User = [System.Collections.Generic.List[object]]::new(); ServicePrincipal = [System.Collections.Generic.List[object]]::new() }
$StubSeen        = [System.Collections.Generic.HashSet[string]]::new()

# Scope paths we already built a node for during discovery. Ensure-AssignmentScope adds to this.
$KnownPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($p in $ScopePaths) { [void]$KnownPaths.Add($p) }

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
            $ext = @{ armPath = $ScopePath; scopeKind = $(if ($isRg) { 'ResourceGroup' } else { 'Resource' }); scopeTypeLabel = $(if ($isRg) { 'RG' } else { 'Res' }) }
            if (-not $isRg) { $ext['azureResourceType'] = (Get-AzureResourceType -ArmPath $ScopePath) }
            $ScopeResources.Add(@{
                id = (Get-ScopeNodeId -ArmScopePath $ScopePath)
                displayName = ($ScopePath -split '/')[-1]
                resourceType = $(if ($isRg) { 'AzureResourceGroup' } else { 'AzureResource' })
                externalId = $ScopePath
                extendedAttributes = $ext
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

# Every role assignment is stored at its OWN declared scope (properties.scope); the engine computes
# inheritance on demand from the Contains hierarchy — we never materialise an inherited assignment as
# Direct on the scopes below it.
$swAssign = [System.Diagnostics.Stopwatch]::StartNew()
$callsAssign = $Global:AzCallCount

# Fetch every assignment once (AtScopeAboveAndBelow, so management-group / tenant-root rows come too),
# then rebuild each subscription's "visible set": an assignment in a subscription's own subtree is seen
# only by that subscription; one declared at a management-group ancestor is seen by every subscription
# beneath that MG; one at the tenant root ('/') by all. Driving the per-subscription loop below this
# way produces the scope nodes, grants AND the implicit management-group → subscription Contains edges.
$argAssignBySub = @{}
if ($subIds.Count -gt 0) {
    $allAssign = Get-ARGRoleAssignments -SubscriptionIds $subIds
    $mgChains  = Get-ARGSubscriptionMgChains -SubscriptionIds $subIds   # subId → [mg ancestor ids]
    $subsByMg  = @{}
    foreach ($sid in $subIds) {
        foreach ($mg in @($mgChains[$sid])) {
            $mgKey = ([string]$mg).ToLowerInvariant()
            if (-not $subsByMg.ContainsKey($mgKey)) { $subsByMg[$mgKey] = [System.Collections.Generic.List[string]]::new() }
            $subsByMg[$mgKey].Add($sid)
        }
    }
    foreach ($sid in $subIds) { $argAssignBySub[([string]$sid).ToLowerInvariant()] = [System.Collections.Generic.List[object]]::new() }
    foreach ($a in $allAssign) {
        $scope = [string]$a.properties.scope
        if ($scope -match '^/subscriptions/([^/]+)') {
            $owner = $matches[1].ToLowerInvariant()
            if ($argAssignBySub.ContainsKey($owner)) { $argAssignBySub[$owner].Add($a) }
        } elseif ($scope -eq '/') {
            foreach ($k in $argAssignBySub.Keys) { $argAssignBySub[$k].Add($a) }
        } elseif ($scope -match '^/providers/[Mm]icrosoft\.[Mm]anagement/managementGroups/([^/]+)') {
            $mgKey = $matches[1].ToLowerInvariant()
            if ($subsByMg.ContainsKey($mgKey)) {
                foreach ($sid in $subsByMg[$mgKey]) { $argAssignBySub[([string]$sid).ToLowerInvariant()].Add($a) }
            }
        }
    }
}

$assignSeen = [System.Collections.Generic.HashSet[string]]::new()
foreach ($sub in $subs) {
    $subPath = "/subscriptions/$($sub.subscriptionId)"
    $sk = ([string]$sub.subscriptionId).ToLowerInvariant()
    $assignments = if ($argAssignBySub.ContainsKey($sk)) { $argAssignBySub[$sk] } else { @() }
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
                extendedAttributes = @{ capabilityId = $roleDefId; targetNodeId = $scopeNodeId; roleName = $roleName; isCustom = $roleDefs[$roleDefId].isCustom; plane = $roleDefs[$roleDefId].plane }
            })
        }

        $pType = [string]$a.properties.principalType
        # Assignment-level governance attributes: the ABAC condition (so a conditional grant reads as
        # conditional, not blanket access) and provenance (who created the assignment, and when).
        $aExt = @{ roleAssignmentId = $a.name }
        if ($a.properties.condition) {
            $aExt['condition'] = [string]$a.properties.condition
            if ($a.properties.conditionVersion) { $aExt['conditionVersion'] = [string]$a.properties.conditionVersion }
        }
        if ($a.properties.createdOn) { $aExt['createdOn'] = [string]$a.properties.createdOn }
        if ($a.properties.createdBy) { $aExt['createdBy'] = [string]$a.properties.createdBy }
        $Grants.Add(@{
            resourceId = $capResId; principalId = [string]$a.properties.principalId; assignmentType = 'Direct'
            effect = 'allow'; propagationScope = 'selfAndDescendants'; principalType = $pType
            extendedAttributes = $aExt
        })

        # Thin principal stubs for User / ServicePrincipal. Groups are Resources (synced by the
        # Entra crawler) — referenced by id, not stubbed here.
        if ($pType -in @('User', 'ServicePrincipal') -and $StubSeen.Add([string]$a.properties.principalId)) {
            $stub = @{ id = [string]$a.properties.principalId; accountEnabled = $true }
            # Only assert principalType for Users. Azure RBAC labels every workload identity
            # 'ServicePrincipal', so asserting it on a delta upsert would overwrite the Entra crawler's
            # finer ManagedIdentity / AIAgent classification (COALESCE keeps the incoming non-null) and
            # break the Managed Identities context. Leave workload-identity typing to the Entra crawler.
            if ($pType -eq 'User') { $stub['principalType'] = 'User' }
            $PrincipalStubs[$pType].Add($stub)
        }
    }
}
$swAssign.Stop()
Write-Host "  $($RoleResources.Count) role-at-scope resources, $($Grants.Count) assignments" -ForegroundColor Gray
Write-PhaseTiming -Name 'role assignments' -Sw $swAssign -CallsBefore $callsAssign

# The assignment phase may have added management-group / resource scope nodes on demand, so dedup the
# scope nodes + Contains edges now — before the capability-resources and grants that reference them.
# Dedup by primary key — the ingest engine's ON CONFLICT can't touch a row twice.
$sSeen = [System.Collections.Generic.HashSet[string]]::new()
$ScopeResources = @($ScopeResources | Where-Object { $sSeen.Add([string]$_.id) })
$eSeen = [System.Collections.Generic.HashSet[string]]::new()
$ContainsEdges = @($ContainsEdges | Where-Object { $eSeen.Add("$($_.parentResourceId)|$($_.childResourceId)|$($_.relationshipType)") })
# Dedup grants on their PK (resourceId, principalId, assignmentType) — Azure can declare the same
# principal+role at one scope more than once, which would touch the same upsert row twice.
$gSeen = [System.Collections.Generic.HashSet[string]]::new()
$Grants = @($Grants | Where-Object { $gSeen.Add("$($_.resourceId)|$($_.principalId)|$($_.assignmentType)") })
Write-Host "  $($ScopeResources.Count) scope nodes, $($ContainsEdges.Count) Contains edges (final)" -ForegroundColor Gray

Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ resourceType = 'AzureScope' } -Records $ScopeResources | Out-Null
Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ relationshipType = 'Contains' } -Records $ContainsEdges | Out-Null

# ─── Orphan handling: principals the Entra ID crawler hasn't loaded ─────────────
# Azure RBAC assignments can reference principals the Entra crawler hasn't loaded —
# deleted SPs with dangling assignments, or (when the Entra crawl is scoped, e.g. to
# admins) principals intentionally out of scope. Resolve each holder against the
# crawler's Entra data; ON (default) drops them so they don't surface, OFF keeps them
# but flags the principal as orphaned. A tenant with no Entra data yet is left untouched.
$distinctPids = @($Grants | ForEach-Object { [string]$_.principalId } | Sort-Object -Unique)
if ($distinctPids.Count -gt 0) {
    $lookup = Invoke-IngestAPI -Endpoint 'ingest/principals-presence' -Body @{ tenantId = [string]$Cfg.tenantId; ids = $distinctPids }
    if (-not $lookup.crawlerDataAvailable) {
        Write-Host "  No Entra ID data loaded by the crawler for this tenant yet — skipping orphan handling (run the Entra ID crawler first)." -ForegroundColor Yellow
    } else {
        $present = [System.Collections.Generic.HashSet[string]]::new([string[]]@($lookup.present), [System.StringComparer]::OrdinalIgnoreCase)
        $orphanCount = 0
        foreach ($objId in $distinctPids) { if (-not $present.Contains($objId)) { $orphanCount++ } }

        if ($OnlyEntraPrincipals) {
            # Drop grants + stubs for principals not in the directory, then prune the
            # role-at-scope resources nobody holds anymore. The full sync removes any
            # previously-loaded orphan assignments from the database.
            $before = $Grants.Count
            $Grants = @($Grants | Where-Object { $present.Contains([string]$_.principalId) })
            foreach ($pt in @($PrincipalStubs.Keys)) {
                $kept = [System.Collections.Generic.List[object]]::new()
                foreach ($stub in $PrincipalStubs[$pt]) { if ($present.Contains([string]$stub.id)) { $kept.Add($stub) } }
                $PrincipalStubs[$pt] = $kept
            }
            $keptCaps = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($g in $Grants) { [void]$keptCaps.Add([string]$g.resourceId) }
            $RoleResources = @($RoleResources | Where-Object { $keptCaps.Contains([string]$_.id) })
            Write-Host "  Orphan filter ON: dropped $($before - $Grants.Count) assignment(s) for $orphanCount principal(s) not in Entra ID." -ForegroundColor Gray
        } else {
            # Flag the orphan stubs; leave assignments as-is.
            $tagged = 0
            foreach ($pt in $PrincipalStubs.Keys) {
                foreach ($stub in $PrincipalStubs[$pt]) {
                    if (-not $present.Contains([string]$stub.id)) {
                        if (-not $stub.ContainsKey('extendedAttributes')) { $stub['extendedAttributes'] = @{} }
                        $stub['extendedAttributes']['directoryStatus'] = 'orphaned'
                        $tagged++
                    }
                }
            }
            Write-Host "  Orphan flag OFF: tagged $tagged principal(s) not in Entra ID as 'orphaned' (assignments kept)." -ForegroundColor Gray
        }
    }
}

# Stubs use delta (upsert-only) so they never scoped-delete principals the Entra crawler owns.
foreach ($pt in $PrincipalStubs.Keys) {
    if ($PrincipalStubs[$pt].Count -gt 0) {
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode 'delta' -Scope @{ principalType = $pt } -Records $PrincipalStubs[$pt] | Out-Null
    }
}
Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ resourceType = 'AzureRoleAssignment' } -Records $RoleResources | Out-Null
Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode $SyncMode -Scope @{ assignmentType = 'Direct' } -Records $Grants | Out-Null

# Contexts are NOT emitted here — they are derived data. Context trees (scope hierarchy, resource
# type) are generated by context-algorithm plugins from the scope Resources + Contains edges this
# crawler emits, keeping the crawler to source data only.

# ─── Refresh views (also bumps the effective-access cache version) ──
Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
try {
    Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/refresh-views" -Method Post -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 300 | Out-Null
} catch {
    Write-Host "  refresh-views failed (non-fatal): $($_.Exception.Message)" -ForegroundColor Yellow
}

Update-CrawlerProgress -Step 'Complete' -Pct 100
Write-Host "`n=== Azure RM crawl complete ===" -ForegroundColor Green
