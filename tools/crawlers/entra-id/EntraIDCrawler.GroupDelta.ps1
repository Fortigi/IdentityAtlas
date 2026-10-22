<#
.SYNOPSIS
    Entra ID crawler — groups, memberships and owners via Graph /groups/delta.

.DESCRIPTION
    A full run reads every group, then every group's members and owners with two
    Graph calls per group — hours on a large tenant. A delta run reads
    /groups/delta instead, with members and owners selected: one paged call that
    returns only the groups that changed, each with `members@delta` /
    `owners@delta` listing the members and owners added or removed since the
    stored token.

    What a delta run applies:
      - a removed group           → the Group resource is deleted (deletedIds)
      - a changed or new group    → re-fetched in full, then upserted. Graph may
                                    return only the changed properties, and the
                                    record builder derives groupCategory etc. from
                                    the whole object, so a partial one would write
                                    wrong derived values
      - a member added / removed  → a Direct assignment upserted / deleted
                                    (deletedKeys — a membership has no id)
      - an owner added / removed  → the same, on the group's GroupOwnership resource

    What it does not apply: indirect (nested-group) memberships. Those are
    derived from the complete set of direct memberships, which only a full run
    reads, so they are as fresh as the last full run.

    The token: a full run asks Graph for one with `$deltatoken=latest` BEFORE it
    reads the groups and stores it only when the groups and memberships phases
    succeeded, so the next delta starts where that full read began. A delta run
    without a token (a crawler that predates group deltas) or with one Graph no
    longer accepts starts a new baseline the same way and applies nothing; the
    changes until then arrive with the next full run.

    Dot-sourced by Start-EntraIDCrawler.ps1 (and auto-loaded by the dispatcher's
    *.ps1 glob).
#>

#region Configuration

# The group properties every group fetch selects (plus the configured custom
# attributes). Shared by the full Resources phase and the delta re-fetch.
$script:EntraGroupCoreAttributes = @(
    'id', 'displayName', 'description', 'mail', 'visibility', 'createdDateTime', 'groupTypes',
    'securityEnabled', 'mailEnabled', 'membershipRule', 'membershipRuleProcessingState',
    'onPremisesSyncEnabled', 'resourceProvisioningOptions'
)

# The properties the delta token tracks: a change to one of these makes Graph
# report the group. Changes to anything else (custom attributes, provisioning
# options) arrive with the next full run.
$script:EntraGroupDeltaTrackedAttributes = @(
    'displayName', 'description', 'mail', 'visibility', 'groupTypes', 'securityEnabled',
    'mailEnabled', 'membershipRule', 'membershipRuleProcessingState', 'onPremisesSyncEnabled'
)

# Graph allows up to 15 values in an `id in (...)` filter.
$script:EntraGroupFetchChunk = 15

#endregion Configuration

#region Functions

# The $select for a full group fetch. Pure.
function Get-EntraGroupSelect {
    [CmdletBinding()]
    [OutputType([string])]
    param([string[]]$CustomGroupAttributes = @())
    return (@($script:EntraGroupCoreAttributes + $CustomGroupAttributes) | Select-Object -Unique) -join ','
}

# The delta-token key. It names the query shape, because a token issued for a
# groups-only query does not report membership changes. Pure.
function Get-EntraGroupDeltaEndpoint {
    [CmdletBinding()]
    [OutputType([string])]
    param([bool]$IncludeMembers = $true)
    if ($IncludeMembers) { return 'groups/delta/members-owners' }
    return 'groups/delta'
}

# The URI that asks Graph for a fresh token without returning any data. Pure.
function Get-EntraGroupDeltaPrimeUri {
    [CmdletBinding()]
    [OutputType([string])]
    param([bool]$IncludeMembers = $true)
    $select = @('id') + $script:EntraGroupDeltaTrackedAttributes
    if ($IncludeMembers) { $select += @('members', 'owners') }
    return "https://graph.microsoft.com/beta/groups/delta?`$select=$($select -join ',')&`$deltatoken=latest"
}

# Property names of a Graph object, whether it arrived as a PSCustomObject
# (Invoke-RestMethod) or a hashtable. Pure.
function Get-FGObjectPropertyNames {
    [CmdletBinding()]
    [OutputType([string[]])]
    param($Object)
    if ($Object -is [System.Collections.IDictionary]) { return @($Object.Keys) }
    return @($Object.PSObject.Properties.Name)
}

