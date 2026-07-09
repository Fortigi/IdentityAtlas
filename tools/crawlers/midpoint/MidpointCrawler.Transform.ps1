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

# Maps one midPoint OrgType → a synced context record. $OrgContextMapping remaps
# org subtype → contextType (default OrgUnit). Verbatim from the inline Orgs-phase
# `$orgs | ForEach-Object { ... }` block.
function ConvertTo-MidpointOrgContextRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Org,
        $OrgContextMapping = @(),
        [int]$SystemId
    )
    return [PSCustomObject]@{
        id              = [string]$Org.oid
        externalId      = [string]$Org.oid
        displayName     = (Get-MidpointString $Org.displayName (Get-MidpointString $Org.name $Org.oid))
        contextType     = (Resolve-MappedValue -Values (Get-MidpointStringList $Org.subtype) -Rows $OrgContextMapping -KeyName 'orgSubtype' -ValName 'contextType' -Default 'OrgUnit')
        variant         = 'synced'
        targetType      = 'Identity'
        scopeSystemId   = $SystemId
        parentContextId = (Get-MidpointRefOid $Org.parentOrgRef $null)
    }
}

# Topologically sorts context records so a parent precedes its children. A parent
# OID outside the synced set is treated as a root (its parentContextId is nulled
# out to avoid an FK violation). Verbatim from the inline Orgs-phase sort.
function Get-MidpointContextsInTopologicalOrder {
    [CmdletBinding()]
    param($Records)
    $recs      = @($Records)
    $sorted    = [System.Collections.Generic.List[object]]::new()
    $remaining = [System.Collections.Generic.List[object]]::new($recs)
    $present   = [System.Collections.Generic.HashSet[string]]::new(); $recs | ForEach-Object { [void]$present.Add($_.id) }
    $inserted  = [System.Collections.Generic.HashSet[string]]::new()
    $pass = 0; $maxPass = $recs.Count + 1
    while ($remaining.Count -gt 0 -and $pass -lt $maxPass) {
        $pass++; $next = [System.Collections.Generic.List[object]]::new()
        foreach ($rec in $remaining) {
            $p = $rec.parentContextId
            # A parent outside the synced set is treated as a root (null it out)
            if (-not $p -or -not $present.Contains($p) -or $inserted.Contains($p)) {
                if ($p -and -not $present.Contains($p)) { $rec.parentContextId = $null }
                $sorted.Add($rec); [void]$inserted.Add($rec.id)
            } else { $next.Add($rec) }
        }
        $remaining = $next
    }
    foreach ($rec in $remaining) { $sorted.Add($rec) }
    return @($sorted)
}

# Maps one midPoint RoleType → a Resource record. The caller resolves $ResourceType
# (archetype/subtype classification) and $ArchetypeNames and passes them in.
# Verbatim from the inline Roles `Add-ResByType $rt ([PSCustomObject]@{ ... })`.
function ConvertTo-MidpointRoleResourceRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Role,
        [string]$ResourceType,
        [string[]]$ArchetypeNames = @()
    )
    return [PSCustomObject]@{
        id                 = [string]$Role.oid
        externalId         = [string]$Role.oid
        displayName        = (Get-MidpointString $Role.displayName (Get-MidpointString $Role.name $Role.oid))
        resourceType       = $ResourceType
        governanceResource = ($ResourceType -eq 'BusinessRole')
        description        = (Get-MidpointString $Role.description '')
        enabled            = (Test-MidpointEnabled $Role)
        extendedAttributes = @{
            name       = (Get-MidpointString $Role.name '')
            identifier = (Get-MidpointString $Role.identifier '')
            roleType   = (Get-MidpointString $Role.subtype (Get-MidpointString $Role.roleType ''))
            archetype  = ($ArchetypeNames -join ', ')
        }
    }
}

# Maps one midPoint ServiceType → a Resource record (always resourceType='Service';
# the role archetype classifier must not bleed into services). Verbatim from the
# inline Services `Add-ResByType 'Service' ([PSCustomObject]@{ ... })`.
function ConvertTo-MidpointServiceResourceRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Service)
    return [PSCustomObject]@{
        id                 = [string]$Service.oid
        externalId         = [string]$Service.oid
        displayName        = (Get-MidpointString $Service.displayName (Get-MidpointString $Service.name $Service.oid))
        resourceType       = 'Service'
        description        = (Get-MidpointString $Service.description '')
        enabled            = (Test-MidpointEnabled $Service)
        extendedAttributes = @{
            name       = (Get-MidpointString $Service.name '')
            identifier = (Get-MidpointString $Service.identifier '')
        }
    }
}

# Maps one midPoint account-kind ShadowType → an account Principal record on its
# resource system. Get-MidpointShadowLabel (MidpointCrawler.Functions.ps1) builds
# the readable label. Verbatim from the inline `$acctBySystem[$sysId].Add(...)`.
function ConvertTo-MidpointAccountShadowRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Shadow,
        [string]$ShadowOid,
        [string]$ResourceOid,
        [string]$Kind
    )
    return [PSCustomObject]@{
        id             = $ShadowOid
        externalId     = $ShadowOid
        displayName    = (Get-MidpointShadowLabel -Shadow $Shadow -ShadowOid $ShadowOid -ResourceOid $ResourceOid)
        principalType  = 'User'
        accountEnabled = (Test-MidpointEnabled $Shadow)
        extendedAttributes = @{
            accountName = (Get-MidpointString $Shadow.name '')
            resourceOid = $ResourceOid
            objectClass = (Get-MidpointString $Shadow.objectClass '')
            kind        = $Kind
            intent      = (Get-MidpointString $Shadow.intent '')
            source      = 'midpoint-shadow'
        }
    }
}

