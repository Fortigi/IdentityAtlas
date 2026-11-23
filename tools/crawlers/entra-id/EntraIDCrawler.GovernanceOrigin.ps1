<#
.SYNOPSIS
    How an access-package assignment came about: by a rule, or requested.

.DESCRIPTION
    Sets the universal `origin` of a business-role assignment from the policy
    behind it. Own file so EntraIDCrawler.Transform.ps1 stays under the
    file-length ratchet.
#>

# policy id -> how it hands out access: 'Automatic' when a rule assigns it, else
# 'Requested'. originDetail is the policy's name, within the ingest's 100 characters.
function ConvertTo-EntraPolicyOriginMap {
    [CmdletBinding()]
    param($Policies)
    $map = @{}
    foreach ($p in @($Policies)) {
        if (-not $p -or -not $p.id) { continue }
        $auto = $p.automaticRequestSettings -and [bool]$p.automaticRequestSettings.requestAccessForAllowedTargets
        $name = [string]$p.displayName
        $map[[string]$p.id] = @{
            origin       = if ($auto) { 'Automatic' } else { 'Requested' }
            originDetail = $name.Substring(0, [Math]::Min(100, $name.Length))
        }
    }
    return $map
}

# The policies' origins from Graph. A failure costs the origin, never the assignments.
function Get-EntraPolicyOriginMap {
    [CmdletBinding()]
    param()
    try {
        return ConvertTo-EntraPolicyOriginMap -Policies (Invoke-FGGetRequest -URI "https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentPolicies?`$select=id,displayName,automaticRequestSettings")
    } catch {
        Write-Host "  Could not read assignment policies, origins left empty: $($_.Exception.Message)" -ForegroundColor Yellow
        return @{}
    }
}

# Keeps one record per (package, person). Someone holding a package through two
# policies counts as Automatic if either is: the rule keeps it whatever else happens.
function Add-EntraAccessPackageAssignment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyCollection()] [System.Collections.Generic.List[hashtable]]$Records,
        [Parameter(Mandatory)] [hashtable]$Seen,
        [Parameter(Mandatory)] [hashtable]$Record
    )
    $rank = @{ Automatic = 2; Requested = 1 }
    $key = "$($Record.resourceId)|$($Record.principalId)"
    if (-not $Seen.ContainsKey($key)) {
        $Seen[$key] = $Record
        $Records.Add($Record)
        return
    }
    $kept = $Seen[$key]
    if ([int]$rank["$($Record.origin)"] -gt [int]$rank["$($kept.origin)"]) {
        $kept.origin = $Record.origin
        $kept.originDetail = $Record.originDetail
    }
}
