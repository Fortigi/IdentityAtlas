<#
.SYNOPSIS
    Shared state + record builders for the Fortigi Demo Corp dataset generator.

.DESCRIPTION
    Dot-sourced by Generate-DemoDataset.ps1 before every other part. Owns:

      * New-DemoGuid       — the deterministic GUID function (MD5 of a seed).
      * New-DemoState      — the accumulator every part appends into.
      * Add-Demo*          — one builder per entity section.

    Every part file appends through these builders rather than emitting literal
    hashtables, so the shape of a record is defined once. That keeps the parts
    readable and keeps near-identical table blocks out of the repo (the jscpd
    duplication gate fails a PR on any new clone — see .jscpd.json).

    SYSTEM IDS ARE PLACEHOLDERS. Add-DemoSystem hands out 1..N in insertion
    order and records the key→placeholder map in State.SystemKeys. The real ids
    are assigned by postgres (Systems.id is SERIAL), so Ingest-DemoDataset.ps1
    remaps every placeholder to the id the API reports back. Never assume a
    placeholder equals a live systemId.
#>

Set-StrictMode -Version Latest

# Deterministic GUID from a seed string (same input always produces same GUID).
# The 'fortigi-demo:' namespace keeps these from colliding with any other
# generator that hashes the same seeds.
function New-DemoGuid {
    param([Parameter(Mandatory)][string]$Seed)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("fortigi-demo:$Seed"))
        return [Guid]::new($bytes).ToString()
    }
    finally { $md5.Dispose() }
}

# The accumulator. Every part dot-sourced after this one appends into it; the
# orchestrator reads it back out to assemble demo-company.json.
function New-DemoState {
    # Each list is constructed inline rather than via a shared factory
    # scriptblock: PowerShell unrolls a collection returned from a scriptblock
    # into the pipeline, so an empty List comes back as $null.
    return [ordered]@{
        Systems                = [System.Collections.Generic.List[object]]::new()
        Contexts               = [System.Collections.Generic.List[object]]::new()
        ContextMembers         = [System.Collections.Generic.List[object]]::new()
        Principals             = [System.Collections.Generic.List[object]]::new()
        Resources              = [System.Collections.Generic.List[object]]::new()
        Assignments            = [System.Collections.Generic.List[object]]::new()
        Relationships          = [System.Collections.Generic.List[object]]::new()
        Identities             = [System.Collections.Generic.List[object]]::new()
        IdentityMembers        = [System.Collections.Generic.List[object]]::new()
        Catalogs               = [System.Collections.Generic.List[object]]::new()
        Policies               = [System.Collections.Generic.List[object]]::new()
        Certifications         = [System.Collections.Generic.List[object]]::new()

        # key -> placeholder systemId (1-based, insertion order)
        SystemIds              = @{}
        # ordered list of keys, parallel to Systems — the ingester's remap index
        SystemKeys             = [System.Collections.Generic.List[object]]::new()
        # guards against duplicate (context, member) pairs
        SeenContextMembers     = [System.Collections.Generic.HashSet[string]]::new()
        # employeeId -> employee record, for cross-part lookups
        EmployeesById          = [ordered]@{}
    }
}

function Add-DemoSystem {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$SystemType,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$TenantId
    )
    $placeholder = $State.Systems.Count + 1
    $State.Systems.Add(@{
        systemType  = $SystemType
        displayName = $DisplayName
        tenantId    = $TenantId
        enabled     = $true
        syncEnabled = $true
    })
    $State.SystemIds[$Key] = $placeholder
    $State.SystemKeys.Add(@{ key = $Key; systemType = $SystemType; tenantId = $TenantId })
    return $placeholder
}

function Add-DemoContext {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$ContextType,
        [Parameter(Mandatory)][int]$ScopeSystemId,
        [string]$ParentContextId,
        [string]$TargetType = 'Principal'
    )
    $rec = @{
        id            = $Id
        displayName   = $DisplayName
        contextType   = $ContextType
        targetType    = $TargetType
        variant       = 'synced'
        scopeSystemId = $ScopeSystemId
    }
    if ($ParentContextId) { $rec['parentContextId'] = $ParentContextId }
    $State.Contexts.Add($rec)
}

# De-duplicating: a principal in both a department and a team context must not
# produce two rows for the same pair (ContextMembers is keyed on contextId+memberId).
function Add-DemoContextMember {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$ContextId,
        [Parameter(Mandatory)][string]$MemberId,
        [string]$MemberType = 'Principal'
    )
    if (-not $State.SeenContextMembers.Add("$ContextId|$MemberId")) { return }
    $State.ContextMembers.Add(@{
        contextId  = $ContextId
        memberId   = $MemberId
        memberType = $MemberType
        addedBy    = 'sync'
    })
}

