<#
.SYNOPSIS
    Sync phases for the SCIM 2.0 crawler.

.DESCRIPTION
    One Sync-Scim* function per phase: it reads the SCIM collection through the
    mockable Invoke-ScimSearchStream boundary, shapes each object with the pure
    ConvertTo-Scim* functions in ScimCrawler.Transform.ps1, and writes them through
    the bucketed ingest writer in ScimCrawler.Functions.ps1.

    Dot-sourced into Start-ScimCrawler.ps1's own scope, so $ApiBaseUrl / $ApiKey /
    $JobId (read by the shared ingest helpers) and $Script:phaseErrors resolve from
    the caller at call time. Cross-phase state is threaded through explicit
    parameters and return values, never shared script variables.
#>

function Add-ScimPhaseError {
    [CmdletBinding()]
    param([string]$Phase, [string]$Msg)
    Write-Host "  $Phase failed: $Msg" -ForegroundColor Red
    $Script:phaseErrors.Add("${Phase}: $Msg")
}

# ─── Phase: System registration ──────────────────────────────────
# The SCIM endpoint becomes one Identity Atlas system, keyed on its base URL so a
# re-run resolves to the same row (Systems is keyed on systemType + tenantId).
# Critical: nothing downstream can be scoped without the id, so this re-throws.
function Register-ScimSystem {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$BaseUrl, [Parameter(Mandatory)][string]$SystemName)
    Write-Host "`nSystem:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Registering system' -Pct 5
    $result = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
        syncMode = 'delta'
        records  = ConvertTo-JsonArray @(@{ systemType = 'SCIM'; displayName = $SystemName; tenantId = $BaseUrl; enabled = $true; syncEnabled = $true })
    }
    $id = if ($result.systemIds) { [int]$result.systemIds[0] } elseif ($result.systemId) { [int]$result.systemId } else { 0 }
    if ($id -le 0) { throw "Could not resolve the SCIM system id after registration" }
    Write-Host "  SCIM system id: $id ($SystemName)" -ForegroundColor Green
    return $id
}

# ─── Phase: Users → Principals ───────────────────────────────────
# Streams /Users page by page; each page is shaped and handed to the writer, then
# discarded. Only the id-set and the id → principalType map survive the phase —
# the Groups phase needs them to classify members and to stamp the right
# principalType on each membership row.
# RETURNS @{ userIds; principalTypeById; count }.
function Sync-ScimUsers {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$SystemId,
        [int]$PageSize = 100,
        $Mapping,
        $SelectedAttributes,
        [string[]]$Buckets = @('User')
    )
    Write-Host "`nUsers:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing users' -Pct 20
    $userIds           = [System.Collections.Generic.HashSet[string]]::new()
    $principalTypeById = @{}
    $count             = 0
    try {
        $writer = New-ScimIngestWriter -Endpoint 'ingest/principals' -SystemId $SystemId -ScopeKey 'principalType'
        $count  = Invoke-ScimSearchStream -Endpoint 'Users' -PageSize $PageSize -OnPage {
            param($page)
            foreach ($u in $page) {
                $rec = ConvertTo-ScimPrincipalRecord -User $u -Mapping $Mapping -SelectedAttributes $SelectedAttributes
                if (-not $rec) { continue }
                [void]$userIds.Add([string]$rec.externalId)
                $principalTypeById[[string]$rec.externalId] = [string]$rec.principalType
                Add-ScimIngestRecord -Writer $writer -Bucket ([string]$rec.principalType) -Record $rec
            }
        }
        Complete-ScimIngestWriter -Writer $writer -DeclaredBuckets $Buckets
        Write-Host "  $($userIds.Count) principal(s) from $count SCIM user(s)" -ForegroundColor Green
    } catch { Add-ScimPhaseError 'Users' $_.Exception.Message }

    return @{ userIds = $userIds; principalTypeById = $principalTypeById; count = $count }
}

