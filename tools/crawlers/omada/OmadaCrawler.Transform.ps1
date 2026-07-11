<#
.SYNOPSIS
    Pure record-shaping functions for the Omada crawler, extracted from
    Start-OmadaCrawler.ps1's Main body.

.DESCRIPTION
    Each ConvertTo-* function maps a single Omada OData entity to the hashtable /
    PSCustomObject record shape the Ingest API expects. They are PURE: no HTTP, no
    script-scope writes, all inputs passed as explicit parameters — so they can be
    unit-tested with in-memory fixtures and no mocks (see
    test/unit/OmadaCrawlerTransform.Tests.ps1).

    The function bodies are moved verbatim from the inline
    `... | ForEach-Object { ... }` blocks in Start-OmadaCrawler.ps1.

    These call Get-OmadaRefValue / Get-OmadaRefUid (Get-OmadaHelpers.ps1) — dot-source
    that alongside this file.
#>

# Resolves an Omada Identity's type label (the OIS.SetValue discriminator),
# defaulting to 'Employee'. Used by the lookup, the person-table filter, and the
# record mapper — extracted so the three sites can't drift.
function Get-OmadaIdentityType {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Identity)
    if ($Identity.IDENTITYTYPE) { return [string]$Identity.IDENTITYTYPE.Value }
    return 'Employee'
}

# Maps one Omada Identity entity → an ingest/identities record.
# Verbatim from the inline `$PersonIdentities | ForEach-Object { ... }` block.
function ConvertTo-OmadaIdentityRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Identity)
    $IdType = Get-OmadaIdentityType -Identity $Identity
    $IdCat  = Get-OmadaEnumStr $Identity.IDENTITYCATEGORY
    $FName  = Get-OmadaStr $Identity.FIRSTNAME
    $LName  = Get-OmadaStr $Identity.LASTNAME
    $Name   = "$FName $LName".Trim()
    if (-not $Name) { $Name = $Identity.DisplayName }
    return [PSCustomObject]@{
        id                 = [string]$Identity.UId  # Omada UId is a valid UUID
        externalId         = [string]$Identity.UId
        displayName        = $Name
        givenName          = $FName
        surname            = $LName
        email              = $Identity.EMAIL
        employeeId         = $Identity.EMPLOYEEID
        jobTitle           = $Identity.JOBTITLE
        companyName        = Get-OmadaRefValue -Ref $Identity.COMPANY -Fallback ''
        city               = Get-OmadaStr $Identity.CITY
        country            = Get-OmadaRefValue -Ref $Identity.COUNTRY -Fallback ''
        extendedAttributes = @{
            # Identity type/category/status
            identityType     = $IdType
            identityCategory = $IdCat
            identityStatus   = Get-OmadaEnumStr $Identity.IDENTITYSTATUS
            identityId       = Get-OmadaStr $Identity.IDENTITYID
            oisId            = Get-OmadaStr $Identity.OISID
            # Contact / location
            email2           = Get-OmadaStr $Identity.EMAIL2
            city             = Get-OmadaStr $Identity.CITY
            zipCode          = Get-OmadaStr $Identity.ZIPCODE
            # Validity
            validFrom        = $Identity.VALIDFROM
            validTo          = $Identity.VALIDTO
            # Org references (UIds for use as context IDs)
            ouRefId          = Get-OmadaRefUid -Ref $Identity.OUREF
            countryId        = Get-OmadaRefUid -Ref $Identity.COUNTRY
            locationId       = Get-OmadaRefUid -Ref $Identity.LOCATION
            buildingId       = Get-OmadaRefUid -Ref $Identity.BUILDING
            businessUnitId   = Get-OmadaRefUid -Ref $Identity.BUSINESSUNIT
            costCenterId     = Get-OmadaRefUid -Ref $Identity.COSTCENTER
            divisionId       = Get-OmadaRefUid -Ref $Identity.DIVISION
            subAreaId        = Get-OmadaRefUid -Ref $Identity.SUBAREA
            jobTitleRefId    = Get-OmadaRefUid -Ref $Identity.JOBTITLE_REF
            # Org display names (human-readable counterparts)
            company          = Get-OmadaRefValue -Ref $Identity.COMPANY       -Fallback ''
            ouRefName        = Get-OmadaRefValue -Ref $Identity.OUREF         -Fallback ''
            countryName      = Get-OmadaRefValue -Ref $Identity.COUNTRY       -Fallback ''
            jobTitleRef      = Get-OmadaRefValue -Ref $Identity.JOBTITLE_REF  -Fallback ''
            # Risk
            riskScore        = Get-OmadaStr $Identity.RISKSCORE
            riskLevel        = Get-OmadaRefValue -Ref $Identity.RISKLEVEL     -Fallback ''
            # People references
            manager          = Join-OmadaDisplayNames $Identity.MANAGER
            identityOwner    = Get-OmadaRefValue -Ref $Identity.IDENTITYOWNER  -Fallback ''
            explicitOwners   = Join-OmadaDisplayNames $Identity.EXPLICITOWNER
        }
    }
}

