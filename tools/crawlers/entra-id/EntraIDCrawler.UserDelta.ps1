<#
.SYNOPSIS
    Entra ID crawler — the users fetch (delta vs full) and how a delta run's
    users reach the ingest API.

.DESCRIPTION
    Full runs read /users with `$expand=manager` and prime a delta token; delta
    runs read /users/delta with that token. /users/delta cannot `$expand`, so
    the token is primed with `manager` in its `$select` (Get-EntraDeltaSelect)
    and a changed manager arrives as a `manager@delta` annotation, which
    ConvertTo-EntraPrincipalRecord turns into a managerId — or into an
    explicit null when the manager was cleared (#1627).

    Two consequences live here:

      * The token key is versioned. A token primed before #1627 does not track
        `manager` and never will, so it is stored under a new key: the first
        run after an upgrade finds no token there and takes the full path for
        users, which primes a manager-tracking token and retires the old row.

      * On a delta run the manager links travel in their own batch. Only users
        whose manager changed carry the key, and a multi-batch ingest session
        fixes its columns on its first batch and writes a NULL for every row
        that lacks one — so mixing them into the user batch would either drop
        the links (column absent from batch 1) or blank every unchanged
        manager (column present). A batch in which every record carries the
        key is exact either way.

    Dot-sourced by Start-EntraIDCrawler.ps1.
#>

#region Functions

# The delta-token key the users fetch stores its token under. The `/manager`
# suffix names the token's shape (it tracks the manager relationship), the same
# way 'groups/delta/members-owners' does for groups.
$script:EntraUsersDeltaEndpoint = 'users/delta/manager'

# The key tokens were stored under before #1627. Removed whenever a new token is
# primed, so an upgraded crawler does not keep a dead row.
$script:EntraLegacyUsersDeltaEndpoint = 'users/delta'

# Delta/full fetch of users. Full runs fetch with manager expand AND prime a
# delta token for the next run; delta runs use the stored token and fall back to
# full on 400/410. Returns @{ users; removedUserIds; newUsersToken; deltaHit }.
function Get-EntraUserData {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode = 'delta',
        [string]$UserSelect
    )
    $usersEndpoint  = $script:EntraUsersDeltaEndpoint
    $usersToken     = $null
    $newUsersToken  = $null
    $deltaHit       = $false
    $removedUserIds = @()
    $users          = $null

    if ($SyncMode -eq 'full') {
        # Explicit full: wipe any stored token so stale context can't survive.
        Remove-FGDeltaToken -SystemId $SystemId -Endpoint $usersEndpoint
    } elseif ($SyncMode -eq 'delta') {
        $usersToken = Get-FGDeltaToken -SystemId $SystemId -Endpoint $usersEndpoint
    }

    if ($usersToken) {
        Write-Host "  Delta mode: fetching only changes since last run..." -ForegroundColor Gray
        try {
            $deltaUri = "https://graph.microsoft.com/beta/users/delta?`$deltatoken=$([uri]::EscapeDataString($usersToken))"
            $resp = Invoke-FGGetDeltaRequest -URI $deltaUri
            $split = Split-FGDeltaResponse -Response $resp
            $users = $split.items
            $removedUserIds = $split.removedIds
            $newUsersToken = $resp.deltaToken
            $deltaHit = $true
            Write-Host "  Delta: $($users.Count) changed + $($removedUserIds.Count) removed" -ForegroundColor Gray
        } catch [System.InvalidOperationException] {
            Write-Host "  Delta token rejected by Graph — clearing and falling back to full fetch" -ForegroundColor Yellow
            Remove-FGDeltaToken -SystemId $SystemId -Endpoint $usersEndpoint
            $usersToken = $null
            $users = $null
        } catch {
            Write-Host "  Delta fetch failed: $($_.Exception.Message) — falling back to full" -ForegroundColor Yellow
            $usersToken = $null
            $users = $null
        }
    }

    if (-not $deltaHit) {
        # Full path: authoritative fetch with manager expand, then prime a delta
        # token (Graph only hands it out after walking the whole collection).
        $users = Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/users?`$select=$UserSelect&`$expand=manager(`$select=id)&`$top=999"
        try {
            Write-Host "  Priming delta token (walks full /users/delta once)..." -ForegroundColor DarkGray
            $primeResp = Invoke-FGGetDeltaRequest -URI "https://graph.microsoft.com/beta/users/delta?`$select=$(Get-EntraDeltaSelect -Select $UserSelect)"
            $newUsersToken = $primeResp.deltaToken
            if ($newUsersToken) {
                Write-Host "  Primed delta token for next run" -ForegroundColor DarkGray
                Remove-FGDeltaToken -SystemId $SystemId -Endpoint $script:EntraLegacyUsersDeltaEndpoint
            } else {
                Write-Host "  (priming call succeeded but no deltaLink returned — Graph may have paginated further)" -ForegroundColor DarkGray
            }
        } catch {
            Write-Host "  (delta token priming skipped: $($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }

    return @{
        users          = $users
        removedUserIds = $removedUserIds
        newUsersToken  = $newUsersToken
        deltaHit       = $deltaHit
    }
}

# Split delta principal records into the user batch (without managerId) and a
# manager batch of @{ id; managerId } for every record that carried the key —
# including an explicit null, which is how a cleared manager is said. Pure; the
# input records are not modified.
function Split-EntraDeltaManagerRecords {
    [CmdletBinding()]
    param([array]$Records = @())
    $users    = [System.Collections.Generic.List[object]]::new()
    $managers = [System.Collections.Generic.List[object]]::new()
    foreach ($rec in $Records) {
        if (-not $rec.ContainsKey('managerId')) { $users.Add($rec); continue }
        $managers.Add(@{ id = $rec['id']; managerId = $rec['managerId'] })
        $copy = $rec.Clone()
        $copy.Remove('managerId')
        $users.Add($copy)
    }
    return @{ records = @($users); managerRecords = @($managers) }
}

# Upload the user principals of one run. A full run sends one authoritative
# batch; a delta run sends the users, then their manager changes as a separate
# delta batch (see the header for why).
function Send-EntraUserRecords {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [array]$Records = @(),
        [bool]$DeltaHit = $false,
        [string[]]$DeletedIds = @()
    )
    if (-not $DeltaHit) {
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ principalType = 'User' } -Records $Records -DeletedIds $DeletedIds
        return
    }
    $split = Split-EntraDeltaManagerRecords -Records $Records
    Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode 'delta' `
        -Scope @{ principalType = 'User' } -Records $split.records -DeletedIds $DeletedIds
    if ($split.managerRecords.Count -gt 0) {
        Write-Host "  Uploading $($split.managerRecords.Count) manager change(s)..." -ForegroundColor Gray
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode 'delta' `
            -Scope @{ principalType = 'User' } -Records $split.managerRecords
    }
}

#endregion
