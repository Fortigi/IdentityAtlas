<#
.SYNOPSIS
    Azure Resource Graph (ARG) query helpers — bulk, cross-subscription reads.

.DESCRIPTION
    The Azure RM crawler reads resource groups, resources, role definitions and role assignments
    from Azure Resource Graph rather than listing them one call per subscription — at hundreds of
    subscriptions that turns thousands of sequential round-trips into a handful of paged KQL queries
    across every subscription at once.

    These helpers reuse the management.azure.com token already acquired by Connect-AzureRM (ARG
    lives on the same resource) and the Update-ARMTokenIfNeeded refresh from Get-AzureRMHelpers.ps1
    (same-folder library, dot-sourced by the dispatcher). Each typed helper returns rows shaped like
    the equivalent ARM objects (`.name` + `.properties` for authorization resources;
    `.id`/`.name`/`.location`/`.tags`/`.identity` for resources) so the crawler's mapping code is
    transport-agnostic.

    Three ARG behaviours the caller must know about:
      • ARG lowercases every resource `id` and assignment `scope`. The crawler canonicalises scope
        paths to lower-case before hashing node ids (Get-ScopeNodeId) so casing never splits a scope.
      • Role assignments declared above a subscription (management group / tenant root) are only
        returned when the query carries options.authorizationScopeFilter = AtScopeAboveAndBelow (and
        the principal can see them). Get-ARGRoleAssignments sets that filter.
      • The built-in role-definition catalog is NOT returned by an at-or-below query; it needs
        AtScopeAndAbove (Get-ARGRoleDefinitions sets that). Output was verified byte-for-byte against
        the previous per-subscription ARM path before it was retired.

    Dot-sourced automatically by the dispatcher (same-folder library).
#>

# ARG constants. NOTE: these are inlined inside the functions below rather than read from top-level
# variables — the dispatcher dot-sources crawler libraries inside a ForEach-Object block, where a
# top-level (or $script:) assignment does NOT reach the scope the functions read at call time (same
# reason Get-AzureRMHelpers.ps1 inlines its base URL). Values, for reference:
#   api-version    2022-10-01   (supports options.authorizationScopeFilter + resultFormat)
#   endpoint       https://management.azure.com/providers/Microsoft.ResourceGraph/resources
#   page size      1000         (ARG hard max rows per page)
#   sub chunk      1000         (ARG hard max subscriptions per request scope)

#region Core query

# POST one ARG query, following $skipToken across all pages; returns a flat array of `data` rows.
# Honours 429/5xx with Retry-After (same contract as Invoke-ARMRequestRaw) and the ARG user-quota
# headers (x-ms-user-quota-remaining / -resets-after) so a big crawl backs off before it is told to.
# Subscriptions are chunked to ARG's per-request limit; each chunk is paged independently and merged.
function Invoke-ARGQuery {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Query,
        [string[]]$SubscriptionIds = @(),
        [string[]]$ManagementGroups = @(),
        [string]$ScopeFilter,
        [int]$MaxRetries = 5
    )
    $pageSize     = 1000
    $subChunkSize = 1000
    $all = [System.Collections.Generic.List[object]]::new()
    # Scope by management group (single query — covers the whole subtree, and surfaces the tenant
    # role-definition catalog) or by subscriptions (chunked to ARG's per-request limit). MG scope
    # wins when supplied.
    $scopes = [System.Collections.Generic.List[object]]::new()
    if ($ManagementGroups.Count -gt 0) {
        $scopes.Add(@{ managementGroups = @($ManagementGroups) })
    } else {
        for ($i = 0; $i -lt $SubscriptionIds.Count; $i += $subChunkSize) {
            $end = [Math]::Min($i + $subChunkSize, $SubscriptionIds.Count) - 1
            $scopes.Add(@{ subscriptions = @($SubscriptionIds[$i..$end]) })
        }
    }

    foreach ($scope in $scopes) {
        $skipToken = $null
        while ($true) {
            $options = @{ '$top' = $pageSize; resultFormat = 'objectArray' }
            if ($ScopeFilter) { $options['authorizationScopeFilter'] = $ScopeFilter }
            if ($skipToken)   { $options['$skipToken'] = $skipToken }
            $body = ($scope + @{ query = $Query; options = $options }) | ConvertTo-Json -Depth 6 -Compress

            $resp = Invoke-ARGRequestRaw -Body $body -MaxRetries $MaxRetries
            if ($null -ne $resp.data) { foreach ($row in $resp.data) { [void]$all.Add($row) } }
            $skipToken = $resp.'$skipToken'
            if (-not $skipToken) { break }
        }
    }
    return $all
}