# Fold the per-member / per-owner change entries of one group into $Into, keyed
# on (group, child) so a later entry for the same pair wins. Pure apart from $Into.
function Add-EntraGroupChildChanges {
    [CmdletBinding()]
    param([string]$GroupId, $Entries, [System.Collections.Specialized.OrderedDictionary]$Into)
    foreach ($e in @($Entries)) {
        if (-not $e -or -not $e.id) { continue }
        $Into["$GroupId|$($e.id)"] = @{
            groupId     = $GroupId
            principalId = $e.id
            childType   = $e.'@odata.type'
            removed     = [bool]$e.'@removed'
        }
    }
}

# Whether a changed group must be re-fetched in full: it carries a property
# change, or (when memberships are read) an owner change — an ownership resource
# needs the group's name. A membership-only change needs nothing more. Pure.
function Test-EntraGroupNeedsRefetch {
    [CmdletBinding()]
    [OutputType([bool])]
    param($Item, [bool]$IncludeMembers = $true)
    $relationKeys = @('id', 'members@delta', 'owners@delta')
    $hasProperties = @(Get-FGObjectPropertyNames $Item | Where-Object { $_ -notin $relationKeys -and $_ -notlike '@odata*' }).Count -gt 0
    if ($hasProperties) { return $true }
    return $IncludeMembers -and @($Item.'owners@delta' | Where-Object { $_ -and $_.id }).Count -gt 0
}

# Reduce the items of a /groups/delta response to what changed. Pure.
# Returns @{ removedGroupIds; refetchIds; memberChanges; ownerChanges }.
function ConvertFrom-EntraGroupDeltaItems {
    [CmdletBinding()]
    param($Items, [bool]$IncludeMembers = $true)
    $removed = [System.Collections.Generic.List[string]]::new()
    $refetch = [System.Collections.Generic.List[string]]::new()
    $members = [ordered]@{}
    $owners  = [ordered]@{}

    foreach ($item in @($Items)) {
        if (-not $item -or -not $item.id) { continue }
        if ($item.'@removed') { $removed.Add($item.id); continue }

        if (-not $refetch.Contains($item.id) -and (Test-EntraGroupNeedsRefetch -Item $item -IncludeMembers $IncludeMembers)) {
            $refetch.Add($item.id)
        }

        if ($IncludeMembers) {
            Add-EntraGroupChildChanges -GroupId $item.id -Entries $item.'members@delta' -Into $members
            Add-EntraGroupChildChanges -GroupId $item.id -Entries $item.'owners@delta' -Into $owners
        }
    }

    return @{
        removedGroupIds = @($removed)
        refetchIds      = @($refetch)
        memberChanges   = @($members.Values)
        ownerChanges    = @($owners.Values)
    }
}

# Turn the changes plus the re-fetched groups into ingest payloads. Pure apart
# from the deterministic-id helper. An owner added to a group whose name is not
# known (its re-fetch failed) is skipped rather than written as '(group)'.
function ConvertTo-EntraGroupDeltaIngest {
    [CmdletBinding()]
    param($Changes, [hashtable]$GroupsById = @{}, [string[]]$CustomGroupAttributes = @())

    $groupRecords = @($GroupsById.Values | ForEach-Object {
        ConvertTo-EntraGroupResourceRecord -Group $_ -CustomGroupAttributes $CustomGroupAttributes
    })

    $memberAdds = @($Changes.memberChanges | Where-Object { -not $_.removed } | ForEach-Object {
        @{
            resourceId     = $_.groupId
            principalId    = $_.principalId
            assignmentType = 'Direct'
            resourceType   = 'Group'
            principalType  = if ($_.childType -eq '#microsoft.graph.group') { 'Group' } else { 'User' }
        }
    })
    $memberRemoves = @($Changes.memberChanges | Where-Object { $_.removed } | ForEach-Object {
        @{ resourceId = $_.groupId; principalId = $_.principalId; assignmentType = 'Direct' }
    })

    $groupNameById = @{}
    foreach ($id in $GroupsById.Keys) { $groupNameById[$id] = $GroupsById[$id].displayName }
    $ownerAdds = @($Changes.ownerChanges | Where-Object { -not $_.removed -and $groupNameById[$_.groupId] })
    $ownership = ConvertTo-EntraGroupOwnership -RawOwners $ownerAdds -GroupNameById $groupNameById
    $ownerRemoves = @($Changes.ownerChanges | Where-Object { $_.removed } | ForEach-Object {
        @{ resourceId = (New-OwnershipResourceId -GroupId $_.groupId); principalId = $_.principalId; assignmentType = 'Direct' }
    })

    return @{
        groupRecords       = $groupRecords
        removedGroupIds    = @($Changes.removedGroupIds)
        ownershipResources = @($ownership.resources)
        ownershipRels      = @($ownership.relationships)
        assignmentAdds     = @($memberAdds) + @($ownership.assignments)
        assignmentRemoves  = @($memberRemoves) + @($ownerRemoves)
    }
}

