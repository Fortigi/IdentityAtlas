<#
.SYNOPSIS
    Pure record-shaping functions for the Entra ID crawler, extracted from
    Start-EntraIDCrawler.ps1's Main body.

.DESCRIPTION
    Each ConvertTo-* function maps a single Microsoft Graph object to the
    hashtable record shape the Ingest API expects. They are PURE: no HTTP, no
    script-scope writes, all inputs passed as explicit parameters — so they can
    be unit-tested with in-memory Graph fixtures and no mocks (see
    test/unit/EntraIDCrawlerTransform.Tests.ps1).

    The function bodies are moved verbatim from the inline
    `$users | ForEach-Object { ... }` blocks in Start-EntraIDCrawler.ps1.

    ConvertTo-EntraPrincipalRecord calls Get-UserAttrValue
    (EntraIDCrawler.Functions.ps1) and Add-FGEntraCalculatedAttributes (Graph SDK
    helper) — dot-source those alongside this file.
#>

# Maps one Graph user object → an ingest/principals record hashtable.
# Verbatim from the inline `$records = @($users | ForEach-Object { ... })` block.
function ConvertTo-EntraPrincipalRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $User,
        [string[]]$CustomUserAttributes = @()
    )
    $rec = @{
        id               = $User.id
        displayName      = $User.displayName
        email            = $User.mail ?? $User.userPrincipalName
        accountEnabled   = [bool]$User.accountEnabled
        principalType    = 'User'
        givenName        = $User.givenName
        surname          = $User.surname
        department       = $User.department
        jobTitle         = $User.jobTitle
        companyName      = $User.companyName
        employeeId       = $User.employeeId
        createdDateTime  = $User.createdDateTime
    }
    # Manager relationship (from $expand=manager)
    if ($User.manager -and $User.manager.id) {
        $rec['managerId'] = $User.manager.id
    }

    # Build extendedAttributes: userType, externalUserState, custom attrs.
    # signInActivity DELIBERATELY does NOT live here — it goes to the
    # purpose-built PrincipalActivity table (see ConvertTo-EntraSignInActivityRecord).
    $ext = @{}
    if ($User.userType)          { $ext['userType']          = $User.userType }
    if ($User.externalUserState) { $ext['externalUserState'] = $User.externalUserState }
    if ($CustomUserAttributes.Count -gt 0) {
        foreach ($attr in $CustomUserAttributes) {
            $val = Get-UserAttrValue -User $User -AttrName $attr
            if ($null -ne $val -and $val -ne '') { $ext[$attr] = $val }
        }
    }
    # Identity-Atlas-calculated fields: portal Link and *_OuPath derived from any
    # DN-shaped value. Runs last so it sees core + every CustomUserAttribute.
    Add-FGEntraCalculatedAttributes -Object $User -Ext $ext -Type 'User' | Out-Null
    if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }
    return $rec
}

# Maps one Graph user's signInActivity → an ingest/principal-activity record, or
# $null when the user has no activity timestamps (caller filters nulls).
# Verbatim from the inline `$activityRecords = @($users | ForEach-Object { ... })` block.
function ConvertTo-EntraSignInActivityRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $User,
        [string]$AggregateResourceId = '00000000-0000-0000-0000-000000000000'
    )
    $sia = $User.signInActivity
    if ($null -eq $sia) { return $null }
    $rec = @{
        principalId   = $User.id
        resourceId    = $AggregateResourceId
        activityType  = 'SignIn'
    }
    if ($sia.lastSignInDateTime)                { $rec['lastSignInDateTime']                = $sia.lastSignInDateTime }
    if ($sia.lastNonInteractiveSignInDateTime)  { $rec['lastNonInteractiveSignInDateTime']  = $sia.lastNonInteractiveSignInDateTime }
    if ($sia.lastSuccessfulSignInDateTime)      { $rec['lastSuccessfulSignInDateTime']      = $sia.lastSuccessfulSignInDateTime }
    # Only emit a record if we have at least one timestamp — users who have
    # never signed in would otherwise produce a row with just the key columns.
    if ($rec.Count -gt 3) { return $rec }
    return $null
}

# Maps one Graph service principal → an ingest/principals record hashtable. The
# principalType is classified via Get-FGServicePrincipalType (a pure SDK helper);
# the caller buckets on the returned record's principalType.
# Verbatim from the inline `foreach ($sp in $sps) { ... }` record build.
function ConvertTo-EntraServicePrincipalRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ServicePrincipal,
        [string[]]$AINamePatterns = @()
    )
    $pt = Get-FGServicePrincipalType -ServicePrincipal $ServicePrincipal -AINamePatterns $AINamePatterns

    $rec = @{
        id             = $ServicePrincipal.id
        displayName    = $ServicePrincipal.displayName
        accountEnabled = [bool]$ServicePrincipal.accountEnabled
        principalType  = $pt
    }
    if ($ServicePrincipal.createdDateTime) { $rec['createdDateTime'] = $ServicePrincipal.createdDateTime }

    # Non-column-but-useful fields go in extendedAttributes; arrays are joined
    # to a string so jsonb filter-discovery keeps the key visible.
    $ext = @{}
    if ($ServicePrincipal.appId)                  { $ext['appId']                  = $ServicePrincipal.appId }
    if ($ServicePrincipal.servicePrincipalType)   { $ext['servicePrincipalType']   = $ServicePrincipal.servicePrincipalType }
    if ($ServicePrincipal.appOwnerOrganizationId) { $ext['appOwnerOrganizationId'] = $ServicePrincipal.appOwnerOrganizationId }
    if ($ServicePrincipal.publisherName)          { $ext['publisherName']          = $ServicePrincipal.publisherName }
    if ($ServicePrincipal.homepage)               { $ext['homepage']               = $ServicePrincipal.homepage }
    if ($ServicePrincipal.notes)                  { $ext['notes']                  = $ServicePrincipal.notes }
    if ($ServicePrincipal.tags -and $ServicePrincipal.tags.Count -gt 0) {
        $ext['tags'] = ($ServicePrincipal.tags -join ',')
    }
    if ($ServicePrincipal.servicePrincipalNames -and $ServicePrincipal.servicePrincipalNames.Count -gt 0) {
        $ext['servicePrincipalNames'] = ($ServicePrincipal.servicePrincipalNames -join ',')
    }
    Add-FGEntraCalculatedAttributes -Object $ServicePrincipal -Ext $ext -Type 'ServicePrincipal' | Out-Null
    if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }
    return $rec
}

