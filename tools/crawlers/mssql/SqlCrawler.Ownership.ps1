<#
.SYNOPSIS
    Resource owners for the SQL Database crawler: the owner a `resources`
    statement selects becomes a real link to a person, not a string.

.DESCRIPTION
    Dot-sourced after SqlCrawler.Transform.ps1. A source that names an owner on
    an entitlement, a role or an application gives an identifier — the interface
    would otherwise show that identifier where a person belongs.

    The data model already has one way to say "X owns Y", and this follows it
    rather than adding a second (CLAUDE.md -> Assignment types;
    docs/architecture/matrix.md -> "Owner rows are their own resource"):

        Resources(<the slot's resourceType>)        <-- the owned resource
          |- ResourceRelationships(HasOwnership)
               |- Resources(ResourceOwnership)      <-- named after the owned one
                    |- ResourceAssignments(Direct)  <-- the owner

    ONE ownership resourceType, not one per owned kind. The Entra crawler can
    afford GroupOwnership / ServicePrincipalOwnership / ApplicationOwnership
    because it knows all three at compile time; here the owned type is whatever
    the operator's slot says (Entitlement, SAPRole, anything), so a
    '<that>Ownership' family would be unbounded and the consumers that filter on
    ownership (the risk engine, the report catalogue —
    app/api/src/lib/ownershipTypes.js) could not enumerate it. The owned
    resource's own type travels on the ownership row's extendedAttributes
    instead, where it is readable and costs no vocabulary.

    Three things this deliberately does NOT do:

      * It does not run unless the slot asks for it (`ownership: true`). Three
        extra rows per owned resource is not free at the sizes this crawler is
        built for — see docs/sync/mssql.md -> "What owners cost".
      * It does not invent an owner. A value matching no account this run read
        emits nothing, and is counted and reported by value, so "the owner
        column resolves for almost nothing" is visible rather than silent.
      * It does not take the raw value away. `ownerId` is an AUX contract column:
        consumed here AND still written to extendedAttributes, next to whatever
        ownerName the statement selected.
#>

#region The vocabulary

# The one ownership resourceType this crawler emits. Mirrors
# app/api/src/lib/ownershipTypes.js, which is where every consumer reads it.
$script:SqlOwnershipResourceType = 'ResourceOwnership'
$script:SqlOwnershipRelationship = 'HasOwnership'
# How many unresolvable owner values to name in the run log.
$script:SqlOwnerSampleSize = 10

# The ownership resource's external id. Namespaced with a prefix the source's
# own keys do not carry, so it cannot collide with a real resource's id; the
# Ingest API hashes it into the run's one id namespace like any other, which is
# what makes a second run upsert the same row instead of creating another.
function New-SqlOwnershipExternalId {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [string]$ResourceExternalId)
    return "ownership:$ResourceExternalId"
}

#endregion The vocabulary

#region Resolving the owner

# An owner reference as the SOURCE spells it -> the key the account is stored
# under, or $null when nothing matches.
#
# The catalogue and the directory do not have to agree on how a person is named.
# IdentityIQ's entitlements name their owner by spt_identity.id, which is exactly
# what accounts are keyed on; its logical-application catalogue names the same
# people by employee number, and that owner resolved to nobody until the
# translation below was added for it. Both spellings are tried here, in one
# place, so neither caller has to know which one its source uses.
#
# `Found` distinguishes "we looked and failed" from "there was nothing to look
# in": with no accounts in the run, an unresolved count would say the owner is
# wrong when in truth nobody checked.
function Resolve-SqlPrincipalRef {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowNull()] $State, [AllowNull()] [AllowEmptyString()] [string]$Value)
    $v = if ($null -eq $Value) { '' } else { $Value.Trim() }
    if (-not $v) { return @{ Key = $null; Found = $false; How = 'blank' } }
    if ($null -eq $State -or -not $State.HasPrincipals) { return @{ Key = $null; Found = $false; How = 'nolookup' } }
    if ($State.KnownPrincipals.ContainsKey($v)) { return @{ Key = $v; Found = $true; How = 'direct' } }
    $mapped = $null
    if ($State.PrincipalsByEmployeeId.TryGetValue($v, [ref]$mapped)) { return @{ Key = $mapped; Found = $true; How = 'employeeId' } }
    return @{ Key = $null; Found = $false; How = 'unknown' }
}

#endregion Resolving the owner

#region The tally

