<#
.SYNOPSIS
    Generates the Fortigi Demo Corp synthetic dataset.

.DESCRIPTION
    Emits demo-company.json with deterministic GUIDs for every entity: same
    input, same output, every run. The dataset backs both the E2E suite and the
    public demo environment, and it hides the Capture-the-Flag scenarios from
    issue #705.

    This file is a thin orchestrator. Each domain lives in its own part under
    parts/, dot-sourced below and appended into one shared state object:

      DemoState.ps1          — New-DemoGuid, the state accumulator, record builders
      DemoOrg.ps1            — systems, context tree, people, identities
      DemoEntraBase.ps1      — Entra groups / directory roles / app roles / ownership
      DemoGovernance.ps1     — IGA catalogs, business roles, policies, certifications
      DemoSalesScenario.ps1  — the Sales role-mining scenario (flags 1-7)
      DemoRoleDrift.ps1      — holders with fewer / more access than their role assigns
      DemoSharedGrants.ps1   — one group / app role granted by two business roles
      DemoConsent.ps1        — OAuth consent + shadow IT (flags 11-12)
      DemoSap.ps1            — the SAP ERP system (flag 8)
      DemoAzure.ps1          — the AzureRM system (flag 10)
      DemoActivity.ps1       — sign-in activity + the audit-report cast
      DemoVolume.ps1         — opt-in high-cardinality slice (-IncludeVolume)
      DemoRealism*.ps1       — opt-in realism slice (-IncludeRealism): ~600 staff
                               in ten departments, careers, guests, leavers,
                               nested groups, business roles, several systems

.PARAMETER IncludeVolume
    Appends the volume slice: ~520 extra synthetic groups, each with its own
    description, so the dataset holds more than 500 distinct resource
    descriptions. Off by default — the standard dataset stays the small,
    hand-reasoned company every other test and the public demo assume.
.PARAMETER IncludeRealism
    Appends the realism slice: ~600 staff across ten departments and ~55 teams,
    with careers (people who moved department and kept the old access), guests
    from three partner companies, leavers who were never cleaned up, one identity
    holding accounts in several systems, ~180 groups in naming families, nesting,
    business roles that grant groups and application roles, and an attestation
    campaign. Built to measure the custom-report and chat pipelines against
    questions that have more than one possible answer — see
    docs/reference/report-generator.md. Off by default, for the same reason as
    -IncludeVolume: it changes every row count the standard checks pin.

.EXAMPLE
    .\Generate-DemoDataset.ps1
    Writes demo-company.json next to this script (gitignored — it is a build
    artifact, always regenerate rather than relying on a committed copy).