# Maps a service principal + its matched /reports/servicePrincipalSignInActivities
# row → an ingest/principal-activity record, or $null when there is no activity
# row or no usable timestamp. The appId→activity join stays in the caller.
# Verbatim from the inline `$sps | ForEach-Object { ... }` activity build.
function ConvertTo-EntraSpActivityRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ServicePrincipal,
        $Activity,
        [string]$AggregateResourceId = '00000000-0000-0000-0000-000000000000'
    )
    if (-not $Activity) { return $null }
    $rec = @{
        principalId  = $ServicePrincipal.id
        resourceId   = $AggregateResourceId
        activityType = 'ServicePrincipalSignIn'
    }
    if ($Activity.lastSignInActivity.lastSignInDateTime) {
        $rec['lastSignInDateTime'] = $Activity.lastSignInActivity.lastSignInDateTime
    }
    if ($Activity.lastNonInteractiveSignInActivity.lastSignInDateTime) {
        $rec['lastNonInteractiveSignInDateTime'] = $Activity.lastNonInteractiveSignInActivity.lastSignInDateTime
    }
    # applicationAuthenticationClientSignInActivity + delegatedClientSignInActivity
    # aren't first-class columns — kept in extendedAttributes for risk scoring.
    $ext = @{}
    if ($Activity.applicationAuthenticationClientSignInActivity.lastSignInDateTime) {
        $ext['lastApplicationAuthSignInDateTime'] = $Activity.applicationAuthenticationClientSignInActivity.lastSignInDateTime
    }
    if ($Activity.delegatedClientSignInActivity.lastSignInDateTime) {
        $ext['lastDelegatedClientSignInDateTime'] = $Activity.delegatedClientSignInActivity.lastSignInDateTime
    }
    if ($ext.Count -gt 0) { $rec['extendedAttributes'] = $ext }
    if ($rec.Count -gt 3) { return $rec }
    return $null
}

# Resolves the mutually-exclusive base group category ("what kind of group is
# this") from the raw Graph flags. Extracted from Get-EntraGroupClassification so
# the classifier stays flat; uses guard clauses instead of an if/elseif ladder.
function Get-EntraGroupBaseCategory {
    [CmdletBinding()]
    param(
        [bool]$IsUnified,
        [bool]$IsTeam,
        [bool]$MailEnabled,
        [bool]$SecurityEnabled
    )
    if ($IsUnified) {
        if ($IsTeam) { return 'Team' }
        return 'Microsoft365'
    }
    if ($MailEnabled -and $SecurityEnabled) { return 'MailEnabledSecurity' }
    if ($MailEnabled -and -not $SecurityEnabled) { return 'DistributionList' }
    return 'SecurityGroup'
}

