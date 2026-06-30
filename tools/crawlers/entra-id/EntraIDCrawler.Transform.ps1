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

# Maps one Graph group → an ingest/resources record (resourceType='EntraGroup').
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
        resourceType       = 'EntraGroup'
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
                displayName        = "Owner @ $gname"
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
        resourceType       = 'EntraGroup'
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