# What a run's owner columns produced, as plain numbers plus the values that
# matched nobody. Lives on the run state so the slot summary and the job log can
# both read it without recomputing anything.
function New-SqlOwnershipTally {
    [CmdletBinding()]
    param()
    return @{
        Resolved   = 0   # owners named by the account's own key
        Mapped     = 0   # owners named by employee number, translated
        Emitted    = 0   # ownership resources emitted (one per owned resource)
        NoLookup   = 0   # rows with an owner but no accounts in the run to match against
        Unresolved = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::Ordinal)
    }
}

function Add-SqlUnresolvedOwner {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Tally, [Parameter(Mandatory)] [string]$Value)
    $Tally.Unresolved[$Value] = 1 + ($Tally.Unresolved[$Value] ?? 0)
}

# Fold one statement's tally into the run's. Each ownership statement is counted
# and reported on its own — a run-wide tally printed per statement would restate
# the previous one's numbers — and the run's total is their sum.
function Join-SqlOwnershipTally {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Into, [Parameter(Mandatory)] [hashtable]$From)
    foreach ($k in @('Resolved', 'Mapped', 'Emitted', 'NoLookup')) { $Into[$k] += $From[$k] }
    foreach ($e in $From.Unresolved.GetEnumerator()) { $Into.Unresolved[$e.Key] = $e.Value + ($Into.Unresolved[$e.Key] ?? 0) }
}

# The owner facts of a run: counts, and the values nobody could be found for.
function Get-SqlOwnershipReport {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Tally)
    $sample = $Tally.Unresolved.GetEnumerator() | Sort-Object -Property @{ Expression = 'Value'; Descending = $true }, Key |
        Select-Object -First $script:SqlOwnerSampleSize | ForEach-Object { "'$($_.Key)' ($($_.Value))" }
    return [ordered]@{
        ownershipsEmitted      = $Tally.Emitted
        ownersKeyed            = $Tally.Resolved
        ownersMapped           = $Tally.Mapped
        ownersWithoutAccounts  = $Tally.NoLookup
        ownersUnresolved       = $Tally.Unresolved.Count
        ownersUnresolvedRows   = [int](($Tally.Unresolved.Values | Measure-Object -Sum).Sum)
        ownersUnresolvedSample = @($sample)
    }
}

# Printed once per ownership-emitting statement. An owner that matches nobody is
# the finding: the number says how much of the source's ownership did not make
# it into the model, and the values say what to look at.
function Write-SqlOwnershipReport {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Report)
    if ($Report.ownershipsEmitted) {
        $via = if ($Report.ownersMapped) { " ($($Report.ownersMapped.ToString('N0')) by employee number)" } else { '' }
        Write-Host "  $($Report.ownershipsEmitted.ToString('N0')) owner link(s) created$via" -ForegroundColor Gray
    }
    if ($Report.ownersWithoutAccounts) {
        Write-Host "  $($Report.ownersWithoutAccounts.ToString('N0')) row(s) name an owner but this run loaded no accounts to match them against; add a principals or identities query." -ForegroundColor Yellow
    }
    if ($Report.ownersUnresolved) {
        Write-Host "  $($Report.ownersUnresolvedRows.ToString('N0')) row(s) name $($Report.ownersUnresolved) owner(s) that match no account; no owner link was created and the raw value is kept as the source spells it:" -ForegroundColor Yellow
        foreach ($s in $Report.ownersUnresolvedSample) { Write-Host "    $s" -ForegroundColor Yellow }
    }
}

#endregion The tally

#region Shapers

# The three records one owned resource contributes, or $null when its owner
# cannot be resolved. Pure: the tally is the only thing mutated, and it is
# passed in. $ResourceRecord is what ConvertTo-SqlResourceRecord returned, so
# the ownership row is named after the owned resource exactly as the grid shows
# it (the "Owner @ " prefix was dropped by migration 053).
function ConvertTo-SqlOwnershipRecords {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $ResourceRecord,
        [AllowNull()] [AllowEmptyString()] [string]$Owner,
        [Parameter(Mandatory)] [hashtable]$Tally,
        [AllowNull()] $State
    )
    $raw = if ($null -eq $Owner) { '' } else { $Owner.Trim() }
    if (-not $raw) { return $null }
    $ref = Resolve-SqlPrincipalRef -State $State -Value $raw
    if (-not $ref.Found) {
        if ($ref.How -eq 'nolookup') { $Tally.NoLookup++ } else { Add-SqlUnresolvedOwner -Tally $Tally -Value $raw }
        return $null
    }
    if ($ref.How -eq 'employeeId') { $Tally.Mapped++ } else { $Tally.Resolved++ }
    $Tally.Emitted++
    $ownedId = [string]$ResourceRecord.externalId
    $ownershipId = New-SqlOwnershipExternalId -ResourceExternalId $ownedId
    return @{
        resource     = [ordered]@{
            externalId         = $ownershipId
            displayName        = [string]$ResourceRecord.displayName
            resourceType       = $script:SqlOwnershipResourceType
            # What is owned, and of what kind. `ownedResourceType` is how a
            # consumer recovers the detail a single ownership type does not
            # carry in its name.
            extendedAttributes = @{ ownedResourceId = $ownedId; ownedResourceType = [string]$ResourceRecord.resourceType }
        }
        relationship = [ordered]@{
            parentExternalId = $ownedId
            childExternalId  = $ownershipId
            relationshipType = $script:SqlOwnershipRelationship
        }
        assignment   = [ordered]@{
            resourceExternalId  = $ownershipId
            principalExternalId = $ref.Key
            assignmentType      = 'Direct'
            resourceType        = $script:SqlOwnershipResourceType
            governed            = $false
        }
    }
}