# Classifies a Graph group into a single, analyst-readable `groupCategory` plus a
# few orthogonal facet fields, derived purely from the raw Graph flags. Returns a
# hashtable that ConvertTo-EntraGroupResourceRecord folds into extendedAttributes.
#
# Two design rules baked in here:
#   * Dynamic-ness is read ONLY from `groupTypes` containing 'DynamicMembership' —
#     never from `membershipRule` being non-empty, because that rule text can
#     linger after a group is converted back to assigned. `groupTypes` is the
#     operative switch Azure AD itself evaluates, so it can't disagree with the
#     group's real behaviour.
#   * The dynamic aspect is folded into the single `groupCategory` label (e.g.
#     'DynamicSecurityGroup'), but only onto the three categories that actually
#     support Azure AD dynamic membership — a distribution list can never become
#     'DynamicDistributionList' even on malformed input.
function Get-EntraGroupClassification {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Group)

    $types           = @($Group.groupTypes)
    $isUnified       = $types -contains 'Unified'
    $isDynamic       = $types -contains 'DynamicMembership'
    $securityEnabled = [bool]$Group.securityEnabled
    $mailEnabled     = [bool]$Group.mailEnabled
    $isTeam          = @($Group.resourceProvisioningOptions) -contains 'Team'

    # Base category — the mutually-exclusive "what kind of group is this".
    $base = Get-EntraGroupBaseCategory -IsUnified $isUnified -IsTeam $isTeam `
        -MailEnabled $mailEnabled -SecurityEnabled $securityEnabled

    # Fold the dynamic aspect into the single readable label, guarded to the
    # categories that support Azure AD dynamic membership.
    $dynamicCapable = @('Team', 'Microsoft365', 'SecurityGroup')
    $groupCategory  = if ($isDynamic -and $base -in $dynamicCapable) { "Dynamic$base" } else { $base }

    # Cloud-mastered vs synced from on-prem AD (membership read-only in the cloud).
    $sourceOfAuthority = if ([bool]$Group.onPremisesSyncEnabled) { 'OnPremises' } else { 'Cloud' }

    # Entitlement-management can only assign membership through an assigned,
    # cloud-mastered Security or Microsoft 365 group (Teams included). Dynamic,
    # on-prem-synced, distribution and mail-enabled-security groups are ineligible.
    $accessPackageEligible = (-not $isDynamic) -and
                             ($sourceOfAuthority -eq 'Cloud') -and
                             ($base -in @('SecurityGroup', 'Microsoft365', 'Team'))

    return @{
        groupCategory         = $groupCategory
        membershipType        = if ($isDynamic) { 'Dynamic' } else { 'Assigned' }
        sourceOfAuthority     = $sourceOfAuthority
        accessPackageEligible = $accessPackageEligible
    }
}

# Maps one Graph group → an ingest/resources record (resourceType='Group').
# Verbatim from the inline `$groups | ForEach-Object { ... }` block.
function ConvertTo-EntraGroupResourceRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Group,
        [string[]]$CustomGroupAttributes = @()
    )
    $ext = @{
        groupTypes      = ($Group.groupTypes -join ',')
        securityEnabled = $Group.securityEnabled
        mailEnabled     = $Group.mailEnabled
    }
    # Raw discriminators — kept for display + power-filtering in Excel (ext_*).
    if ($null -ne $Group.onPremisesSyncEnabled) { $ext['onPremisesSyncEnabled'] = [bool]$Group.onPremisesSyncEnabled }
    if ($Group.membershipRule)                  { $ext['membershipRule'] = $Group.membershipRule }
    if ($Group.membershipRuleProcessingState)   { $ext['membershipRuleProcessingState'] = $Group.membershipRuleProcessingState }
    if (@($Group.resourceProvisioningOptions).Count -gt 0) {
        $ext['resourceProvisioningOptions'] = (@($Group.resourceProvisioningOptions) -join ',')
    }
    # Derived classification: one readable groupCategory + facets, computed once at
    # the source so the Excel export and the web-portal context plugin read the
    # same stamped value instead of each re-deriving it from the raw flags.
    $classification = Get-EntraGroupClassification -Group $Group
    foreach ($k in $classification.Keys) { $ext[$k] = $classification[$k] }

    foreach ($attr in $CustomGroupAttributes) {
        if ($null -ne $Group.$attr) { $ext[$attr] = $Group.$attr }
    }
    # Portal Link + *_OuPath for any DN-shaped custom attr (fgGroupDN,
    # onPremisesDistinguishedName via CustomGroupAttributes, etc.).
    Add-FGEntraCalculatedAttributes -Object $Group -Ext $ext -Type 'Group' | Out-Null
    return @{
        id                 = $Group.id
        displayName        = $Group.displayName
        description        = $Group.description
        resourceType       = 'Group'
        mail               = $Group.mail
        visibility         = $Group.visibility
        enabled            = $true
        createdDateTime    = $Group.createdDateTime
        extendedAttributes = $ext
    }
}

# Builds the group-ownership graph from raw (groupId, principalId) owner pairs:
# one GroupOwnership resource per owned group, a HasOwnership relationship to the
# group, and a Direct owner assignment per pair. Returns a hashtable with
# .resources / .relationships / .assignments. New-OwnershipResourceId gives the
# deterministic ownership id (EntraIDCrawler.Functions.ps1). Verbatim from the
# inline `foreach ($ow in $rawOwners) { ... }` block.
function ConvertTo-EntraGroupOwnership {
    [CmdletBinding()]
    param(
        $RawOwners,
        [hashtable]$GroupNameById = @{}
    )
    $resMap = @{}   # ownershipId -> resource record
    $relMap = @{}   # "groupId|ownershipId" -> relationship record
    $assns  = [System.Collections.Generic.List[object]]::new()
    foreach ($ow in $RawOwners) {
        $ownId = New-OwnershipResourceId -GroupId $ow.groupId
        if (-not $resMap.ContainsKey($ownId)) {
            $gname = $GroupNameById[$ow.groupId]
            if (-not $gname) { $gname = '(group)' }
            $resMap[$ownId] = @{
                id                 = $ownId
                displayName        = $gname
                resourceType       = 'GroupOwnership'
                externalId         = "entraid-ownership:$($ow.groupId)"
                extendedAttributes = @{ ownedResourceId = $ow.groupId }
            }
            $relMap["$($ow.groupId)|$ownId"] = @{
                parentResourceId = $ow.groupId
                childResourceId  = $ownId
                relationshipType = 'HasOwnership'
            }
        }
        $assns.Add(@{
            resourceId     = $ownId
            principalId    = $ow.principalId
            assignmentType = 'Direct'
            resourceType   = 'GroupOwnership'
        })
    }
    return @{
        resources     = @($resMap.Values)
        relationships = @($relMap.Values)
        assignments   = @($assns)
    }
}

# Folds one /auditLogs/signIns event into the per-(user, app) aggregate hashtable
# (passed by reference and mutated in place). Returns $true if the event was
# aggregated, $false if skipped (missing userId/appId, or the app's SP isn't in
# the index). The caller owns the skip counter. Verbatim from the $foldEvent
# scriptblock; the $script:_signin_skipped++ side effect became the $false return.
function Add-EntraSignInEventToAggregate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $SignInEvent,
        [Parameter(Mandatory)] [hashtable]$Aggregate,
        [hashtable]$AppIdToSpId = @{}
    )
    if (-not $SignInEvent.userId -or -not $SignInEvent.appId) { return $false }
    $spId = $AppIdToSpId[$SignInEvent.appId]
    if (-not $spId) { return $false }
    $key = "$($SignInEvent.userId)|$spId"
    $entry = $Aggregate[$key]
    if (-not $entry) {
        $entry = @{
            principalId  = $SignInEvent.userId
            resourceId   = $spId
            activityType = 'SignInPerApp'
            lastSignInDateTime = $SignInEvent.createdDateTime
            lastSuccessfulSignInDateTime = $null
            lastFailedSignInDateTime = $null
            signInCount = 0
        }
        $Aggregate[$key] = $entry
    }
    if ($SignInEvent.createdDateTime -gt $entry.lastSignInDateTime) {
        $entry.lastSignInDateTime = $SignInEvent.createdDateTime
    }
    $entry.signInCount++
    $errorCode = $SignInEvent.status.errorCode
    if ($null -ne $errorCode -and [int]$errorCode -eq 0) {
        if (-not $entry.lastSuccessfulSignInDateTime -or $SignInEvent.createdDateTime -gt $entry.lastSuccessfulSignInDateTime) {
            $entry.lastSuccessfulSignInDateTime = $SignInEvent.createdDateTime
        }
    } else {
        if (-not $entry.lastFailedSignInDateTime -or $SignInEvent.createdDateTime -gt $entry.lastFailedSignInDateTime) {
            $entry.lastFailedSignInDateTime = $SignInEvent.createdDateTime
        }
    }
    return $true
}

# Maps one PIM eligibility row (as emitted by the parallel fetch) → an
# ingest/resource-assignments record for an Eligible group membership.
# Verbatim from the inline `foreach ($r in $batchOutput) { ... }` record build.
function ConvertTo-EntraPimRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $EligibilityRow)
    return @{
        resourceId         = $EligibilityRow.resourceId
        principalId        = $EligibilityRow.principalId
        principalType      = $EligibilityRow.principalType
        assignmentType     = $EligibilityRow.assignmentType
        resourceType       = 'Group'
        state              = $EligibilityRow.state
        expirationDateTime = $EligibilityRow.expirationDateTime
    }
}

# Maps one entitlement-management catalog → an ingest/governance/catalogs record.
# Verbatim from the inline `$catalogs | ForEach-Object { ... }` block.
function ConvertTo-EntraGovernanceCatalogRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Catalog)
    return @{
        id               = $Catalog.id
        displayName      = $Catalog.displayName
        description      = $Catalog.description
        catalogType      = $Catalog.catalogType
        enabled          = [bool]$Catalog.isPublished
        createdDateTime  = $Catalog.createdDateTime
        modifiedDateTime = $Catalog.modifiedDateTime
    }
}

# Maps one access package → an ingest/resources record (resourceType='BusinessRole',
# governanceResource). Verbatim from the inline `$accessPackages | ForEach-Object`.
function ConvertTo-EntraAccessPackageRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $AccessPackage)
    return @{
        id                 = $AccessPackage.id
        displayName        = $AccessPackage.displayName
        description        = $AccessPackage.description
        resourceType       = 'BusinessRole'
        governanceResource = $true
        catalogId          = $AccessPackage.catalogId
        isHidden           = [bool]$AccessPackage.isHidden
        enabled            = $true
        createdDateTime    = $AccessPackage.createdDateTime
        modifiedDateTime   = $AccessPackage.modifiedDateTime
    }
}

# Maps one assignment policy → an ingest/governance/policies record, or $null when
# the access-package id can't be resolved. Verbatim from the inline
# `foreach ($pol in $policies) { ... }` block.
function ConvertTo-EntraAssignmentPolicyRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Policy)
    $apId = if ($Policy.accessPackage) { $Policy.accessPackage.id } else { $Policy.accessPackageId }
    if (-not $apId) { return $null }
    $hasAutoAdd = $false
    $hasAutoRemove = $false
    if ($Policy.automaticRequestSettings) {
        $hasAutoAdd    = [bool]$Policy.automaticRequestSettings.requestAccessForAllowedTargets
        $hasAutoRemove = [bool]$Policy.automaticRequestSettings.removeAccessWhenTargetLeavesAllowedTargets
    }
    $hasReview = $false
    if ($Policy.reviewSettings) {
        $hasReview = [bool]$Policy.reviewSettings.isEnabled
    }
    return @{
        id                 = $Policy.id
        resourceId         = $apId
        displayName        = $Policy.displayName
        description        = $Policy.description
        allowedTargetScope = $Policy.allowedTargetScope
        hasAutoAddRule     = $hasAutoAdd
        hasAutoRemoveRule  = $hasAutoRemove
        hasAccessReview    = $hasReview
        reviewSettings     = $Policy.reviewSettings
        policyConditions   = $Policy.requestorSettings
    }
}

# Maps one access-package resourceRoleScope → a Contains relationship (access
# package -> contained group/resource), or $null when the scope has no originId.
# Verbatim from the inline `foreach ($rrs in ...) { ... }` block.
function ConvertTo-EntraAccessPackageScopeRelationship {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $RoleScope,
        [Parameter(Mandatory)] [string]$AccessPackageId
    )
    $scope = $RoleScope.accessPackageResourceScope
    $role  = $RoleScope.accessPackageResourceRole
    if (-not $scope -or -not $scope.originId) { return $null }
    return @{
        parentResourceId = $AccessPackageId
        childResourceId  = $scope.originId
        relationshipType = 'Contains'
        roleName         = if ($role) { $role.displayName } else { 'Member' }
        roleOriginSystem = if ($role) { $role.originSystem } else { 'AadGroup' }
    }
}

# Maps one access-package assignment → a governed Direct BusinessRole assignment,
# or $null when the package/target is missing or the state is inactive. Caller
# owns dedup. Verbatim from the inline streaming `ForEach-Object { ... }` block.
function ConvertTo-EntraAccessPackageAssignmentRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Assignment)
    $apId     = if ($Assignment.accessPackage) { $Assignment.accessPackage.id } else { $null }
    $targetId = if ($Assignment.target) { $Assignment.target.objectId } else { $null }
    if (-not $apId -or -not $targetId) { return $null }
    $state = $Assignment.assignmentState
    # Skip non-active states (Expired, Removed, Denied)
    if ($state -and $state -notin @('Delivered', 'PendingApproval', 'Active')) { return $null }
    return @{
        resourceId         = $apId
        principalId        = $targetId
        principalType      = 'User'
        assignmentType     = 'Direct'
        resourceType       = 'BusinessRole'
        governed           = $true
        state              = $state
        assignmentStatus   = $Assignment.assignmentStatus
        expirationDateTime = $Assignment.expiredDateTime
    }
}

# Maps a distinct OAuth2 client SP id (+ its resolved info) → an Application
# resource record. Verbatim from the inline `$clientIds | ForEach-Object` block.
function ConvertTo-EntraOAuth2ClientResource {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$ClientId,
        $SpInfo
    )
    $rec = @{
        id           = $ClientId
        displayName  = $SpInfo.displayName
        resourceType = 'Application'
        enabled      = $true
    }
    $ext = @{}
    if ($SpInfo.appId)         { $ext['appId']         = $SpInfo.appId }
    if ($SpInfo.publisherName) { $ext['publisherName'] = $SpInfo.publisherName }
    if ($ext.Count -gt 0)      { $rec['extendedAttributes'] = $ext }
    return $rec
}

# Builds the OAuth2 delegated-grant graph from per-user consent grants: one
# DelegatedPermission resource per (client, api, scope), a DelegatesScope
# relationship from the client app, and a Direct assignment per consenting user.
# Returns a hashtable with .resources / .relationships / .assignments (the caller
# dedups assignments). $SpInfo maps an SP id -> @{ displayName; appId; publisherName }.
# New-OAuth2ScopeResourceId / Format-FGDelegatedPermissionName come from
# EntraIDCrawler.Functions.ps1. Verbatim from the inline `foreach ($g in $userGrants)`.
function ConvertTo-EntraOAuth2ScopeGraph {
    [CmdletBinding()]
    param(
        $UserGrants,
        [hashtable]$SpInfo = @{}
    )
    $scopeResourceMap = @{}   # scopeResId -> record
    $relMap           = @{}   # "parent|child" -> record
    $assignments      = [System.Collections.Generic.List[object]]::new()

    foreach ($g in $UserGrants) {
        Add-EntraOAuth2GrantToScopeGraph -Grant $g -SpInfo $SpInfo `
            -ScopeResourceMap $scopeResourceMap -RelMap $relMap -Assignments $assignments
    }
    return @{
        resources     = @($scopeResourceMap.Values)
        relationships = @($relMap.Values)
        assignments   = @($assignments)
    }
}

