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
      DemoConsent.ps1        — OAuth consent + shadow IT (flags 11-12)
      DemoSap.ps1            — the SAP ERP system (flag 8)
      DemoAzure.ps1          — the AzureRM system (flag 10)
      DemoVolume.ps1         — opt-in high-cardinality slice (-IncludeVolume)

.PARAMETER IncludeVolume
    Appends the volume slice: ~520 extra synthetic groups, each with its own
    description, so the dataset holds more than 500 distinct resource
    descriptions. Off by default — the standard dataset stays the small,
    hand-reasoned company every other test and the public demo assume.

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
    [switch]$IncludeVolume
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot 'demo-company.json' }

$partsDir = Join-Path $PSScriptRoot 'parts'
foreach ($part in @(
    'DemoState.ps1', 'DemoOrg.ps1', 'DemoEntraBase.ps1', 'DemoGovernance.ps1',
    'DemoSalesScenario.ps1', 'DemoConsent.ps1', 'DemoSap.ps1', 'DemoAzure.ps1',
    'DemoVolume.ps1'
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
Add-DemoConsent       $state
Add-DemoSap           $state
Add-DemoAzure         $state

# Opt-in only: everything above is the fixed 39-resource company that the CTF
# answers, Verify-DemoDataset.ps1's exact counts and the E2E suite pin. The
# volume slice is appended last so it can never shift the ids or ordering of
# anything before it.
if ($IncludeVolume) { Add-DemoVolume $state }

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
}

$dataset | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8

Write-Host "Demo dataset generated: $OutputPath" -ForegroundColor Green
foreach ($entry in $dataset.metadata.entityCounts.GetEnumerator()) {
    Write-Host ("  {0,-22} {1}" -f $entry.Key, $entry.Value)
}
