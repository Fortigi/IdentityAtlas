<#
.SYNOPSIS
    Reusable Azure RM crawler helper functions, extracted from Start-AzureRMCrawler.ps1.

.DESCRIPTION
    These functions are dot-sourced into Start-AzureRMCrawler.ps1's own scope, which
    is equivalent to defining them inline. The pure/standalone helpers were moved
    here so they can be unit-tested in isolation with Pester
    (see test/unit/AzureRMCrawlerFunctions.Tests.ps1). Function bodies are unchanged
    from their original inline definitions.

    The state-coupled Main helpers (Add-Scope, Add-ContainsEdge, Get-MgDisplayName,
    Ensure-AssignmentScope) stay inline in Start-AzureRMCrawler.ps1 because they
    mutate the crawler's scope-level accumulators ($ScopeResources, $ContainsEdges,
    $ScopePaths, $KnownPaths, $mgNameCache).

    Get-ScopeNodeId calls Get-CapabilityId from tools/crawlers/shared/Get-CapabilityId.ps1;
    Send-IngestBatch calls Invoke-IngestAPI / ConvertTo-JsonArray from
    tools/crawlers/shared/Invoke-CrawlerIngest.ps1 — dot-source those files too.
#>

# A scope's stable Identity Atlas node id = deterministic UUID of its ARM path.
# ARM resource IDs can legitimately contain '|' (e.g. some Insights / alert resources), which
# Get-CapabilityId reserves as its field separator. Percent-encode '%' then '|' so the id-hash
# input stays injective (no two distinct ARM paths collide) and pipe-free. Only the hash input
# is encoded — the raw armPath / externalId is stored unchanged. Subscription/RG/MG paths never
# contain either character, so their ids are unaffected.
function Get-ScopeNodeId {
    [CmdletBinding()]
    param([string]$ArmScopePath)
    # Lower-case the path before hashing so the node id is stable regardless of casing. Azure Resource
    # Graph lower-cases every id, and Azure itself is inconsistent about ARM-path casing (a role
    # assignment's properties.scope may read ".../resourceGroups/Foo" while a resource id reads
    # ".../resourcegroups/foo"). Canonicalising here means the same physical scope never splits into
    # two nodes because of casing. Only the hash input is canonicalised; the raw armPath / externalId
    # is still stored as received.
    $safe = $ArmScopePath.ToLowerInvariant() -replace '%', '%25' -replace '\|', '%7C'
    Get-CapabilityId -TargetNodeId $safe -CapabilityId 'azure-scope'
}

# Thin adapter over the shared Invoke-CrawlerIngestBatch (tools/crawlers/shared/
# Invoke-CrawlerIngest.ps1). Azure RM sends small batches, so the shared chunking
# never triggers; an empty batch is still sent as a full sync (no -SkipWhenEmpty).
function Send-IngestBatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode = 'full',
        [hashtable]$Scope = @{},
        [array]$Records = @()
    )
    Invoke-CrawlerIngestBatch -Endpoint $Endpoint -SystemId $SystemId -SyncMode $SyncMode -Scope $Scope -Records $Records
}

# Per-phase wall-clock + round-trip report — the call counts make the cross-subscription savings of
# the Resource Graph queries visible (a few paged queries instead of per-subscription fan-out).
function Write-PhaseTiming {
    [CmdletBinding()]
    param([string]$Name, [System.Diagnostics.Stopwatch]$Sw, [int]$CallsBefore)
    Write-Host ("  [timing] {0}: {1:n1}s, {2} Azure call(s)" -f $Name, $Sw.Elapsed.TotalSeconds, ($Global:AzCallCount - $CallsBefore)) -ForegroundColor DarkGray
}

# Short type label shown in capability names ("Owner @ RG: name") and stored on the scope node so
# the effective-access engine labels synthesized inherited rows the same way.
function Get-ScopeTypeLabel {
    [CmdletBinding()]
    param([string]$ScopeKind)
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
function Get-AzureResourceType {
    [CmdletBinding()]
    param([string]$ArmPath)
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
function Get-ResourceAttributes {
    [CmdletBinding()]
    param($Resource)
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

# Parent of a sub-subscription scope: a resource → its resource group, a resource group → its
# subscription, a subscription-level resource → its subscription. $null for subscription / management
# group / tenant-root scopes (those are handled as "above the subscription").
function Get-ParentScopePath {
    [CmdletBinding()]
    param([string]$ScopePath)
    if ($ScopePath -match '^(/subscriptions/[^/]+/resourceGroups/[^/]+)/providers/') { return $matches[1] }
    if ($ScopePath -match '^(/subscriptions/[^/]+)/resourceGroups/[^/]+$')           { return $matches[1] }
    if ($ScopePath -match '^(/subscriptions/[^/]+)/providers/')                       { return $matches[1] }
    return $null
}

# Group resource records by their resourceType, preserving first-seen order. A full-sync ingest
# batch only reconciles (tombstones) rows matching its scope tag; the Azure scope nodes span
# several resourceTypes, so they must be sent one batch per type or the reconcile matches nothing
# (which is what left duplicate Azure resources behind after a node-id change). Returns an ordered
# map of resourceType -> List[record]. Empty input yields an empty map (nothing is reconciled,
# so a run that discovers no resources never wipes existing ones).
function Group-FGRecordsByResourceType {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Records)
    $groups = [ordered]@{}
    foreach ($rec in $Records) {
        $rt = [string]$rec.resourceType
        if (-not $groups.Contains($rt)) { $groups[$rt] = [System.Collections.Generic.List[object]]::new() }
        $groups[$rt].Add($rec)
    }
    return $groups
}