# Fetch whole groups by id, 15 per call. Returns a hashtable id → group.
function Get-EntraGroupsById {
    [CmdletBinding()]
    param([string[]]$Ids = @(), [string]$Select)
    $byId = @{}
    for ($i = 0; $i -lt $Ids.Count; $i += $script:EntraGroupFetchChunk) {
        $chunk = $Ids[$i..([Math]::Min($i + $script:EntraGroupFetchChunk - 1, $Ids.Count - 1))]
        $filter = [uri]::EscapeDataString("id in ($(($chunk | ForEach-Object { "'$_'" }) -join ','))")
        foreach ($g in @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/groups?`$filter=$filter&`$select=$Select")) {
            if ($g -and $g.id) { $byId[$g.id] = $g }
        }
    }
    return $byId
}

# Ask Graph for a token that starts now. Returns the token, or $null (logged)
# when Graph does not hand one out — the next delta run then tries again.
function New-EntraGroupDeltaToken {
    [CmdletBinding()]
    param([bool]$IncludeMembers = $true)
    try {
        $resp = Invoke-FGGetDeltaRequest -URI (Get-EntraGroupDeltaPrimeUri -IncludeMembers $IncludeMembers)
        if ($resp.deltaToken) { return $resp.deltaToken }
        Write-Host "  (group delta token: Graph returned no deltaLink)" -ForegroundColor DarkGray
    } catch {
        Write-Host "  (group delta token could not be started: $($_.Exception.Message))" -ForegroundColor Yellow
    }
    return $null
}

# The changes since $Token, or $null when Graph no longer accepts the token (it
# is cleared). Any other failure propagates, so the token is not advanced.
function Get-EntraGroupDeltaChanges {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId, [Parameter(Mandatory)] [string]$Endpoint, [Parameter(Mandatory)] [string]$Token)
    try {
        return Invoke-FGGetDeltaRequest -URI "https://graph.microsoft.com/beta/groups/delta?`$deltatoken=$([uri]::EscapeDataString($Token))"
    } catch [System.InvalidOperationException] {
        Write-Host "  Group delta token rejected by Graph — starting a new baseline" -ForegroundColor Yellow
        Remove-FGDeltaToken -SystemId $SystemId -Endpoint $Endpoint
        return $null
    }
}

