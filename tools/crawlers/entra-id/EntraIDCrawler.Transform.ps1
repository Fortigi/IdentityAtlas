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
