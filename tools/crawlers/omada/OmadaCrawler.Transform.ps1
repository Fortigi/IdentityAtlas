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