# Upload one delta's payloads: groups first (and removed groups), then ownership
# resources and their links, then the assignment upserts and the key deletes.
function Send-EntraGroupDeltaIngest {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId, [Parameter(Mandatory)] [hashtable]$Payload)
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'delta' `
        -Records $Payload.groupRecords -DeletedIds $Payload.removedGroupIds | Out-Null
    Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'delta' `
        -Records $Payload.ownershipResources | Out-Null
    Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'delta' `
        -Records $Payload.ownershipRels | Out-Null
    Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'delta' `
        -Records $Payload.assignmentAdds | Out-Null
    Send-CrawlerIngestDeletedKeys -Endpoint 'ingest/resource-assignments' -SystemId $SystemId `
        -Keys $Payload.assignmentRemoves | Out-Null
}

# Start a baseline when there is none (or Graph rejected it): store a token that
# starts now and apply nothing this run.
function Reset-EntraGroupDeltaBaseline {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId, [Parameter(Mandatory)] [string]$Endpoint, [bool]$IncludeMembers = $true)
    $token = New-EntraGroupDeltaToken -IncludeMembers $IncludeMembers
    if ($token) { Set-FGDeltaToken -SystemId $SystemId -Endpoint $Endpoint -Token $token }
    Write-Host "  No group delta baseline yet — started one now. Group changes from here on arrive with each delta run; earlier ones arrive with the next full run." -ForegroundColor Yellow
}

# ─── Sync group changes (delta run) ──────────────────────────────
function Sync-EntraGroupDelta {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string[]]$CustomGroupAttributes = @(),
        [bool]$IncludeMembers = $true,
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing group changes (delta)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing group changes' -Pct 20 -Detail 'Fetching changes from Microsoft Graph...'
    try {
        $endpoint = Get-EntraGroupDeltaEndpoint -IncludeMembers $IncludeMembers
        $token = Get-FGDeltaToken -SystemId $SystemId -Endpoint $endpoint
        $resp = if ($token) { Get-EntraGroupDeltaChanges -SystemId $SystemId -Endpoint $endpoint -Token $token } else { $null }
        if (-not $resp) {
            Reset-EntraGroupDeltaBaseline -SystemId $SystemId -Endpoint $endpoint -IncludeMembers $IncludeMembers
        }
        else {
            $changes = ConvertFrom-EntraGroupDeltaItems -Items $resp.value -IncludeMembers $IncludeMembers
            $groupsById = Get-EntraGroupsById -Ids $changes.refetchIds -Select (Get-EntraGroupSelect -CustomGroupAttributes $CustomGroupAttributes)
            $payload = ConvertTo-EntraGroupDeltaIngest -Changes $changes -GroupsById $groupsById -CustomGroupAttributes $CustomGroupAttributes
            Write-Host "  Group changes: $($payload.groupRecords.Count) changed, $($payload.removedGroupIds.Count) removed · memberships/owners: $($payload.assignmentAdds.Count) added, $($payload.assignmentRemoves.Count) removed" -ForegroundColor Gray
            Send-EntraGroupDeltaIngest -SystemId $SystemId -Payload $payload
            if ($resp.deltaToken) { Set-FGDeltaToken -SystemId $SystemId -Endpoint $endpoint -Token $resp.deltaToken }
        }
    } catch {
        $script:phaseErrors.Add("GroupDelta: $($_.Exception.Message)")
        Write-Host "  Group delta failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    $__errMsg = $script:phaseErrors | Where-Object { $_.StartsWith('GroupDelta: ') } | Select-Object -Last 1
    $__phaseSW.Stop(); if ($Timings) { $Timings['GroupDelta'] = $__phaseSW.Elapsed }
    Write-Phase -Name 'GroupDelta' -Duration $__phaseSW.Elapsed -ErrorMsg $__errMsg
}

# ─── Dispatch: groups + memberships for a full or delta run ──────
# A delta run reads /groups/delta. A full run starts a group delta token, runs the
# Resources + Assignments phases, and stores the token only when both succeeded.
# Returns the groups a full run fetched (the PIM phase needs them); none on a delta.
function Invoke-EntraGroupPhases {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode = 'full',
        # Untyped for the same reason as Invoke-EntraApplicationPhases: the resolved
        # config can hand '' through, which [bool] parameter binding rejects.
        $SyncResources = $false,
        $SyncAssignments = $false,
        [string[]]$CustomGroupAttributes = @(),
        $Timings
    )
    $includeMembers = [bool]$SyncAssignments
    if ($SyncMode -eq 'delta') {
        if ($SyncResources) {
            Sync-EntraGroupDelta -SystemId $SystemId -CustomGroupAttributes $CustomGroupAttributes -IncludeMembers $includeMembers -Timings $Timings
        }
        return @()
    }

    $token = if ($SyncResources) { New-EntraGroupDeltaToken -IncludeMembers $includeMembers } else { $null }
    $errorsBefore = $script:phaseErrors.Count
    $groups = @()
    if ($SyncResources) {
        $groups = @(Sync-EntraResources -SystemId $SystemId -CustomGroupAttributes $CustomGroupAttributes -Timings $Timings)
    }
    if ($SyncAssignments) {
        Sync-EntraAssignments -SystemId $SystemId -Groups $groups -Timings $Timings
    }
    if ($token -and $script:phaseErrors.Count -eq $errorsBefore) {
        Set-FGDeltaToken -SystemId $SystemId -Endpoint (Get-EntraGroupDeltaEndpoint -IncludeMembers $includeMembers) -Token $token
    }
    return $groups
}

#endregion Functions