function Add-DemoPrincipal {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][hashtable]$Record
    )
    $State.Principals.Add($Record)
    return $Record.id
}

function Add-DemoResource {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$ResourceType,
        [Parameter(Mandatory)][int]$SystemId,
        [string]$Description,
        [string]$ExternalId,
        [string]$CatalogId,
        [hashtable]$Extended
    )
    $rec = @{
        id           = $Id
        displayName  = $DisplayName
        resourceType = $ResourceType
        systemId     = $SystemId
        enabled      = $true
    }
    if ($Description) { $rec['description']        = $Description }
    if ($ExternalId)  { $rec['externalId']         = $ExternalId }
    if ($CatalogId)   { $rec['catalogId']          = $CatalogId }
    if ($Extended)    { $rec['extendedAttributes'] = $Extended }
    $State.Resources.Add($rec)
    return $Id
}

# assignmentType is constrained to Direct | Indirect | Eligible — the only three
# the model accepts (ck_RA_assignmentType + ingest validation + the static guard
# in app/api/src/ingest/assignmentTypes.guard.test.js, which scans this folder).
# `governed` marks IGA-driven access, it is NOT a fourth assignment type.
function Add-DemoAssignment {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$ResourceId,
        [Parameter(Mandatory)][string]$PrincipalId,
        [Parameter(Mandatory)][ValidateSet('Direct', 'Indirect', 'Eligible')][string]$AssignmentType,
        [switch]$Governed,
        [string]$ResourceType,
        [hashtable]$Extended
    )
    $rec = @{
        resourceId     = $ResourceId
        principalId    = $PrincipalId
        assignmentType = $AssignmentType
    }
    if ($Governed)     { $rec['governed']           = $true }
    if ($ResourceType) { $rec['resourceType']       = $ResourceType }
    if ($Extended)     { $rec['extendedAttributes'] = $Extended }
    $State.Assignments.Add($rec)
}

# RoleName is the SOLL side of a Contains edge: what the business role assigns
# on that resource. A name containing 'Eligible' means just-in-time access, any
# other name (or none) means a standing membership — that is how the matrix
# tells "more than the role assigns" from "exactly what it assigns".
function Add-DemoRelationship {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$ParentResourceId,
        [Parameter(Mandatory)][string]$ChildResourceId,
        [Parameter(Mandatory)]
        [ValidateSet('Contains', 'GrantsAccessTo', 'DelegatesScope', 'HasAppRole',
                     'HasOwnership', 'HasAppOwnership', 'HasApplicationPermission')]
        [string]$RelationshipType,
        [string]$RoleName
    )
    $rec = @{
        parentResourceId = $ParentResourceId
        childResourceId  = $ChildResourceId
        relationshipType = $RelationshipType
    }
    if ($RoleName) { $rec['roleName'] = $RoleName }
    $State.Relationships.Add($rec)
}

function Add-DemoIdentity {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][hashtable]$Record
    )
    $State.Identities.Add($Record)
    return $Record.id
}

function Add-DemoIdentityMember {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$IdentityId,
        [Parameter(Mandatory)][string]$PrincipalId,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$AccountType,
        [bool]$IsPrimary = $false,
        [bool]$AccountEnabled = $true
    )
    $State.IdentityMembers.Add(@{
        identityId     = $IdentityId
        principalId    = $PrincipalId
        displayName    = $DisplayName
        accountType    = $AccountType
        isPrimary      = $IsPrimary
        accountEnabled = $AccountEnabled
    })
}

# ─── Convenience lookups shared across parts ──────────────────────────────────

function Get-DemoPrincipalId {
    param([Parameter(Mandatory)][string]$EmployeeId)
    return New-DemoGuid "principal-$EmployeeId"
}

function Get-DemoIdentityId {
    param([Parameter(Mandatory)][string]$EmployeeId)
    return New-DemoGuid "identity-$EmployeeId"
}

# Employees in a department who receive access grants (excludes the deliberate
# zero-assignment edge case). Used by every grant loop.
function Get-DemoProvisioned {
    param(
        [Parameter(Mandatory)]$State,
        [string]$Department
    )
    $all = @($State.EmployeesById.Values | Where-Object { -not $_.noAccess })
    if ($Department) { $all = @($all | Where-Object { $_.dept -eq $Department }) }
    return $all
}
