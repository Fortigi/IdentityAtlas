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
    Add-EntraAssignmentPolicyId -Kept $kept -PolicyId $Record.policyId
    if ([int]$rank["$($Record.origin)"] -gt [int]$rank["$($kept.origin)"]) {
        $kept.origin = $Record.origin
        $kept.originDetail = $Record.originDetail
        if ($Record.policyId) { $kept.policyId = $Record.policyId }
    }
}

# Someone can hold one package through several policies, and the assignment row
# is one per (package, person): every policy behind it is listed on that row.
function Add-EntraAssignmentPolicyId {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Kept, $PolicyId)
    if (-not $PolicyId) { return }
    if (-not $Kept.policyId) { $Kept.policyId = $PolicyId }
    if (-not $Kept.extendedAttributes) { $Kept.extendedAttributes = @{ assignmentPolicyIds = @() } }
    if ($Kept.extendedAttributes.assignmentPolicyIds -notcontains $PolicyId) {
        $Kept.extendedAttributes.assignmentPolicyIds = @($Kept.extendedAttributes.assignmentPolicyIds) + $PolicyId
    }
}

# The rule text of a policy's allowed targets. A policy may list several rules;
# group and single-user targets are not rules and stay in specificAllowedTargets.
function Get-EntraPolicyTargetRule {
    [CmdletBinding()]
    param($Targets)
    $rules = foreach ($t in @($Targets)) {
        if ($t -and "$($t.'@odata.type')" -match 'attributeRuleMembers$' -and $t.membershipRule) { [string]$t.membershipRule }
    }
    if (-not $rules) { return $null }
    return (@($rules) -join "`n")
}

# How one policy lets access be gained and lost. A setting Graph did not return
# is left out, so the column stays NULL ("the source does not say") instead of
# reading as "no".
function Get-EntraPolicyAccessDetails {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Policy)
    $details = @{}
    if ($Policy.allowedTargetScope) { $details.allowsDirectAssignment = ($Policy.allowedTargetScope -eq 'notSpecified') }
    if ($Policy.automaticRequestSettings) { $details.automaticRequestSettings = $Policy.automaticRequestSettings }
    $requestors = $Policy.requestorSettings
    if ($requestors) {
        $details.allowsRequest = [bool]$requestors.enableTargetsToSelfAddAccess -or [bool]$requestors.enableOnBehalfRequestorsToAddAccess
        $details.allowsRemovalRequest = [bool]$requestors.enableTargetsToSelfRemoveAccess -or [bool]$requestors.enableOnBehalfRequestorsToRemoveAccess
    }
    if ($Policy.requestApprovalSettings) { $details.requiresApproval = [bool]$Policy.requestApprovalSettings.isApprovalRequiredForAdd }
    if ($Policy.expiration) {
        $details.expiration = $Policy.expiration
        $details.hasExpiration = "$($Policy.expiration.type)" -in @('afterDateTime', 'afterDuration')
    }
    $rule = Get-EntraPolicyTargetRule -Targets $Policy.specificAllowedTargets
    if ($rule) { $details.targetRule = $rule }
    if ($Policy.specificAllowedTargets) { $details.extendedAttributes = @{ specificAllowedTargets = @($Policy.specificAllowedTargets) } }
    $details.participants = Get-EntraPolicyParticipants -Policy $Policy
    return $details
}