.EXAMPLE
    .\Generate-DemoDataset.ps1 -IncludeVolume
    Same dataset plus the volume slice, for verifying the paged/searchable
    attribute-value behaviour of the matrix wizard (issue #928).
#>

[CmdletBinding()]
Param(
    [string]$OutputPath = '',
    [switch]$IncludeVolume,
    [switch]$IncludeRealism
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot 'demo-company.json' }

$partsDir = Join-Path $PSScriptRoot 'parts'
foreach ($part in @(
    'DemoState.ps1', 'DemoOrg.ps1', 'DemoEntraBase.ps1', 'DemoGovernance.ps1',
    'DemoSalesScenario.ps1', 'DemoRoleDrift.ps1', 'DemoSharedGrants.ps1',
    'DemoConsent.ps1', 'DemoSap.ps1', 'DemoAzure.ps1', 'DemoActivity.ps1',
    'DemoVolume.ps1',
    'DemoRealismPeople.ps1', 'DemoRealismPopulations.ps1', 'DemoRealismGroups.ps1', 'DemoRealismAccess.ps1',
    'DemoRealismSystems.ps1', 'DemoRealismGovernance.ps1'
)) {
    . (Join-Path $partsDir $part)
}

$state = New-DemoState

# Order matters: Org creates the systems + people every later part references,
# and EntraBase creates the resources Governance links its business roles to.
Add-DemoOrg           $state
Add-DemoEntraBase     $state
Add-DemoGovernance    $state
Add-DemoSalesScenario $state
Add-DemoRoleDrift     $state
# Shared grants runs after the drift part: it reuses the service desk resources
# that part creates, and skips memberships it already emitted.
Add-DemoSharedGrants  $state
Add-DemoConsent       $state
Add-DemoSap           $state
Add-DemoAzure         $state
# Activity runs last of the fixed parts: it reads the principals, groups and
# directory roles every earlier part created, and adds the few extra accounts
# the standard audit reports need in order to be non-empty.
Add-DemoActivity      $state

# Opt-in only: everything above is the fixed 46-resource company that the CTF
# answers, Verify-DemoDataset.ps1's exact counts and the E2E suite pin. The
# volume slice is appended last so it can never shift the ids or ordering of
# anything before it.
if ($IncludeVolume) { Add-DemoVolume $state }

# Also opt-in, and appended after the volume slice for the same reason: the
# realism slice is a second company grown on top of the first, so every id and
# every ordering above it stays exactly where it was. Its parts run in this
# order because each reads what the one before it created: people, then the
# groups they are put in, then who holds what.
if ($IncludeRealism) {
    Add-DemoRealismPeople     $state
    Add-DemoRealismGroups     $state
    Add-DemoRealismAccess     $state
    # Systems reads the group memberships (an application role is held by the
    # people in the matching group); governance reads both the groups and the
    # application roles, because a business role grants them.
    Add-DemoRealismSystems    $state
    Add-DemoRealismGovernance $state
}

# ─── Derive the system of each assignment / relationship from its resource ────
# ResourceAssignments and ResourceRelationships both carry a systemId. Rather
# than making every call site pass one (and get it wrong), derive it once here
# from the resource the row hangs off. This is what lets the ingester post each
# system's rows under its own envelope, so a full-sync reconcile only ever
# deletes within the system it is syncing.
$resourceSystem = @{}
foreach ($r in $state.Resources) { $resourceSystem[$r.id] = $r.systemId }

foreach ($a in $state.Assignments) {
    $a['systemId'] = $resourceSystem[$a.resourceId]
}
foreach ($rel in $state.Relationships) {
    $rel['systemId'] = $resourceSystem[$rel.parentResourceId]
}

# ─── Assemble & write ─────────────────────────────────────────────────────────

$dataset = [ordered]@{
    metadata = [ordered]@{
        company     = 'Fortigi Demo Corp'
        version     = '2.0'
        generatedAt = (Get-Date).ToString('o')
        description = 'Synthetic dataset for E2E testing and the public demo (issue #705) — 5 systems, 6 departments, Capture-the-Flag scenarios.'
        # Placeholder systemId -> system identity, in insertion order. The
        # ingester posts Systems first, reads the real SERIAL ids back from the
        # API response, and remaps every systemId in the payload. Never assume
        # the placeholder is the live id.
        systemKeys   = @($state.SystemKeys)
        entityCounts = [ordered]@{
            systems                = $state.Systems.Count
            principals             = $state.Principals.Count
            resources              = $state.Resources.Count
            resourceAssignments    = $state.Assignments.Count
            resourceRelationships  = $state.Relationships.Count
            identities             = $state.Identities.Count
            identityMembers        = $state.IdentityMembers.Count
            contexts               = $state.Contexts.Count
            contextMembers         = $state.ContextMembers.Count
            governanceCatalogs     = $state.Catalogs.Count
            assignmentPolicies     = $state.Policies.Count
            certificationDecisions = $state.Certifications.Count
            principalActivity      = $state.PrincipalActivity.Count
        }
    }
    systems                = @($state.Systems)
    contexts               = @($state.Contexts)
    contextMembers         = @($state.ContextMembers)
    principals             = @($state.Principals)
    resources              = @($state.Resources)
    resourceAssignments    = @($state.Assignments)
    resourceRelationships  = @($state.Relationships)
    identities             = @($state.Identities)
    identityMembers        = @($state.IdentityMembers)
    governanceCatalogs     = @($state.Catalogs)
    assignmentPolicies     = @($state.Policies)
    certificationDecisions = @($state.Certifications)
    principalActivity      = @($state.PrincipalActivity)
}

$dataset | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8

Write-Host "Demo dataset generated: $OutputPath" -ForegroundColor Green
foreach ($entry in $dataset.metadata.entityCounts.GetEnumerator()) {
    Write-Host ("  {0,-22} {1}" -f $entry.Key, $entry.Value)
}
