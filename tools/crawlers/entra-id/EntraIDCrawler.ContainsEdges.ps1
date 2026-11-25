<#
.SYNOPSIS
    Entra ID crawler — the run's 'Contains' resource relationships, sent as one batch.

.DESCRIPTION
    Two phases produce 'Contains' edges on the same Entra system:
      * group-in-group nesting (Sync-EntraAssignments): parent group Contains the
        nested group — the same edge SCIM, midPoint, Omada and CSV write (#1335);
      * access-package resource scopes (Sync-EntraGovernanceResourceScopes): the
        access package Contains the group it hands out.

    A full-sync ingest batch reconcile-deletes every row of its scope that it did
    not carry, and ingest can scope resource-relationships only by
    relationshipType. Two separate 'Contains' full syncs would therefore delete
    each other's rows. So each phase only *collects* its edges here, and
    Send-EntraContainsRelationships sends the union once, after both ran
    (precedent: the SP + app-registration owners share one HasAppOwnership batch).

    The union is sent as a FULL sync only when every enabled source was collected
    this run. When an enabled source was not (a delta run skips the membership
    fetch; a governance fetch failed), it is sent as a DELTA upsert instead, so
    the missing source's rows are kept rather than reconciled away. A disabled
    source has nothing to keep: its old rows go on the next full sync.
#>

# Which phase produced which edges this run. $null = not collected this run.
function Reset-EntraContainsEdges {
    $script:entraContainsEdges = @{ nesting = $null; accessPackages = $null }
}

# Record one source's edges for this run (an empty set is a real "there are none").
function Add-EntraContainsEdges {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [ValidateSet('nesting', 'accessPackages')] [string]$Source,
        [Parameter(Mandatory)] [AllowNull()] [AllowEmptyCollection()] $Records
    )
    if (-not $script:entraContainsEdges) { Reset-EntraContainsEdges }
    $script:entraContainsEdges[$Source] = @($Records | Where-Object { $_ })
}

# Maps the members phase's direct edges to group-in-group Contains relationships:
# one per (group, member that is itself a group). User members and self-links are
# dropped; duplicates collapse. Pure; no I/O.
function ConvertTo-EntraGroupNestingRelationships {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] $DirectMembers)

    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $out  = [System.Collections.Generic.List[object]]::new()
    foreach ($m in $DirectMembers) {
        if ($m.principalType -ne 'Group' -or $m.resourceId -eq $m.principalId) { continue }
        if (-not $seen.Add("$($m.resourceId)|$($m.principalId)")) { continue }
        $out.Add(@{
            parentResourceId = $m.resourceId
            childResourceId  = $m.principalId
            relationshipType = 'Contains'
        })
    }
    return @($out)
}

# 'full' when every enabled source was collected, 'delta' when an enabled source
# is missing, 'none' when nothing was collected. Pure.
function Get-EntraContainsSyncMode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [hashtable]$Collected,
        [bool]$NestingEnabled,
        [bool]$GovernanceEnabled
    )
    $enabled = @{ nesting = $NestingEnabled; accessPackages = $GovernanceEnabled }
    $anyCollected = $false
    $missing = $false
    foreach ($source in $enabled.Keys) {
        if ($null -ne $Collected[$source]) { $anyCollected = $true }
        elseif ($enabled[$source]) { $missing = $true }
    }
    if (-not $anyCollected) { return 'none' }
    if ($missing) { return 'delta' }
    return 'full'
}

# Send the run's collected Contains edges as one batch, then clear them.
function Send-EntraContainsRelationships {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        $NestingEnabled = $false,
        $GovernanceEnabled = $false
    )
    if (-not $script:entraContainsEdges) { Reset-EntraContainsEdges }
    $collected = $script:entraContainsEdges
    $mode = Get-EntraContainsSyncMode -Collected $collected `
        -NestingEnabled ([bool]$NestingEnabled) -GovernanceEnabled ([bool]$GovernanceEnabled)
    Reset-EntraContainsEdges
    if ($mode -eq 'none') { return }

    $records = @(@($collected.accessPackages) + @($collected.nesting) | Where-Object { $_ })
    Update-CrawlerProgress -Detail "Uploading $($records.Count) Contains relationships ($mode)..."
    if ($mode -eq 'full') {
        Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ relationshipType = 'Contains' } -Records $records | Out-Null
    } else {
        Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'delta' `
            -Records $records | Out-Null
    }
}

Reset-EntraContainsEdges