# Fold one per-user OAuth2 grant into the scope graph: one DelegatedPermission
# Resource + DelegatesScope relationship per (client, api, scope) and one Direct
# assignment (user → scope resource) per scope. Maps/list are mutated in place.
function Add-EntraOAuth2GrantToScopeGraph {
    [CmdletBinding()]
    param($Grant, [hashtable]$SpInfo, [hashtable]$ScopeResourceMap, [hashtable]$RelMap, $Assignments)
    $clientId = $Grant.clientId; $targetId = $Grant.resourceId; $userId = $Grant.principalId
    if (-not $clientId -or -not $targetId -or -not $userId) { return }

    $clientName = if ($SpInfo[$clientId]) { $SpInfo[$clientId].displayName } else { $clientId }
    $targetName = if ($SpInfo[$targetId]) { $SpInfo[$targetId].displayName } else { $targetId }
    $scopeTokens = if ($Grant.scope) { @($Grant.scope -split '\s+' | Where-Object { $_ -ne '' }) } else { @() }

    foreach ($scope in $scopeTokens) {
        $scopeResId = New-OAuth2ScopeResourceId -ClientSpId $clientId -TargetApiSpId $targetId -Scope $scope
        if (-not $ScopeResourceMap.ContainsKey($scopeResId)) {
            $ScopeResourceMap[$scopeResId] = @{
                id           = $scopeResId
                displayName  = (Format-FGDelegatedPermissionName -Scope $scope -TargetName $targetName -ClientName $clientName)
                resourceType = 'DelegatedPermission'
                enabled      = $true
                extendedAttributes = @{ clientSpId = $clientId; clientDisplayName = $clientName; targetApiSpId = $targetId; targetApiDisplayName = $targetName; scope = $scope }
            }
        }
        $relKey = "$clientId|$scopeResId"
        if (-not $RelMap.ContainsKey($relKey)) {
            $RelMap[$relKey] = @{ parentResourceId = $clientId; childResourceId = $scopeResId; relationshipType = 'DelegatesScope'; roleName = $scope; roleOriginSystem = 'OAuth2' }
        }
        $Assignments.Add(@{
            resourceId     = $scopeResId
            principalId    = $userId
            principalType  = 'User'
            assignmentType = 'Direct'
            resourceType   = 'DelegatedPermission'
            extendedAttributes = @{ grantId = $Grant.id; clientSpId = $clientId; clientDisplayName = $clientName; targetApiSpId = $targetId; targetApiDisplayName = $targetName; scope = $scope }
        })
    }
}