#endregion Shapers

#region Streams and the row handler

# The three extra ingest streams a `resources` slot with `ownership: true`
# feeds. Each is its OWN reconcile scope, distinct from every scope the rest of
# the run uses, so a full sync removes exactly the owner links this run did not
# see and can never touch the owned resources, the entitlement grants or another
# statement's rows.
#
# The assignment scope is forced -Keyed. An assignments STATEMENT gets its
# expectation from the source's own distinct-pair count; an owner assignment has
# no statement of its own, so without a key set it would expect zero and fail
# the run. See Get-SqlExpectation.
function New-SqlOwnershipStreams {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State)
    $t = $script:SqlOwnershipResourceType
    return @{
        ownershipResource     = New-SqlStreamSpec -State $State -Endpoint 'ingest/resources' -Scope @{ resourceType = $t } -Reconcile
        ownershipRelationship = New-SqlStreamSpec -State $State -Endpoint 'ingest/resource-relationships' `
            -Scope @{ relationshipType = $script:SqlOwnershipRelationship } -KeyFields @('parentExternalId', 'childExternalId') -Reconcile
        ownershipAssignment   = New-SqlStreamSpec -State $State -Endpoint 'ingest/resource-assignments' `
            -Scope @{ assignmentType = 'Direct'; resourceType = $t; governed = $false } `
            -KeyFields @('resourceExternalId', 'principalExternalId') -Reconcile -Keyed
    }
}

# The owner half of one resources row, emitted after the resource itself.
#
# Every record follows the OWNED resource's system, the way an assignment
# follows its resource and a relationship its parent: an owner link is a
# statement about that resource, so splitting it across systems would make the
# reconcile of one delete the other's half.
#
# A row whose owner cannot be resolved adds nothing and is counted in the
# run's ownership tally — NOT in this slot's skipped/dangling counters, which
# feed the 5% unplaced bound that fails a job. The resource itself loaded
# perfectly; an owner column that resolves for nothing is a finding to report,
# not a reason to refuse the entitlements.
function Add-SqlOwnershipRow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Row,
        [Parameter(Mandatory)] [hashtable]$Ctx,
        [Parameter(Mandatory)] $Resource,
        [int]$SystemId = 0
    )
    $owner = [string](Get-SqlMapped -Row $Row -Map $Ctx.Map -Name 'ownerId')
    $recs = ConvertTo-SqlOwnershipRecords -ResourceRecord $Resource -Owner $owner -Tally $Ctx.Ownership -State $Ctx.State
    if (-not $recs) { return }
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'ownershipResource' -SystemId $SystemId) -Record $recs.resource
    Add-SqlExpectedKey -Expectation $Ctx.Streams.ownershipResource.Expect -Key $recs.resource.externalId
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'ownershipRelationship' -SystemId $SystemId) -Record $recs.relationship
    Add-SqlExpectedKey -Expectation $Ctx.Streams.ownershipRelationship.Expect -Key "$($recs.relationship.parentExternalId)|$($recs.relationship.childExternalId)"
    Add-CrawlerIngestStreamRecord -Stream (Get-SqlSlotStream -Ctx $Ctx -Role 'ownershipAssignment' -SystemId $SystemId) -Record $recs.assignment
    Add-SqlExpectedKey -Expectation $Ctx.Streams.ownershipAssignment.Expect -Key "$($recs.assignment.resourceExternalId)|$($recs.assignment.principalExternalId)"
    # The ownership resource is a resource of this run like any other: an
    # assignments or relationships statement that names it must resolve rather
    # than be held back as dangling.
    Add-SqlKnownKey -Known $Ctx.State.KnownResources -Key $recs.resource.externalId -SystemId $SystemId -Catalog $Ctx.State.Systems
}

#endregion Streams and the row handler
