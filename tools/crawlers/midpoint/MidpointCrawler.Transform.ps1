<#
.SYNOPSIS
    Pure record-shaping functions for the midPoint crawler, extracted from
    Start-MidpointCrawler.ps1's phase bodies.

.DESCRIPTION
    Each ConvertTo-* / New-* function maps a single midPoint object to the record
    shape the Ingest API expects. They are PURE: no HTTP, no script-scope writes,
    all inputs passed as explicit parameters — so they can be unit-tested with
    in-memory fixtures and no mocks (see test/unit/MidpointCrawlerTransform.Tests.ps1).

    The function bodies are moved verbatim from the inline phase loops. They call
    the pure midPoint helpers (Get-MidpointString, Test-MidpointEnabled, …) from
    Invoke-MidpointApi.ps1 — dot-source that alongside this file.
#>

# Maps one midPoint UserType focus object → an ingest/identities record.
# $DisplayName / $Department are resolved once by the caller (they need org +
# mapping context). Verbatim from the inline Users-phase `$identRecs.Add(...)`.
function ConvertTo-MidpointIdentityRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $User,
        [string]$DisplayName,
        [string]$Department
    )
    return [PSCustomObject]@{
        id          = [string]$User.oid
        externalId  = [string]$User.oid
        displayName = $DisplayName
        givenName   = (Get-MidpointString $User.givenName '')
        surname     = (Get-MidpointString $User.familyName '')
        email       = (Get-MidpointString $User.emailAddress '')
        employeeId  = (Get-MidpointString $User.employeeNumber '')
        jobTitle    = (Get-MidpointString $User.title '')
        department  = $Department
        extendedAttributes = @{
            name           = (Get-MidpointString $User.name '')
            lifecycleState = (Get-MidpointString $User.lifecycleState '')
            emailAddress   = (Get-MidpointString $User.emailAddress '')
        }
    }
}

# Maps one midPoint UserType → its focus Principal record (the midPoint account
# itself). Verbatim from the inline Users-phase `$princByType[$pt].Add(...)`.
function ConvertTo-MidpointFocusPrincipalRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $User,
        [string]$DisplayName,
        [string]$Department,
        [string]$PrincipalType
    )
    return [PSCustomObject]@{
        id             = [string]$User.oid
        externalId     = [string]$User.oid
        displayName    = $DisplayName
        email          = (Get-MidpointString $User.emailAddress '')
        principalType  = $PrincipalType
        accountEnabled = (Test-MidpointEnabled $User)
        jobTitle       = (Get-MidpointString $User.title '')
        department     = $Department
        extendedAttributes = @{ name = (Get-MidpointString $User.name ''); source = 'midpoint-focus' }
    }
}

# Builds the IdentityMember link tying a midPoint user's focus principal to its
# identity (both keyed on the user OID). Verbatim from the inline `$memberRecs.Add`.
function New-MidpointIdentityMemberRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$Oid)
    return [PSCustomObject]@{
        identityId  = $Oid
        principalId = $Oid
        accountType = 'Primary'
        isPrimary   = $true
    }
}
