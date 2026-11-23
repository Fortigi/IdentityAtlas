<#
.SYNOPSIS
    Who approves, reviews and may request an access package, per policy.

.DESCRIPTION
    Turns the policy's approval stages, review settings and requestor settings
    into one list of participants, in source-neutral words. Another crawler can
    send the same list on ingest/governance/policies.
#>

$script:EntraSubjectTypes = @{
    singleUser                   = 'User'
    groupMembers                 = 'Group'
    requestorManager             = 'Manager'
    targetManager                = 'Manager'
    internalSponsors             = 'Sponsor'
    externalSponsors             = 'Sponsor'
    connectedOrganizationMembers = 'Organization'
    attributeRuleMembers         = 'Rule'
    allUsers                     = 'Everyone'
}

$script:EntraScopeLabels = @{
    allMemberUsers                          = 'All member users'
    allDirectoryUsers                       = 'All users, including guests'
    allDirectoryServicePrincipals           = 'All service principals'
    allExternalUsers                        = 'All external users'
    allConfiguredConnectedOrganizationUsers = 'All users of connected organizations'
}

# One Graph subject set -> a participant.
function ConvertTo-EntraParticipant {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Subject,
        [Parameter(Mandatory)] [string]$Participation,
        [int]$Stage = 0,
        [switch]$IsFallback,
        [switch]$OnBehalf
    )
    $odataType = ("$($Subject.'@odata.type')" -split '\.')[-1]
    $subjectType = $script:EntraSubjectTypes[$odataType]
    $record = @{
        participation = $Participation
        subjectType   = if ($subjectType) { $subjectType } else { 'Other' }
        displayName   = $Subject.description
        isFallback    = [bool]$IsFallback
        onBehalf      = [bool]$OnBehalf
        stage         = $Stage
    }
    if ($Subject.userId) { $record.principalId = [string]$Subject.userId }
    if ($Subject.groupId) { $record.groupId = [string]$Subject.groupId }
    if ($Subject.membershipRule) { $record.rule = [string]$Subject.membershipRule }
    if ($Subject.managerLevel) { $record.managerLevel = [int]$Subject.managerLevel }
    return $record
}

# The approvers of one stage: its primary ones, then everyone who steps in.
function Get-EntraStageApprovers {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Stage, [Parameter(Mandatory)] [int]$Number)
    foreach ($s in @($Stage.primaryApprovers)) {
        if ($s) { ConvertTo-EntraParticipant -Subject $s -Participation 'Approver' -Stage $Number }
    }
    $standIns = @($Stage.fallbackPrimaryApprovers) + @($Stage.escalationApprovers) + @($Stage.fallbackEscalationApprovers)
    foreach ($s in $standIns) {
        if ($s) { ConvertTo-EntraParticipant -Subject $s -Participation 'Approver' -Stage $Number -IsFallback }
    }
}

function Get-EntraApproverParticipants {
    [CmdletBinding()]
    param($Settings)
    $stageNumber = 0
    foreach ($stage in @($Settings.stages)) {
        if (-not $stage) { continue }
        $stageNumber++
        Get-EntraStageApprovers -Stage $stage -Number $stageNumber
    }
}

function Get-EntraReviewerParticipants {
    [CmdletBinding()]
    param($Settings)
    if (-not $Settings -or $Settings.isEnabled -eq $false) { return }
    if ($Settings.isSelfReview) {
        @{ participation = 'Reviewer'; subjectType = 'Self'; displayName = 'The person themselves'; isFallback = $false; onBehalf = $false; stage = 0 }
    }
    foreach ($s in @($Settings.primaryReviewers)) { if ($s) { ConvertTo-EntraParticipant -Subject $s -Participation 'Reviewer' } }
    foreach ($s in @($Settings.fallbackReviewers)) { if ($s) { ConvertTo-EntraParticipant -Subject $s -Participation 'Reviewer' -IsFallback } }
}

# Who may request it: the scope for themselves, and who may ask on someone's behalf.
function Get-EntraRequestorParticipants {
    [CmdletBinding()]
    param($Policy)
    $settings = $Policy.requestorSettings
    if (-not $settings) { return }
    if ($settings.enableTargetsToSelfAddAccess) {
        $label = $script:EntraScopeLabels["$($Policy.allowedTargetScope)"]
        if ($label) {
            @{ participation = 'Requestor'; subjectType = 'Everyone'; displayName = $label; isFallback = $false; onBehalf = $false; stage = 0 }
        }
        foreach ($s in @($Policy.specificAllowedTargets)) { if ($s) { ConvertTo-EntraParticipant -Subject $s -Participation 'Requestor' } }
    }
    if ($settings.enableOnBehalfRequestorsToAddAccess) {
        foreach ($s in @($settings.onBehalfRequestors)) { if ($s) { ConvertTo-EntraParticipant -Subject $s -Participation 'Requestor' -OnBehalf } }
    }
}

# Everyone involved in one policy, as one array.
function Get-EntraPolicyParticipants {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Policy)
    $all = [System.Collections.Generic.List[hashtable]]::new()
    $approvers = if ($Policy.requestApprovalSettings.isApprovalRequiredForAdd) { Get-EntraApproverParticipants -Settings $Policy.requestApprovalSettings }
    foreach ($p in @($approvers)) { if ($p) { $all.Add($p) } }
    foreach ($p in @(Get-EntraReviewerParticipants -Settings $Policy.reviewSettings)) { if ($p) { $all.Add($p) } }
    foreach ($p in @(Get-EntraRequestorParticipants -Policy $Policy)) { if ($p) { $all.Add($p) } }
    return , @($all)
}
