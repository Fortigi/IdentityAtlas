<#
.SYNOPSIS
    Synchronise any SCIM 2.0 service provider to Identity Atlas via the Ingest API.

.DESCRIPTION
    Reads the standard SCIM 2.0 resource types (RFC 7643/7644) and maps them onto
    the Identity Atlas universal data model:

      SCIM User               → Principals (principalType from the userType mapping)
      SCIM Group              → Resources (resourceType='Group')
      Group user member       → ResourceAssignments (Direct)
      Group nested-group      → ResourceRelationships (Contains) + per-user Indirect
                                ResourceAssignments on the outer group

    Nothing here is vendor-specific: the endpoint's own /ServiceProviderConfig,
    /ResourceTypes and /Schemas drive the wizard's object and attribute pickers, and
    the crawler only ever calls the standard /Users and /Groups collections.

    IDS — a SCIM id is an arbitrary string, so every batch is sent with
    idGeneration='deterministic' and idPrefix='scim-sys<systemId>'. The raw SCIM id
    is preserved in externalId and the UUID primary key is derived from it, which
    makes re-runs idempotent by construction.

    SAFE SYNC SCOPING — full-sync reconcile is scoped to this crawler's own systemId
    (and, for principals, bucketed per mapped principalType) so a SCIM sync can never
    delete another source's rows.

    NO DELTA — SCIM 2.0 has no standard change feed or watermark, so v1 is full-sync
    only. A delta-mode request runs as a full sync and says so in the log.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL (e.g. http://web:3001/api).
.PARAMETER ApiKey
    Identity Atlas crawler API key (fgc_...).
.PARAMETER JobId
    Job ID for live progress reporting. 0 = standalone.
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
. (Join-Path $PSScriptRoot 'ScimCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'ScimCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'ScimCrawler.Phases.ps1')

$ScimCfg = Resolve-ScimConfig -ConfigPath $ConfigPath
$Cfg     = $ScimCfg.cfg
$Sync    = $ScimCfg.sync
#endregion Configuration

#region Main
$Script:phaseErrors = [System.Collections.Generic.List[string]]::new()

Write-Host "`n=== SCIM 2.0 Crawler ===" -ForegroundColor Cyan
Write-Host "Base URL:    $($Cfg.baseUrl)" -ForegroundColor Gray
Write-Host "Auth method: $($Cfg.authMethod)" -ForegroundColor Gray
if ($ScimCfg.requestedMode -ne 'full') {
    Write-Host "Sync mode:   $($ScimCfg.requestedMode) requested — running a FULL sync (SCIM 2.0 has no standard change feed)" -ForegroundColor Yellow
}

Update-CrawlerProgress -Step 'Authenticating to the SCIM endpoint' -Pct 2
Connect-ScimAPI -BaseUrl $Cfg.baseUrl -AuthMethod $Cfg.authMethod `
    -Username ([string]$Cfg.username) -Password ([string]$Cfg.password) -ApiToken ([string]$Cfg.apiToken) `
    -ClientId ([string]$Cfg.clientId) -ClientSecret ([string]$Cfg.clientSecret) `
    -TokenEndpoint ([string]$Cfg.tokenEndpoint) -Scope ([string]$Cfg.scope)

$SystemId = Register-ScimSystem -BaseUrl $script:ScimSession.BaseUrl -SystemName $ScimCfg.systemName

$UserIds           = [System.Collections.Generic.HashSet[string]]::new()
$PrincipalTypeById = @{}
$Groups            = $null

# ─── Users → Principals ──────────────────────────────────────────
if ($Sync.users) {
    $userResult        = Sync-ScimUsers -SystemId $SystemId -PageSize $ScimCfg.pageSize `
        -Mapping $ScimCfg.userTypeMapping -SelectedAttributes $ScimCfg.userAttributes -Buckets $ScimCfg.principalBuckets
    $UserIds           = $userResult.userIds
    $PrincipalTypeById = $userResult.principalTypeById
}

# ─── Groups → Resources ──────────────────────────────────────────
if ($Sync.groups) {
    $Groups = Sync-ScimGroups -SystemId $SystemId -PageSize $ScimCfg.pageSize -SelectedAttributes $ScimCfg.groupAttributes
}

# ─── Group members → assignments + nesting ───────────────────────
# $Groups is $null unless the Groups phase ran, so it already implies $Sync.groups.
if ($Sync.groupMembers -and $Groups) {
    Sync-ScimGroupMembers -SystemId $SystemId -Membership $Groups.membership `
        -UserIds $UserIds -GroupIds $Groups.groupIds -PrincipalTypeById $PrincipalTypeById
}

Complete-ScimRun
#endregion Main