# Maps one Omada Orgunit entity → a synced context record, carrying the parent
# hierarchy link. ConvertTo-AtlasContextType (OmadaCrawler.Functions.ps1) resolves the
# context type. Verbatim from the inline Orgunit `ForEach-Object { ... }` block.
function ConvertTo-OmadaOrgUnitContextRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $OrgUnit,
        [string]$DefaultContextType
    )
    $CtxType   = ConvertTo-AtlasContextType -OmadaType (Get-OmadaRefValue -Ref $OrgUnit.OUTYPE -Fallback $DefaultContextType)
    $ParentUid = Get-OmadaRefUid -Ref $OrgUnit.PARENTOU
    return [PSCustomObject]@{
        id              = [string]$OrgUnit.UId
        externalId      = [string]$OrgUnit.UId
        displayName     = if ($OrgUnit.NAME) { $OrgUnit.NAME } else { $OrgUnit.DisplayName }
        contextType     = $CtxType
        variant         = 'synced'
        targetType      = 'Identity'
        parentContextId = if ($ParentUid) { $ParentUid } else { $Null }
    }
}

# Maps one flat (non-hierarchical) Omada context entity → a synced context record.
# Verbatim from the inline flat-context `ForEach-Object { ... }` block.
function ConvertTo-OmadaFlatContextRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Item,
        [string]$ContextType
    )
    return [PSCustomObject]@{
        id          = [string]$Item.UId
        externalId  = [string]$Item.UId
        displayName = if ($Item.NAME) { $Item.NAME } else { $Item.DisplayName }
        contextType = $ContextType
        variant     = 'synced'
        targetType  = 'Identity'
    }
}

# Topologically sorts context records so a parent always precedes its children
# (records with an unresolved/absent parent come first). Any records left in a
# cycle after MaxPasses are appended as-is. Verbatim from the inline sort.
function Get-OmadaContextsInTopologicalOrder {
    [CmdletBinding()]
    param($Records)
    $Sorted    = [System.Collections.Generic.List[object]]::new()
    $Remaining = [System.Collections.Generic.List[object]]::new(@($Records))
    $Inserted  = [System.Collections.Generic.HashSet[string]]::new()
    $Pass = 0; $MaxPasses = @($Records).Count + 1
    while ($Remaining.Count -gt 0 -and $Pass -lt $MaxPasses) {
        $Pass++
        $NextRem = [System.Collections.Generic.List[object]]::new()
        foreach ($Rec in $Remaining) {
            $ParentId = $Rec.parentContextId
            if (-not $ParentId -or $Inserted.Contains($ParentId)) {
                $Sorted.Add($Rec); $Inserted.Add($Rec.id) | Out-Null
            } else { $NextRem.Add($Rec) }
        }
        $Remaining = $NextRem
    }
    foreach ($Rec in $Remaining) { $Sorted.Add($Rec) }
    return @($Sorted)
}

# Maps one Omada User entity → an ingest/principals record, resolving principalType
# from the linked Identity's type via $IdentityLookup (IDENTITYID -> { uid; identityType })
# and ConvertTo-AtlasIdentityType. Verbatim from the inline account `ForEach-Object`.
function ConvertTo-OmadaAccountRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Account,
        [hashtable]$IdentityLookup = @{}
    )
    $ExtId = [string]$Account.UId
    $Name  = "$($Account.FIRSTNAME) $($Account.LASTNAME)".Trim()
    if (-not $Name) { $Name = $Account.DisplayName }

    $PrincipalType = 'User'
    $IdentId = if ($Account.IDENTITYREF) { [string]$Account.IDENTITYREF.IDENTITYID } else { $Null }
    if ($IdentId -and $IdentityLookup.ContainsKey($IdentId)) {
        $PrincipalType = ConvertTo-AtlasIdentityType -OmadaType $IdentityLookup[$IdentId].identityType
    }

    return [PSCustomObject]@{
        id                 = $ExtId  # Omada UId is a valid UUID
        externalId         = $ExtId
        displayName        = $Name
        email              = $Account.EMAIL
        principalType      = $PrincipalType
        accountEnabled     = $True
        jobTitle           = $Account.JOBTITLE
        extendedAttributes = @{ userName = $Account.UserName }
    }
}