# Maps one enterprise-app service principal → an Application resource record (the
# app-role catalog parent). Verbatim from the inline `if (-not $appResourceMap...)`.
function ConvertTo-EntraAppRoleApplicationResource {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $ServicePrincipal)
    $rec = @{
        id           = $ServicePrincipal.id
        displayName  = $ServicePrincipal.displayName
        resourceType = 'Application'
        enabled      = $true
    }
    $ext = @{}
    if ($ServicePrincipal.appId)                     { $ext['appId']                     = $ServicePrincipal.appId }
    if ($ServicePrincipal.appRoleAssignmentRequired) { $ext['appRoleAssignmentRequired'] = $true }
    if ($ServicePrincipal.servicePrincipalType)      { $ext['servicePrincipalType']      = $ServicePrincipal.servicePrincipalType }
    if ($ext.Count -gt 0)                            { $rec['extendedAttributes']        = $ext }
    return $rec
}

# Builds the role catalog (appRoleId -> role object) for an SP, always including
# the synthetic "Default Access" role. Returns a mutable hashtable (the caller
# adds placeholder roles for unknown ids). Verbatim from the inline build.
function Get-EntraAppRoleCatalog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ServicePrincipal,
        [string]$DefaultRoleId = '00000000-0000-0000-0000-000000000000'
    )
    $rolesByGuid = @{}
    foreach ($role in @($ServicePrincipal.appRoles)) {
        if ($role -and $role.id) { $rolesByGuid[$role.id] = $role }
    }
    if (-not $rolesByGuid.ContainsKey($DefaultRoleId)) {
        $rolesByGuid[$DefaultRoleId] = [PSCustomObject]@{
            id          = $DefaultRoleId
            displayName = 'Default Access'
            value       = $null
            description = 'No specific role defined; basic access to the application.'
        }
    }
    return $rolesByGuid
}