# Maps one midPoint entitlement-kind ShadowType (e.g. an AD group) → an Entitlement
# Resource record. Verbatim from the inline `$entBySystem[$sysId].Add(...)`.
function ConvertTo-MidpointEntitlementResourceRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Shadow,
        [string]$ShadowOid,
        [string]$ResourceOid
    )
    return [PSCustomObject]@{
        id           = $ShadowOid
        externalId   = $ShadowOid
        displayName  = (Format-AccountLabel (Get-MidpointString $Shadow.name $ShadowOid))
        resourceType = 'Entitlement'
        extendedAttributes = @{
            accountName = (Get-MidpointString $Shadow.name '')
            resourceOid = $ResourceOid
            objectClass = (Get-MidpointString $Shadow.objectClass '')
            intent      = (Get-MidpointString $Shadow.intent '')
            source      = 'midpoint-entitlement'
        }
    }
}

# Builds one Direct account->entitlement ResourceAssignment (consolidated on the
# owner focus principal; the source account is recorded in viaAccount).
# Verbatim from the inline `Add-IngestStreamRecord -Record ([PSCustomObject]@{...})`.
function New-MidpointEntitlementAssignmentRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$EntitlementOid,
        [Parameter(Mandatory)] [string]$OwnerOid,
        [string]$ViaAccount
    )
    return [PSCustomObject]@{
        resourceId         = $EntitlementOid
        principalId        = $OwnerOid
        assignmentType     = 'Direct'
        resourceType       = 'Entitlement'
        extendedAttributes = @{ viaAccount = $ViaAccount }
    }
}

# Builds one governed Direct role/service assignment (governance membership). $Grant
# is 'direct' (user.assignment[]) or 'inherited' (user.roleMembershipRef[]). Verbatim
# from the two near-identical inline `$ra.Add([PSCustomObject]@{ ... })` blocks.
function New-MidpointGovernanceAssignmentRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$ResourceId,
        [Parameter(Mandatory)] [string]$PrincipalId,
        [string]$ResourceType,
        [Parameter(Mandatory)] [string]$Grant
    )
    return [PSCustomObject]@{
        resourceId         = $ResourceId
        principalId        = $PrincipalId
        assignmentType     = 'Direct'
        governed           = $true
        resourceType       = $ResourceType
        extendedAttributes = @{ grant = $Grant }
    }
}

# Builds one Contains resource relationship (parent role -> child role/service/
# entitlement). Verbatim from the inline `$rr.Add([PSCustomObject]@{ ... })` blocks.
function New-MidpointContainsRelationship {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$ParentResourceId,
        [Parameter(Mandatory)] [string]$ChildResourceId
    )
    return [PSCustomObject]@{
        parentResourceId = $ParentResourceId
        childResourceId  = $ChildResourceId
        relationshipType = 'Contains'
    }
}

# Maps one access-certification case → a CertificationDecisions record. Resolves the
# work-item comment/reviewer, and only stamps principal/reviewer display names when
# the OID is a synced principal (FK safety) via the passed $UserOidToName lookup.
# Verbatim from the inline Reviews `$rec = [ordered]@{ ... }` block.
function ConvertTo-MidpointCertificationDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Case,
        [string]$CaseKey,
        [string]$CaseId,
        [string]$PrincipalOid,
        [string]$TargetOid,
        [string]$CampaignName,
        [string]$CampaignOid,
        [string]$CampaignState,
        [hashtable]$UserOidToName = @{}
    )
    $wi = $Case.workItem; $wi = if ($wi -is [System.Array]) { $wi | Select-Object -First 1 } else { $wi }
    $comment = if ($wi -and $wi.output) { (Get-MidpointString $wi.output.comment '') } else { '' }
    $reviewerOid = if ($wi) { Get-MidpointRefOid $wi.assigneeRef $null } else { $null }
    $rec = [ordered]@{
        id                   = (New-StableGuid $CaseKey)
        resourceId           = $TargetOid
        principalId          = $PrincipalOid
        decision             = (Convert-MidpointOutcome (Get-MidpointString $Case.outcome ''))
        justification        = $comment
        reviewInstanceStatus = $CampaignState
        extendedAttributes   = @{ campaign = $CampaignName; campaignOid = $CampaignOid; caseId = $CaseId; outcome = (Get-MidpointString $Case.outcome '') }
    }
    if ($UserOidToName.ContainsKey($PrincipalOid)) { $rec['principalDisplayName'] = $UserOidToName[$PrincipalOid] }
    # Only set reviewedBy when the reviewer is a synced principal (FK safety).
    if ($reviewerOid -and $UserOidToName.ContainsKey($reviewerOid)) {
        $rec['reviewedBy'] = $reviewerOid
        $rec['reviewedByDisplayName'] = $UserOidToName[$reviewerOid]
    }
    return [PSCustomObject]$rec
}