# ─── Phase: Groups → Resources ───────────────────────────────────
# Streams /Groups the same way. The `members` arrays are retained (groups are far
# fewer than users, and membership can only be classified once BOTH id-sets are
# complete) and handed to the members phase.
# RETURNS @{ groupIds; membership (list of @{ id; members }); count }.
function Sync-ScimGroups {
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$SystemId, [int]$PageSize = 100, $SelectedAttributes)
    Write-Host "`nGroups:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing groups' -Pct 50
    $groupIds   = [System.Collections.Generic.HashSet[string]]::new()
    $membership = [System.Collections.Generic.List[object]]::new()
    $count      = 0
    try {
        $writer = New-ScimIngestWriter -Endpoint 'ingest/resources' -SystemId $SystemId -FixedScope @{ resourceType = 'Group' }
        $count  = Invoke-ScimSearchStream -Endpoint 'Groups' -PageSize $PageSize -OnPage {
            param($page)
            foreach ($g in $page) {
                $rec = ConvertTo-ScimGroupRecord -Group $g -SelectedAttributes $SelectedAttributes
                if (-not $rec) { continue }
                [void]$groupIds.Add([string]$rec.externalId)
                [void]$membership.Add([pscustomobject]@{ id = [string]$rec.externalId; members = @($g.members) })
                Add-ScimIngestRecord -Writer $writer -Bucket 'Group' -Record $rec
            }
        }
        Complete-ScimIngestWriter -Writer $writer -DeclaredBuckets @('Group')
        Write-Host "  $($groupIds.Count) group resource(s) from $count SCIM group(s)" -ForegroundColor Green
    } catch { Add-ScimPhaseError 'Groups' $_.Exception.Message }

    return @{ groupIds = $groupIds; membership = $membership; count = $count }
}

# ─── Phase: Group members → assignments + nesting ────────────────
# User members become Direct ResourceAssignments; nested groups become Contains
# ResourceRelationships AND are expanded into per-user Indirect assignments, since
# the matrix reads a declared-only matview and never walks nesting itself.
# Member ids that match neither id-set are counted and reported, not dropped
# silently — an unresolvable member usually means the endpoint serves a resource
# type this crawler does not sync yet.
function Sync-ScimGroupMembers {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$SystemId,
        $Membership,
        $UserIds,
        $GroupIds,
        $PrincipalTypeById
    )
    Write-Host "`nGroup members:" -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing group members' -Pct 75
    try {
        $assignments   = [System.Collections.Generic.List[object]]::new()
        $relationships = [System.Collections.Generic.List[object]]::new()
        $edges         = [System.Collections.Generic.List[object]]::new()
        $unresolved    = 0

        foreach ($g in @($Membership)) {
            $shaped = ConvertTo-ScimGroupMembership -Group $g -UserIds $UserIds -GroupIds $GroupIds -PrincipalTypeById $PrincipalTypeById
            foreach ($a in $shaped.assignments)   { [void]$assignments.Add($a) }
            foreach ($r in $shaped.relationships) { [void]$relationships.Add($r) }
            foreach ($e in $shaped.edges)         { [void]$edges.Add($e) }
            $unresolved += @($shaped.unresolved).Count
        }

        $indirect = ConvertTo-ScimNestedGroupIndirectAssignments -Edges $edges -PrincipalTypeById $PrincipalTypeById
        foreach ($i in $indirect) { [void]$assignments.Add($i) }

        Send-ScimBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -Scope @{ resourceType = 'Group' } -Records @($assignments)
        Send-ScimBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -Scope @{ relationshipType = 'Contains' } -Records @($relationships)

        Write-Host "  $($assignments.Count) assignment(s) ($($indirect.Count) indirect), $($relationships.Count) Contains relationship(s)" -ForegroundColor Green
        if ($unresolved -gt 0) {
            Write-Host "  $unresolved group member(s) matched no synced user or group — skipped" -ForegroundColor Yellow
        }
    } catch { Add-ScimPhaseError 'GroupMembers' $_.Exception.Message }
}

# Thin adapter over the shared ingest-batch protocol for the phases that build a
# complete record set up front. Deliberately NOT -SkipWhenEmpty: an empty batch is
# how a full sync reconciles away rows the source no longer has.
function Send-ScimBatch {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Endpoint, [int]$SystemId, [hashtable]$Scope = @{}, $Records = @())
    Invoke-CrawlerIngestBatch -Endpoint $Endpoint -SystemId $SystemId -SyncMode 'full' -Scope $Scope `
        -Records @($Records) -IdGeneration 'deterministic' -IdPrefix (Get-ScimIdPrefix -SystemId $SystemId) | Out-Null
}

# ─── Finalise: refresh views, report phase failures ──────────────
function Complete-ScimRun {
    [CmdletBinding()]
    param()
    Update-CrawlerProgress -Step 'Refreshing views' -Pct 95
    try {
        Invoke-IngestAPI -Endpoint 'ingest/refresh-views' -Body @{} | Out-Null
        Write-Host "  Views refreshed" -ForegroundColor Green
    } catch {
        Write-Host "  View refresh failed (non-critical): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    Update-CrawlerProgress -Step 'Completed' -Pct 100
    if ($Script:phaseErrors.Count -gt 0) {
        throw "SCIM sync completed with errors: $($Script:phaseErrors -join '; ')"
    }
    Write-Host "`n=== SCIM Sync Complete ===" -ForegroundColor Green
}