# Builds the synthetic AppRole resource record for an (SP, role) pair.
# Verbatim from the inline `$appRoleMap[$roleResId] = @{ ... }` block.
function New-EntraAppRoleResourceRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ServicePrincipal,
        [Parameter(Mandatory)] $Role,
        [Parameter(Mandatory)] [string]$RoleResourceId
    )
    $roleName = if ($Role.displayName) { $Role.displayName } else { 'Default Access' }
    return @{
        id           = $RoleResourceId
        displayName  = "$roleName on $($ServicePrincipal.displayName)"
        resourceType = 'AppRole'
        enabled      = $true
        extendedAttributes = @{
            applicationSpId        = $ServicePrincipal.id
            applicationDisplayName = $ServicePrincipal.displayName
            appRoleId              = $Role.id
            appRoleDisplayName     = $roleName
            appRoleValue           = $Role.value
        }
    }
}

# Builds the HasAppRole relationship (application -> app role).
# Verbatim from the inline `$relMap[$relKey] = @{ ... }` block.
function New-EntraAppRoleRelationshipRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ServicePrincipal,
        [Parameter(Mandatory)] [string]$RoleResourceId,
        [Parameter(Mandatory)] [string]$RoleName
    )
    return @{
        parentResourceId = $ServicePrincipal.id
        childResourceId  = $RoleResourceId
        relationshipType = 'HasAppRole'
        roleName         = $RoleName
        roleOriginSystem = 'EntraID'
    }
}

# Builds a Direct app-role assignment record for a User- or Group-typed principal
# (the two inline blocks were identical apart from principalType).
function New-EntraAppRoleAssignmentRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$RoleResourceId,
        [Parameter(Mandatory)] $Assignment,
        [Parameter(Mandatory)] [string]$RoleId,
        [Parameter(Mandatory)] [string]$PrincipalType,
        [string]$AppDisplayName
    )
    return @{
        resourceId     = $RoleResourceId
        principalId    = $Assignment.principalId
        principalType  = $PrincipalType
        assignmentType = 'Direct'
        resourceType   = 'AppRole'
        extendedAttributes = @{
            appRoleAssignmentId = $Assignment.id
            appRoleId           = $RoleId
            createdDateTime     = $Assignment.createdDateTime
            resourceDisplayName = $AppDisplayName
        }
    }
}

# Expands one group's app-role assignments to per-user Indirect AppRole rows — the
# cartesian product of the group's role assignments and its transitive user
# members. Verbatim from the inline nested `foreach ($roleAssn) { foreach ($uid) }`.
function ConvertTo-EntraAppRoleIndirectAssignments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $RoleAssignments,
        $UserIds,
        [Parameter(Mandatory)] [string]$GroupId
    )
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($roleAssn in $RoleAssignments) {
        foreach ($uid in $UserIds) {
            $out.Add(@{
                resourceId     = $roleAssn.roleResId
                principalId    = $uid
                principalType  = 'User'
                assignmentType = 'Indirect'
                resourceType   = 'AppRole'
                extendedAttributes = @{
                    viaGroupId          = $GroupId
                    appRoleId           = $roleAssn.roleId
                    sourceAssignmentId  = $roleAssn.sourceAssignmentId
                    resourceDisplayName = $roleAssn.appName
                }
            })
        }
    }
    return @($out)
}

