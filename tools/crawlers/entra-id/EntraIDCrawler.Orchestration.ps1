<#
.SYNOPSIS
    Entra ID crawler — dispatch for the application / service-principal permission
    phases, extracted from Start-EntraIDCrawler.ps1 so the entry-point's top-level body
    stays under the per-unit complexity ratchet.

.DESCRIPTION
    Every opt-in phase in the entry point is one `if ($SyncX) { ... }` guard, and each
    guard is a decision point — so the entry-point `<script-body>` was creeping up by one
    cyclomatic point per phase added (the same untestable-monolith smell the crawler
    coding guide warns about). These four phases are a natural group to lift out: they all
    hang child resources off the `Application` resource, they run consecutively with no
    other code interleaved, and none passes state to a later phase — each just ingests via
    the shared $script:phaseErrors / $script:phases accumulators (which resolve to the
    entry point's script scope exactly as when the guards were inline, because this file is
    dot-sourced into that scope like every other sibling).

    Dot-sourced by Start-EntraIDCrawler.ps1 (and auto-loaded by the dispatcher's *.ps1
    glob). Pure orchestration — unit-tested by mocking the four Sync-Entra* phases.
#>

# Run the opt-in application & service-principal permission phases in order — OAuth2
# delegated grants, app-role assignments, app/SP owners, and application (app-only)
# permissions. Ordered so the ownership + app-permission ensure-exists Application
# upserts (SyncMode 'delta') run after the app-role / OAuth2 full-syncs rather than
# clobbering them. Each phase is gated individually by its toggle.
function Invoke-EntraApplicationPhases {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string[]]$AINamePatterns = @(),
        $Timings,
        # Deliberately NOT [bool]-typed. The resolved config hands these through as an
        # empty string '' for an un-selected object, and [bool] PARAMETER binding rejects
        # '' outright ("Cannot convert value """" to type System.Boolean") — which would
        # abort the whole crawl before any phase runs. The inline `if ($SyncX)` guards
        # these replaced relied on PowerShell truthiness (where '' and $null are falsy),
        # so we keep the params untyped and gate with a truthiness `if` below to preserve
        # that exact behaviour for every shape the config yields ('', $null, $true, 'true').
        $SyncOAuth2Grants   = $false,
        $SyncAppRoles       = $false,
        $SyncAppOwners      = $false,
        $SyncAppPermissions = $false,
        $SyncPrincipalRelationships = $false
    )
    if ($SyncOAuth2Grants) {
        Sync-EntraOAuth2Grants -SystemId $SystemId -Timings $Timings
    }
    if ($SyncAppRoles) {
        Sync-EntraAppRoles -SystemId $SystemId -Timings $Timings
    }
    if ($SyncAppOwners) {
        Sync-EntraAppOwners -SystemId $SystemId -Timings $Timings
    }
    if ($SyncAppPermissions) {
        Sync-EntraAppPermissions -SystemId $SystemId -AINamePatterns $AINamePatterns -Timings $Timings
    }
    if ($SyncPrincipalRelationships) {
        Sync-EntraPrincipalRelationships -SystemId $SystemId -AINamePatterns $AINamePatterns -Timings $Timings
    }
}
