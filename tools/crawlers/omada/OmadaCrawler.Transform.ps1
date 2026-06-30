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
    $IdCat  = if ($Identity.IDENTITYCATEGORY) { [string]$Identity.IDENTITYCATEGORY.Value } else { '' }
    $FName  = if ($Identity.FIRSTNAME)        { [string]$Identity.FIRSTNAME } else { '' }
    $LName  = if ($Identity.LASTNAME)         { [string]$Identity.LASTNAME  } else { '' }
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
        city               = if ($Identity.CITY)    { [string]$Identity.CITY    } else { '' }
        country            = Get-OmadaRefValue -Ref $Identity.COUNTRY -Fallback ''
        extendedAttributes = @{
            # Identity type/category/status
            identityType     = $IdType
            identityCategory = $IdCat
            identityStatus   = if ($Identity.IDENTITYSTATUS)   { [string]$Identity.IDENTITYSTATUS.Value }   else { '' }
            identityId       = if ($Identity.IDENTITYID)        { [string]$Identity.IDENTITYID }             else { '' }
            oisId            = if ($Identity.OISID)             { [string]$Identity.OISID }                  else { '' }
            # Contact / location
            email2           = if ($Identity.EMAIL2)            { [string]$Identity.EMAIL2 }                 else { '' }
            city             = if ($Identity.CITY)              { [string]$Identity.CITY }                   else { '' }
            zipCode          = if ($Identity.ZIPCODE)           { [string]$Identity.ZIPCODE }                else { '' }
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
            riskScore        = if ($Identity.RISKSCORE)         { [string]$Identity.RISKSCORE }              else { '' }
            riskLevel        = Get-OmadaRefValue -Ref $Identity.RISKLEVEL     -Fallback ''
            # People references
            manager          = ($Identity.MANAGER        | ForEach-Object { $_.DisplayName }) -join '; '
            identityOwner    = Get-OmadaRefValue -Ref $Identity.IDENTITYOWNER  -Fallback ''
            explicitOwners   = ($Identity.EXPLICITOWNER   | ForEach-Object { $_.DisplayName }) -join '; '
        }
    }
}

# Maps one Omada Orgunit entity → a synced context record, carrying the parent
# hierarchy link. Map-ContextTypeToAtlas (OmadaCrawler.Functions.ps1) resolves the
# context type. Verbatim from the inline Orgunit `ForEach-Object { ... }` block.
function ConvertTo-OmadaOrgUnitContextRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $OrgUnit,
        [string]$DefaultContextType
    )
    $CtxType   = Map-ContextTypeToAtlas -OmadaType (Get-OmadaRefValue -Ref $OrgUnit.OUTYPE -Fallback $DefaultContextType)
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
function Sort-OmadaContextsTopologically {
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
# and Map-IdentityTypeToAtlas. Verbatim from the inline account `ForEach-Object`.
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
        $PrincipalType = Map-IdentityTypeToAtlas -OmadaType $IdentityLookup[$IdentId].identityType
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