# Maps one directory roleDefinition → an EntraDirectoryRole resource, flattening and
# de-duping rolePermissions[].allowedResourceActions for risk scoring.
# Verbatim from the inline `foreach ($rd in $roleDefs) { ... }` block.
function ConvertTo-EntraRoleResourceRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $RoleDefinition)
    $actions = [System.Collections.Generic.List[string]]::new()
    foreach ($rp in @($RoleDefinition.rolePermissions)) {
        foreach ($a in @($rp.allowedResourceActions)) {
            if ($a) { $actions.Add([string]$a) }
        }
    }
    $uniqueActions = @($actions | Select-Object -Unique)
    return @{
        id           = $RoleDefinition.id
        displayName  = $RoleDefinition.displayName
        description  = $RoleDefinition.description
        resourceType = 'EntraDirectoryRole'
        enabled      = [bool]$RoleDefinition.isEnabled
        extendedAttributes = @{
            templateId             = $RoleDefinition.templateId
            isBuiltIn              = [bool]$RoleDefinition.isBuiltIn
            isEnabled              = [bool]$RoleDefinition.isEnabled
            roleVersion            = $RoleDefinition.version
            allowedResourceActions = $uniqueActions
            permissionCount        = $uniqueActions.Count
        }
    }
}

# Maps one active directory-role assignment → a Direct EntraDirectoryRole assignment, or
# $null when principal/role is missing. principalType comes from
# Resolve-DirectoryRolePrincipalType (EntraIDCrawler.Functions.ps1).
# Verbatim from the inline `foreach ($ra in $roleAssignments) { ... }` block.
function ConvertTo-EntraDirectoryRoleAssignment {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $RoleAssignment)
    if (-not $RoleAssignment.principalId -or -not $RoleAssignment.roleDefinitionId) { return $null }
    return @{
        resourceId     = $RoleAssignment.roleDefinitionId
        principalId    = $RoleAssignment.principalId
        principalType  = (Resolve-DirectoryRolePrincipalType -Principal $RoleAssignment.principal)
        assignmentType = 'Direct'
        resourceType   = 'EntraDirectoryRole'
        extendedAttributes = @{
            roleAssignmentId = $RoleAssignment.id
            directoryScopeId = $RoleAssignment.directoryScopeId
        }
    }
}

# Maps one PIM-eligible directory-role schedule instance → an Eligible EntraDirectoryRole
# assignment, or $null when principal/role is missing. Verbatim from the inline
# `foreach ($e in $eligibility) { ... }` block.
function ConvertTo-EntraDirectoryRoleEligibility {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Eligibility)
    if (-not $Eligibility.principalId -or -not $Eligibility.roleDefinitionId) { return $null }
    return @{
        resourceId         = $Eligibility.roleDefinitionId
        principalId        = $Eligibility.principalId
        principalType      = (Resolve-DirectoryRolePrincipalType -Principal $Eligibility.principal)
        assignmentType     = 'Eligible'
        resourceType       = 'EntraDirectoryRole'
        expirationDateTime = $Eligibility.endDateTime
        extendedAttributes = @{
            memberType       = $Eligibility.memberType
            directoryScopeId = $Eligibility.directoryScopeId
        }
    }
}

# Resolve the access-package id an access-review definition targets, tolerating
# both the old `scope.query` and newer `resourceScope.query` / `scopes[].query`
# shapes, and both the path-style (.../accessPackages/<uuid>/...) and filter-style
# ("accessPackage/id eq '<uuid>'") query forms. Returns
# @{ apId; reason; queryStrings } where reason is 'ok' | 'noscope' | 'nomatch'.
# Verbatim from the inline access-review scope-matching block.
function Resolve-EntraAccessReviewApId {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Definition)
    $queryStrings = Get-EntraReviewQueryStrings -Definition $Definition
    if ($queryStrings.Count -eq 0) {
        return @{ apId = $null; reason = 'noscope'; queryStrings = @() }
    }
    $apId = Find-EntraAccessPackageId -QueryStrings $queryStrings
    if (-not $apId) {
        return @{ apId = $null; reason = 'nomatch'; queryStrings = $queryStrings }
    }
    return @{ apId = $apId; reason = 'ok'; queryStrings = $queryStrings }
}

# Every OData filter query string on a review definition (scope / resourceScope / scopes[]).
function Get-EntraReviewQueryStrings {
    [CmdletBinding()]
    param($Definition)
    $q = @()
    if ($Definition.scope         -and $Definition.scope.query)         { $q += $Definition.scope.query }
    if ($Definition.resourceScope -and $Definition.resourceScope.query) { $q += $Definition.resourceScope.query }
    foreach ($s in @($Definition.scopes)) {
        if ($s.query) { $q += $s.query }
    }
    return $q
}

# The first access-package GUID matched in any query string (path-style or `id eq`), or $null.
function Find-EntraAccessPackageId {
    [CmdletBinding()]
    param([string[]]$QueryStrings)
    foreach ($q in $QueryStrings) {
        if ($q -match "accessPackages/([0-9a-fA-F-]{36})")           { return $Matches[1] }
        if ($q -match "accessPackage/id eq '([0-9a-fA-F-]{36})'")    { return $Matches[1] }
    }
    return $null
}

# Shape one filtered user into an Identities ingest record, carrying the
# configured custom attributes into extendedAttributes. Verbatim from the inline
# `$idRec = @{ ... }` block in the identity sub-sync. Get-UserAttrValue lives in
# EntraIDCrawler.Functions.ps1.
function ConvertTo-EntraIdentityRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $User,
        [string[]]$CustomUserAttributes = @()
    )
    $u = $User
    $idRec = @{
        id          = $u.id
        displayName = $u.displayName
        email       = $u.mail ?? $u.userPrincipalName
        department  = $u.department
        jobTitle    = $u.jobTitle
        companyName = $u.companyName
        employeeId  = $u.employeeId
    }
    # Identities also get custom attributes in extendedAttributes
    if ($CustomUserAttributes.Count -gt 0) {
        $ext = @{}
        foreach ($a in $CustomUserAttributes) {
            $v = Get-UserAttrValue -User $u -AttrName $a
            if ($null -ne $v -and $v -ne '') { $ext[$a] = $v }
        }
        if ($ext.Count -gt 0) { $idRec['extendedAttributes'] = $ext }
    }
    return $idRec
}