# Internal: POST the ARG endpoint once, with retry. Reuses the ARM token + refresh from
# Get-AzureRMHelpers.ps1. Increments $Global:AzCallCount so the crawler can report round-trips.
function Invoke-ARGRequestRaw {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$Body, [int]$MaxRetries = 5)
    $uri = 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01'
    $attempt = 0
    while ($true) {
        $attempt++
        Update-ARMTokenIfNeeded
        $Global:AzCallCount = [int]$Global:AzCallCount + 1
        try {
            $headers = @{ Authorization = "Bearer $Global:AccessToken"; 'Content-Type' = 'application/json' }
            $respHeaders = $null
            $resp = Invoke-RestMethod -Uri $uri -Method Post -Body $Body -TimeoutSec 120 `
                -Headers $headers -ResponseHeadersVariable respHeaders
            # Proactively back off when the per-user quota is exhausted, before ARG returns a 429.
            $remaining = 0
            try { $remaining = [int]($respHeaders['x-ms-user-quota-remaining'] | Select-Object -First 1) } catch {}
            if ($remaining -le 0) {
                $resetSpan = $null
                try { $resetSpan = [TimeSpan]::Parse(($respHeaders['x-ms-user-quota-resets-after'] | Select-Object -First 1)) } catch {}
                $wait = if ($resetSpan) { [Math]::Ceiling($resetSpan.TotalSeconds) } else { 5 }
                Write-Host "    ARG quota exhausted: pausing ${wait}s" -ForegroundColor DarkYellow
                Start-Sleep -Seconds $wait
            }
            return $resp
        } catch {
            $status = $null
            try { $status = [int]$_.Exception.Response.StatusCode } catch {}
            $transient = ($status -eq 429) -or ($status -ge 500 -and $status -lt 600) -or (-not $status)
            if ($transient -and $attempt -le $MaxRetries) {
                $retryAfter = 0
                try { $retryAfter = [int]($_.Exception.Response.Headers['Retry-After']) } catch {}
                $wait = if ($retryAfter -gt 0) { $retryAfter } else { [Math]::Min(60, [int][Math]::Pow(2, $attempt)) }
                Write-Host "    ARG ${status}: retry $attempt/$MaxRetries in ${wait}s" -ForegroundColor DarkYellow
                Start-Sleep -Seconds $wait
                continue
            }
            throw
        }
    }
}

#endregion Core query

#region Typed reads

# All resource groups across the given subscriptions. Shaped like the ARM `/resourcegroups` list
# items the crawler consumes: `.id` (full ARM path, lower-cased by ARG), `.name`, `.subscriptionId`.
function Get-ARGResourceGroups {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string[]]$SubscriptionIds)
    $q = @'
resourcecontainers
| where type =~ 'microsoft.resources/subscriptions/resourcegroups'
| project id, name, subscriptionId
'@
    return Invoke-ARGQuery -Query $q -SubscriptionIds $SubscriptionIds
}

# All resources across the given subscriptions, with the governance attributes the crawler lifts
# (location, tags, managed identity). NOTE: ARG returns `identity` natively, where the ARM
# `/resources` list omits it unless $expand=identity — so ARG may legitimately surface MORE
# managedIdentity attributes than the REST path. That is an improvement, not a parity defect.
function Get-ARGResources {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string[]]$SubscriptionIds)
    $q = @'
resources
| project id, name, type, location, tags, identity, resourceGroup, subscriptionId
'@
    return Invoke-ARGQuery -Query $q -SubscriptionIds $SubscriptionIds
}

# All role definitions visible to the given subscriptions. Shaped like ARM roleDefinition objects:
# `.name` (the role's GUID), `.properties.roleName`, `.properties.type`, `.properties.permissions[]`.
function Get-ARGRoleDefinitions {
    [CmdletBinding()]
    param([string[]]$SubscriptionIds = @(), [string[]]$ManagementGroups = @())
    $q = @'
authorizationresources
| where type =~ 'microsoft.authorization/roledefinitions'
| project name, properties
'@
    # Built-in role definitions are a tenant catalog that a subscription-scoped query does not surface;
    # scope by the management group (with AtScopeAndAbove to reach the tenant root) to get them.
    if ($ManagementGroups.Count -gt 0) {
        return Invoke-ARGQuery -Query $q -ManagementGroups $ManagementGroups -ScopeFilter 'AtScopeAndAbove'
    }
    return Invoke-ARGQuery -Query $q -SubscriptionIds $SubscriptionIds -ScopeFilter 'AtScopeAndAbove'
}

# All role assignments at or above/below the given subscriptions. Shaped like ARM roleAssignment
# objects: `.name` (assignment GUID), `.properties.scope/principalId/principalType/roleDefinitionId/
# condition/conditionVersion/createdOn/createdBy`. AtScopeAboveAndBelow is required to return
# management-group / tenant-root declared assignments (the REST path gets these implicitly because
# its per-subscription list includes inherited-from-above rows).
function Get-ARGRoleAssignments {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string[]]$SubscriptionIds)
    $q = @'
authorizationresources
| where type =~ 'microsoft.authorization/roleassignments'
| project name, properties
'@
    return Invoke-ARGQuery -Query $q -SubscriptionIds $SubscriptionIds -ScopeFilter 'AtScopeAboveAndBelow'
}

# Map of subscriptionId → ordered management-group ancestor ids (nearest parent first, tenant root
# last). Lets the crawler rebuild the management-group → subscription `Contains` edges that the REST
# path derives implicitly from its per-subscription assignment lists. Subscriptions with no MG
# ancestry (or where the chain is not exposed) map to an empty array.
function Get-ARGSubscriptionMgChains {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string[]]$SubscriptionIds)
    $q = @'
resourcecontainers
| where type =~ 'microsoft.resources/subscriptions'
| project subscriptionId, chain = properties.managementGroupAncestorsChain
'@
    $rows = Invoke-ARGQuery -Query $q -SubscriptionIds $SubscriptionIds
    $map = @{}
    foreach ($r in $rows) {
        $ids = [System.Collections.Generic.List[string]]::new()
        foreach ($mg in @($r.chain)) {
            if ($mg.name) { $ids.Add([string]$mg.name) }
        }
        $map[[string]$r.subscriptionId] = $ids.ToArray()
    }
    return $map
}

#endregion Typed reads