# Maps one Omada User entity → an ingest/identity-members link, or $null when the
# account is inactive, has no resolvable identity, or its identity type isn't stored
# in the Identities table (avoids FK violations). Verbatim from the inline loop body.
function ConvertTo-OmadaIdentityMemberRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Account,
        [hashtable]$IdentityLookup = @{},
        $IdentityTypesForIdentityTable = @()
    )
    if ($Account.Inactive) { return $null }
    $IdentId = if ($Account.IDENTITYREF) { [string]$Account.IDENTITYREF.IDENTITYID } else { $Null }
    if (-not $IdentId -or -not $IdentityLookup.ContainsKey($IdentId)) { return $null }
    $IdentEntry = $IdentityLookup[$IdentId]
    if ($IdentityTypesForIdentityTable -notcontains $IdentEntry.identityType) { return $null }
    return [PSCustomObject]@{
        identityId  = $IdentEntry.uid   # direct UUID FK to Identities.id
        principalId = [string]$Account.UId   # direct UUID FK to Principals.id
        accountType = 'Primary'
    }
}

# Maps one Omada Resource entity → an ingest/resources record, or $null when it has
# no UId/name. ConvertTo-AtlasResourceCategory (OmadaCrawler.Functions.ps1) resolves the Atlas
# resourceType; $UserGroupMap resolves USERGROUPREF -> display name. The caller keeps
# the system-grouping. Verbatim from the inline `foreach ($Item in $AllResources)`.
function ConvertTo-OmadaResourceRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Resource,
        [hashtable]$UserGroupMap = @{}
    )
    $OmadaCat   = Get-OmadaEnumStr $Resource.ROLECATEGORY
    $AtlasType  = ConvertTo-AtlasResourceCategory -Category $OmadaCat
    $SysName    = Get-OmadaRefValue -Ref $Resource.SYSTEMREF   -Fallback ''
    $RoleType   = Get-OmadaRefValue -Ref $Resource.ROLETYPEREF -Fallback ''
    $FolderName = Get-OmadaRefValue -Ref $Resource.ROLEFOLDER  -Fallback ''
    $Status     = Get-OmadaEnumStr $Resource.RESOURCESTATUS -Fallback 'Active'
    $Enabled    = $Status -notin @('Inactive', 'Disabled', 'Deleted')
    $ExtId      = [string]$Resource.UId
    $DispName   = if ($Resource.NAME) { $Resource.NAME } else { $Resource.DisplayName }
    if (-not $ExtId -or -not $DispName) { return $null }

    $UgUId  = Get-OmadaRefUid -Ref $Resource.USERGROUPREF
    $UgName = if ($UgUId -and $UserGroupMap.ContainsKey($UgUId)) { $UserGroupMap[$UgUId] } else { '' }

    $ExplicitOwner = Join-OmadaDisplayNames $Resource.EXPLICITOWNER
    $ManualOwner   = Join-OmadaDisplayNames $Resource.MANUALOWNER

    return [PSCustomObject]@{
        id                 = $ExtId
        externalId         = $ExtId
        displayName        = $DispName
        resourceType       = $AtlasType
        governanceResource = ($AtlasType -eq 'BusinessRole')
        description        = $Resource.DESCRIPTION
        enabled            = $Enabled
        extendedAttributes = @{
            resourceCategory  = $OmadaCat
            resourceType      = $RoleType          # ROLETYPEREF.DisplayName
            roleFolder        = $FolderName        # ROLEFOLDER.DisplayName
            skipProvisioning  = if ($Null -ne $Resource.SKIPPROVISIONING) { [bool]$Resource.SKIPPROVISIONING } else { $False }
            userGroupName     = $UgName            # USERGROUPREF → Usergroup.DisplayName
            explicitOwner     = $ExplicitOwner     # EXPLICITOWNER collection
            manualOwner       = $ManualOwner        # MANUALOWNER collection
            omadaSystem       = $SysName
        }
    }
}

