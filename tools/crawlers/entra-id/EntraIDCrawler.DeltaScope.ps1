<#
.SYNOPSIS
    Entra ID crawler — decides which phases a delta run executes.

.DESCRIPTION
    Three kinds of data can be read as a Graph delta feed: users (/users/delta),
    service principals (/servicePrincipals/delta) and groups with their members
    and owners (/groups/delta, see EntraIDCrawler.GroupDelta.ps1). Every other
    phase — PIM, governance, app roles, OAuth2 grants, directory roles, sign-in
    logs, … — re-reads its whole collection on every run, so a "delta" that ran
    them took as long as a full sync (hours on a large tenant) and could not be
    scheduled often.

    A delta run therefore executes only the delta-capable phases (plus the view
    refresh). Everything else is left to the full runs. The trade-off is
    deliberate: deltas become cheap enough to run every few minutes, and data
    that only a full run reads is as fresh as the last full run.

    One exception: a delta run on a crawler that has no delta baseline yet (no
    stored token for any delta-capable endpoint — a brand-new crawler, or one
    whose tokens were cleared) is promoted to a full run. Otherwise a new
    crawler whose first run happens to be a delta would load users but no groups
    or memberships until the next scheduled full run.

    Dot-sourced by Start-EntraIDCrawler.ps1 (and auto-loaded by the dispatcher's
    *.ps1 glob).
#>

#region Functions

# The phase toggles a delta run keeps. Any other Sync* toggle in the resolved
# config is full-run-only — an allow list, so a phase added later stays off delta
# runs until it is made incremental and listed here. Resources + Assignments run
# as one /groups/delta read on a delta run (Invoke-EntraGroupPhases).
$script:EntraDeltaCapablePhases = @('SyncPrincipals', 'SyncServicePrincipals', 'SyncResources', 'SyncAssignments')

# The delta-token endpoints the enabled delta-capable phases read. Pure apart from
# Get-EntraGroupDeltaEndpoint (EntraIDCrawler.GroupDelta.ps1), which is pure too.
function Get-EntraDeltaEndpoints {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [hashtable]$Cfg)
    $endpoints = @()
    if ($Cfg.SyncPrincipals)        { $endpoints += 'users/delta' }
    if ($Cfg.SyncServicePrincipals) { $endpoints += 'servicePrincipals/delta' }
    if ($Cfg.SyncResources)         { $endpoints += Get-EntraGroupDeltaEndpoint -IncludeMembers ([bool]$Cfg.SyncAssignments) }
    return $endpoints
}

# True when at least one enabled delta-capable phase has a stored delta token,
# i.e. a baseline exists for a delta run to build on. I/O: one token lookup per
# endpoint, stopping at the first hit. A failed lookup reads as "no token", which
# errs toward a full run — slower, never wrong.
function Test-EntraDeltaBaseline {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)] [hashtable]$Cfg,
        [Parameter(Mandatory)] [int]$SystemId
    )
    foreach ($endpoint in (Get-EntraDeltaEndpoints -Cfg $Cfg)) {
        if (Get-FGDeltaToken -SystemId $SystemId -Endpoint $endpoint) { return $true }
    }
    return $false
}

# Narrow a resolved config to what a delta run executes. Mutates $Cfg in place
# and returns the names of the toggles it switched off. Pure apart from logging.
#   - full run                → unchanged
#   - delta run, no baseline  → promoted to a full run (SyncMode = 'full')
#   - delta run with baseline → every enabled Sync* toggle outside the allow
#                               list is switched off
function Limit-EntraSyncToDeltaPhases {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [hashtable]$Cfg,
        [bool]$HasBaseline = $true
    )
    if ($Cfg.SyncMode -ne 'delta') { return @() }

    if (-not $HasBaseline) {
        $Cfg.SyncMode = 'full'
        Write-Host "Delta run requested but this crawler has no delta baseline yet — running a full sync instead" -ForegroundColor Yellow
        return @()
    }

    $skipped = @($Cfg.Keys | Where-Object {
        $_ -like 'Sync*' -and $_ -ne 'SyncMode' -and $Cfg[$_] -and $_ -notin $script:EntraDeltaCapablePhases
    } | Sort-Object)
    foreach ($toggle in $skipped) { $Cfg[$toggle] = $false }

    if ($skipped.Count -gt 0) {
        Write-Host "Delta run: only users, service principals, groups and their memberships are refreshed. Left for the next full run: $($skipped -join ', ')" -ForegroundColor Cyan
    }

    return $skipped
}

#endregion Functions