# Shape one access-review decision into a CertificationDecisions ingest record.
# Verbatim from the inline `$certRecords += @{ ... }` block.
function ConvertTo-EntraCertificationDecisionRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Decision,
        [Parameter(Mandatory)] $Definition,
        [Parameter(Mandatory)] $Instance,
        [string]$ApId
    )
    $d = $Decision
    return @{
        id                          = $d.id
        resourceId                  = $ApId
        principalId                 = if ($d.principal) { $d.principal.id } else { $null }
        principalDisplayName        = if ($d.principal) { $d.principal.displayName } else { $null }
        decision                    = $d.decision
        recommendation              = $d.recommendation
        justification               = $d.justification
        reviewedBy                  = if ($d.reviewedBy) { $d.reviewedBy.id } else { $null }
        reviewedByDisplayName       = if ($d.reviewedBy) { $d.reviewedBy.displayName } else { $null }
        reviewedDateTime            = $d.reviewedDateTime
        reviewDefinitionId          = $Definition.id
        reviewInstanceId            = $Instance.id
        reviewInstanceStatus        = $Instance.status
        reviewInstanceStartDateTime = $Instance.startDateTime
        reviewInstanceEndDateTime   = $Instance.endDateTime
    }
}

# direct user members. Pure; no I/O. Extracted so the expansion below stays flat.
function Get-EntraGroupAdjacency {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] $DirectMembers)
    $childGroups = @{}   # groupId -> List[string] (nested group ids)
    $directUsers = @{}   # groupId -> HashSet[string] (direct user principal ids)
    foreach ($m in $DirectMembers) {
        $gid      = [string]$m.resourceId
        $memberId = [string]$m.principalId
        if ($m.principalType -eq 'Group') {
            if (-not $childGroups.ContainsKey($gid)) {
                $childGroups[$gid] = [System.Collections.Generic.List[string]]::new()
            }
            $childGroups[$gid].Add($memberId)
        }
        else {
            if (-not $directUsers.ContainsKey($gid)) {
                $directUsers[$gid] = [System.Collections.Generic.HashSet[string]]::new()
            }
            [void]$directUsers[$gid].Add($memberId)
        }
    }
    return @{ ChildGroups = $childGroups; DirectUsers = $directUsers }
}

# Collects every user reachable below a set of seed child groups by walking the
# group-nesting graph downward. Cycle-safe ($visited) so a membership cycle
# (A∈B, B∈A) or a diamond can't loop or double-count. Pure; no I/O. Extracted
# from ConvertTo-EntraNestedGroupIndirectAssignments to keep each unit small.
function Get-EntraNestedGroupUserSet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $SeedGroups,   # child group ids directly under the root
        [Parameter(Mandatory)] $ChildGroups,  # groupId -> List[string] (nested group ids)
        [Parameter(Mandatory)] $DirectUsers   # groupId -> HashSet[string] (direct user ids)
    )
    $users   = [System.Collections.Generic.HashSet[string]]::new()
    $visited = [System.Collections.Generic.HashSet[string]]::new()
    $stack   = [System.Collections.Generic.Stack[string]]::new()
    foreach ($cg in $SeedGroups) {
        [void]$stack.Push($cg)
    }
    while ($stack.Count -gt 0) {
        $g = $stack.Pop()
        if (-not $visited.Add($g)) {
            continue
        }
        if ($DirectUsers.ContainsKey($g)) {
            foreach ($u in $DirectUsers[$g]) {
                [void]$users.Add($u)
            }
        }
        if ($ChildGroups.ContainsKey($g)) {
            foreach ($cg in $ChildGroups[$g]) {
                [void]$stack.Push($cg)
            }
        }
    }
    return $users
}

# Expands group-in-group nesting into per-user Indirect Group assignments so
# the matrix shows inherited members. Derived entirely from the direct-membership
# edges the Sync-Assignments phase already fetched (every group's /members) — no
# extra Graph calls. Mirrors how AppRole-via-group materializes Indirect rows,
# because the matrix reads a declared-only matview and never walks nesting itself.
#
# $DirectMembers is the flat edge list the members phase builds — one hashtable
# per (group, direct child) with keys: resourceId (the group), principalId (the
# child), principalType ('Group' for a nested group, else 'User').
#
# For every group that directly contains at least one nested group, we walk the
# nesting downward (cycle-safe) to collect the transitive USER set, then emit an
# Indirect row for each such user that is NOT already a Direct member of that
# group (a direct membership is the stronger statement and is emitted elsewhere).
function ConvertTo-EntraNestedGroupIndirectAssignments {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] $DirectMembers)

    $adj         = Get-EntraGroupAdjacency -DirectMembers $DirectMembers
    $childGroups = $adj.ChildGroups
    $directUsers = $adj.DirectUsers
    $out         = [System.Collections.Generic.List[object]]::new()

    foreach ($rootId in $childGroups.Keys) {
        $transitiveUsers = Get-EntraNestedGroupUserSet -SeedGroups $childGroups[$rootId] `
            -ChildGroups $childGroups -DirectUsers $directUsers
        $rootDirect = if ($directUsers.ContainsKey($rootId)) { $directUsers[$rootId] } else { $null }
        foreach ($u in $transitiveUsers) {
            if ($rootDirect -and $rootDirect.Contains($u)) {
                continue
            }
            $out.Add(@{
                resourceId     = $rootId
                principalId    = $u
                assignmentType = 'Indirect'
                resourceType   = 'Group'
                principalType  = 'User'
            })
        }
    }

    return @($out)
}