# Extracts the Contains relationships (parent -> each CHILDROLES child) from one
# Omada Resource. Returns an array (empty when no children). Verbatim from the
# inline `foreach ($Child in $Item.CHILDROLES)` block.
function ConvertTo-OmadaEntitlementRelationships {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Resource)
    if (-not $Resource.CHILDROLES) { return @() }
    $out = [System.Collections.Generic.List[object]]::new()
    $ParentUid = [string]$Resource.UId
    foreach ($Child in $Resource.CHILDROLES) {
        $ChildUid = Get-OmadaRefUid -Ref $Child
        if ($ChildUid) {
            $out.Add([PSCustomObject]@{
                parentResourceId = $ParentUid   # direct UUID FK to Resources.id
                childResourceId  = $ChildUid    # direct UUID FK to Resources.id
                relationshipType = 'Contains'
            })
        }
    }
    return @($out)
}

# Builds one governed Direct assignment from an Omada Resourceassignment (fanned
# out to a specific user account). Verbatim from the inline `$RaBySys[...].Add(...)`.
function New-OmadaRoleAssignmentRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$ResourceUid,
        [Parameter(Mandatory)] [string]$PrincipalId,
        [Parameter(Mandatory)] $RoleAssignment
    )
    return [PSCustomObject]@{
        resourceId         = $ResourceUid
        principalId        = $PrincipalId
        assignmentType     = 'Direct'
        governed           = $true
        extendedAttributes = @{ validFrom = $RoleAssignment.VALIDFROM; validTo = $RoleAssignment.VALIDTO }
    }
}

# Maps a Calculated Resource Assignment (connected-system account) → a derived
# Principal record, building the display name from CRA Attributes.
# Verbatim from the inline `$CaPrincipalsBySys[...].Add(...)` block.
function ConvertTo-OmadaCraPrincipalRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $CalculatedAssignment,
        [string]$AccountKey,
        [string]$AccountName,
        [string]$ResType
    )
    $Fn    = if ($CalculatedAssignment.Attributes.'FIRSTNAME') { ($CalculatedAssignment.Attributes.'FIRSTNAME' -join ' ').Trim() } else { '' }
    $Ln    = if ($CalculatedAssignment.Attributes.'LASTNAME')  { ($CalculatedAssignment.Attributes.'LASTNAME'  -join ' ').Trim() } else { '' }
    $Email = if ($CalculatedAssignment.Attributes.'EMAIL')     { ($CalculatedAssignment.Attributes.'EMAIL'     | Select-Object -First 1) } else { $Null }
    $DName = "$Fn $Ln".Trim(); if (-not $DName) { $DName = $AccountName }
    return [PSCustomObject]@{
        id             = $AccountKey
        externalId     = $AccountName
        displayName    = $DName
        email          = $Email
        principalType  = 'User'
        accountEnabled = ($CalculatedAssignment.Status -eq $True)
        extendedAttributes = @{ accountType = $ResType }
    }
}

# Maps a Calculated Resource Assignment → a governed Direct assignment, flattening
# reasons and preserving status/isManaged in extendedAttributes.
# Verbatim from the inline CRA `$Rec = [PSCustomObject]@{ ... }` block.
function ConvertTo-OmadaCraAssignmentRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $CalculatedAssignment,
        [Parameter(Mandatory)] [string]$ResourceUid,
        [Parameter(Mandatory)] [string]$PrincipalId,
        [string]$ResType,
        [string]$AccountName
    )
    $Reasons = if ($CalculatedAssignment.Reasons) {
        @($CalculatedAssignment.Reasons | ForEach-Object { $_.Description }) -join '; '
    } else { '' }
    $ExtAttr = @{
        validFrom   = $CalculatedAssignment.ValidFrom
        validTo     = $CalculatedAssignment.ValidTo
        status      = if ($CalculatedAssignment.Status -eq $True) { 'Enabled' } else { 'Disabled' }
        reasons     = $Reasons
        accountType = $ResType
        accountName = $AccountName
        isManaged   = [bool]$CalculatedAssignment.IsManaged
    }
    return [PSCustomObject]@{
        resourceId         = $ResourceUid
        principalId        = $PrincipalId
        assignmentType     = 'Direct'
        governed           = $true
        extendedAttributes = $ExtAttr
    }
}

# Builds one context-member link (Identity → context). The three Context Members
# sources (Contextassignment, direct identity refs, Employment) all emit this exact
# shape. Verbatim from the inline `$CtxMemberRecords.Add([PSCustomObject]@{ ... })`.
function New-OmadaContextMemberRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$ContextId,
        [Parameter(Mandatory)] [string]$MemberId
    )
    return [PSCustomObject]@{
        contextId  = $ContextId
        memberId   = $MemberId   # Identity.UId → matches Identities table
        memberType = 'Identity'
        addedBy    = 'sync'
    }
}
