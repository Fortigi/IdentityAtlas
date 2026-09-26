<#
.SYNOPSIS
    Synchronise authorization data from a Microsoft SQL Server database to
    Identity Atlas via the Ingest API, using operator-written SELECT statements.

.DESCRIPTION
    Each configured statement has a target that says what its rows become:

      identities        → Identities + a Principal per row + the IdentityMember link
      principals        → Principals (+ IdentityMember when the row names an identityId)
      identity-members  → IdentityMembers
      resources         → Resources (resourceType per statement)
      assignments       → ResourceAssignments (assignmentType / governed / resourceType per statement)
      relationships     → ResourceRelationships (relationshipType per statement)
      contexts          → Contexts (contextType / targetType per statement), e.g. logical applications
      context-members   → ContextMembers, resolved against the contexts statement's catalogue

    Rows stream straight from a SqlDataReader into chunked delta upserts, so a
    40-million-row table costs one batch of memory. A full sync ends with a
    timestamp reconcile per (endpoint, scope) — POST /ingest/reconcile — instead of
    a sync session. See tools/crawlers/sql/CLAUDE.md and docs/sync/sql.md.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL (e.g. http://web:3001/api).
.PARAMETER ApiKey
    Identity Atlas crawler API key (fgc_...).
.PARAMETER JobId
    Job id for live progress reporting. 0 = standalone.
.PARAMETER ConfigPath
    Path to the JSON config file written by the dispatcher.
#>

#region Parameters
[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)
#endregion Parameters

#region Configuration
$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngestStream.ps1')
. (Join-Path $PSScriptRoot '..' 'shared' 'Get-CrawlerSystemName.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Contexts.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Phases.ps1')

$Cfg = Resolve-SqlConfig -ConfigPath $ConfigPath
#endregion Configuration

#region Main
$syncStart = Get-Date
Write-Host "`n=== SQL Database Crawler ===" -ForegroundColor Cyan
Write-Host "Source:    $(Get-SqlConnectionSummary -Cfg $Cfg)" -ForegroundColor Gray
Write-Host "Sync mode: $($Cfg.syncMode)" -ForegroundColor Gray
Write-Host "Queries:   $(@($Cfg.queries | Where-Object { $_.enabled }).Count) enabled of $($Cfg.queries.Count)" -ForegroundColor Gray

Update-CrawlerProgress -Step 'Registering system' -Pct 2
$reg   = Register-SqlSystem -Cfg $Cfg
$State = New-SqlRunState -SystemId $reg.systemId -ServerTime $reg.serverTime -Slots $Cfg.queries `
    -BatchSize $Cfg.batchSize -PageSize $Cfg.pageSize -CommandTimeout $Cfg.commandTimeout -SyncMode $Cfg.syncMode

Update-CrawlerProgress -Step 'Connecting to SQL Server' -Pct 5
$Connection = Connect-SqlSource -Cfg $Cfg
try {
    # @() as well as the helper's own guard: a single enabled query must still be
    # a one-element ARRAY here, or .Count counts the slot's keys and [0] is $null.
    $slots = @(Get-SqlSlotsInOrder -Slots $Cfg.queries)
    for ($i = 0; $i -lt $slots.Count; $i++) {
        Invoke-SqlSlot -Slot $slots[$i] -Connection $Connection -State $State -Pct (10 + [int](75 * $i / $slots.Count)) | Out-Null
    }
} finally {
    $Connection.Dispose()
}

Invoke-SqlReconcile -State $State | Out-Null
Complete-SqlRun -State $State -SyncStart $syncStart
#endregion Main
