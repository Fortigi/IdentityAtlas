<#
.SYNOPSIS
    Entra ID crawler — principal→principal relationships: AI-agent owners and
    guest sponsors (its own file so Transform / Phases stay under the file-length
    ratchet, and mirroring EntraIDCrawler.AppOwners.ps1's structure).

.DESCRIPTION
    Two responsibility links between two *principals* that don't fit the
    principal→resource (ResourceAssignments) or resource→resource
    (ResourceRelationships) models, so they land in their own PrincipalRelationships
    table (migration 057) via /ingest/principal-relationships:

      * Owner   — owners of an AI agent. An agent is a service principal we classify
                  principalType='AIAgent'; its owner is another Principal (a user).
                  Read from /servicePrincipals/{agent}/owners.
      * Sponsor — sponsors of a guest (B2B) account. Read from /users/{guest}/sponsors.

    Direction (see migration 057): principalId = the SUBJECT that HAS the owner/
    sponsor (the agent / the guest); relatedPrincipalId = the owner / sponsor.

    A distinct relationshipType per kind lets each full-sync reconcile only its own
    rows (an Owner sync never wipes Sponsor links) — the same isolation the
    HasAppOwnership relationshipType gives the app-owners phase.

    Owners/sponsors are fetched per-agent / per-guest (no bulk Graph endpoint), so
    this is opt-in — but far cheaper than the app-owners phase, which fetches owners
    for EVERY app: agents and guests are typically a small slice of the tenant.

    Dot-sourced by Start-EntraIDCrawler.ps1 (auto-loaded by the dispatcher's *.ps1
    glob). ConvertTo-EntraPrincipalRelationshipRecords + the pair builders are
    pure/mockable; Sync-EntraPrincipalRelationships is thin phase orchestration.
#>

# Pure: turn (subjectId, relatedId) owner/sponsor pairs into principal-relationship
# ingest records for one relationshipType. Drops blank ids, self-links (a principal
# is never its own owner/sponsor), and duplicate (subject, related) pairs. Returns an
# array. Unit-testable directly with in-memory fixtures.
function ConvertTo-EntraPrincipalRelationshipRecords {
    [CmdletBinding()]
    param(
        $Pairs,
        [Parameter(Mandatory)] [ValidateSet('Owner', 'Sponsor')] [string]$RelationshipType
    )
    $seen = @{}
    $out  = [System.Collections.Generic.List[object]]::new()
    foreach ($p in $Pairs) {
        if (-not $p.subjectId -or -not $p.relatedId) { continue }
        if ($p.subjectId -eq $p.relatedId) { continue }
        $key = "$($p.subjectId)|$($p.relatedId)"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $out.Add(@{
            principalId        = $p.subjectId
            relatedPrincipalId = $p.relatedId
            relationshipType   = $RelationshipType
        })
    }
    return @($out)
}

# Filter a service-principal list to AI agents (via the shared classifier) and fetch
# each agent's owners in parallel, returning (subjectId = agent, relatedId = owner)
# pairs. Empty when there are no agents. Pure boundary: mockable via Get-FGGroupChildrenParallel.
function Get-EntraAgentOwnerPairs {
    [CmdletBinding()]
    param([array]$ServicePrincipals = @(), [string[]]$AINamePatterns = @())
    $agents = @($ServicePrincipals | Where-Object {
        (Get-FGServicePrincipalType -ServicePrincipal $_ -AINamePatterns $AINamePatterns) -eq 'AIAgent'
    })
    Write-Host "  AI agents: $($agents.Count) of $($ServicePrincipals.Count) service principals" -ForegroundColor Gray
    if ($agents.Count -eq 0) { return @() }
    $result = Get-FGGroupChildrenParallel -Groups $agents -EntityType 'servicePrincipals' -ChildPath 'owners' -ThrottleLimit 16 `
        -ProgressStep 'Syncing principal relationships' -ProgressStartPct 84 -ProgressEndPct 87 `
        -RecordBuilder { param($o) @{ subjectId = $o.resourceId; relatedId = $o.principalId } }
    if ($result.errorCount -gt 0) {
        Write-Host "  WARNING: $($result.errorCount) agents failed during owner fetch (skipped)" -ForegroundColor Yellow
    }
    return @($result.records)
}

# Fetch each guest's sponsors in parallel, returning (subjectId = guest, relatedId =
# sponsor) pairs. Empty when there are no guests.
function Get-EntraGuestSponsorPairs {
    [CmdletBinding()]
    param([array]$Guests = @())
    if ($Guests.Count -eq 0) { return @() }
    $result = Get-FGGroupChildrenParallel -Groups $Guests -EntityType 'users' -ChildPath 'sponsors' -ThrottleLimit 16 `
        -ProgressStep 'Syncing principal relationships' -ProgressStartPct 87 -ProgressEndPct 90 `
        -RecordBuilder { param($o) @{ subjectId = $o.resourceId; relatedId = $o.principalId } }
    if ($result.errorCount -gt 0) {
        Write-Host "  WARNING: $($result.errorCount) guests failed during sponsor fetch (skipped)" -ForegroundColor Yellow
    }
    return @($result.records)
}

# ─── Sync Principal Relationships phase ──────────────────────────
# Thin orchestration: fetch the SP list (classify to agents) + the guest list,
# resolve their owners / sponsors, and upload. Opt-in via SyncPrincipalRelationships.
function Sync-EntraPrincipalRelationships {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string[]]$AINamePatterns = @(),
        $Timings
    )
    $__phaseSW = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing principal relationships (agent owners, guest sponsors)..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing principal relationships' -Pct 84 -Detail 'Fetching service principals + guests from Microsoft Graph...'
    try {
        $sps = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,appId,displayName,servicePrincipalType,tags&`$top=999")
        $agentOwnerPairs = Get-EntraAgentOwnerPairs -ServicePrincipals $sps -AINamePatterns $AINamePatterns

        $guests = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/users?`$filter=userType eq 'Guest'&`$select=id,displayName&`$top=999")
        Write-Host "  Guests: $($guests.Count)" -ForegroundColor Gray
        $guestSponsorPairs = Get-EntraGuestSponsorPairs -Guests $guests

        $ownerRecords   = ConvertTo-EntraPrincipalRelationshipRecords -Pairs $agentOwnerPairs   -RelationshipType 'Owner'
        $sponsorRecords = ConvertTo-EntraPrincipalRelationshipRecords -Pairs $guestSponsorPairs -RelationshipType 'Sponsor'

        Write-Host "  Agent owners: $($ownerRecords.Count) · Guest sponsors: $($sponsorRecords.Count)" -ForegroundColor Gray
        Send-EntraPrincipalRelationshipBatches -SystemId $SystemId -OwnerRecords $ownerRecords -SponsorRecords $sponsorRecords
    }
    catch {
        Write-Host "  Principal relationship sync failed: $($_.Exception.Message)" -ForegroundColor Red
        $script:phaseErrors.Add("PrincipalRelationships: $($_.Exception.Message)")
        Write-Host "  (Requires Application.Read.All for agent owners + User.Read.All for guest sponsors.)" -ForegroundColor Yellow
    }
    $__phaseSW.Stop()
    if ($Timings) { $Timings['PrincipalRelationships'] = $__phaseSW.Elapsed }

    $__err = $script:phaseErrors | Where-Object { $_.StartsWith('PrincipalRelationships:') } | Select-Object -Last 1
    $__errMsg = if ($__err) { $__err.Substring('PrincipalRelationships:'.Length).Trim() } else { $null }
    Write-Phase -Name 'PrincipalRelationships' -Duration $__phaseSW.Elapsed -ErrorMsg $__errMsg
}

# Upload the two relationship kinds, each full-synced on its own relationshipType
# scope so a reconcile clears only that kind (an Owner sync never wipes Sponsor
# links). Sent unconditionally so removing an agent's last owner / a guest's last
# sponsor reconciles the stale rows away.
function Send-EntraPrincipalRelationshipBatches {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [array]$OwnerRecords = @(),
        [array]$SponsorRecords = @()
    )
    Update-CrawlerProgress -Detail "Uploading agent-owner relationships..."
    Send-IngestBatch -Endpoint 'ingest/principal-relationships' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ relationshipType = 'Owner' } -Records @($OwnerRecords)

    Update-CrawlerProgress -Detail "Uploading guest-sponsor relationships..."
    Send-IngestBatch -Endpoint 'ingest/principal-relationships' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ relationshipType = 'Sponsor' } -Records @($SponsorRecords)
}
