<#
.SYNOPSIS
    Syncs users, projects, teams, and security groups from an Azure DevOps organization
    into IdentityAtlas via the Ingest API.

.DESCRIPTION
    Standalone crawler that fetches data from the Azure DevOps REST API and POSTs it to
    the Ingest API. Authenticates via Personal Access Token (PAT).

    Data synced per enabled scope:
      - Users:    Member entitlements (displayName, mail, access level, originDirectory/Id)
      - Projects: All organization projects
      - Teams:    Per-project teams + team memberships
      - Groups:   Organization and project-scoped security groups + group memberships
                  (including nested groups and Entra ID-backed groups)
      - Repos:    Git repositories per project + security ACLs (explicit allow/deny per identity
                  from security namespace repoV2, decoded to human-readable permission labels)

    ADO users with originDirectory='aad' are flagged in extendedAttributes so the
    Invoke-FGAccountCorrelation step can link them to matching Entra ID principals.

.PARAMETER ApiBaseUrl
    Base URL of the Ingest API (e.g., http://web:3001/api)

.PARAMETER ApiKey
    Crawler API key (fgc_...)

.PARAMETER OrganizationUrl
    Azure DevOps organization URL (e.g., https://dev.azure.com/contoso)

.PARAMETER Secret
    The Personal Access Token. Resolved from the secrets vault by the dispatcher before this script is called.

.PARAMETER SyncUsers
    Sync member entitlements (access levels). Default: true

.PARAMETER SyncProjects
    Sync projects. Default: true

.PARAMETER SyncTeams
    Sync teams and team memberships. Default: true

.PARAMETER SyncGroups
    Sync security groups and group memberships. Default: true

.PARAMETER CorrelateWithEntraId
    Emit extendedAttributes.originDirectory / originId so account correlation can link
    ADO users to Entra ID principals. Default: true

.PARAMETER SyncRepos
    Sync Git repositories and their security ACLs. Default: false

.PARAMETER IncludeStakeholders
    Include users with Stakeholder access level. Default: false

.PARAMETER JobId
    CrawlerJobs.id — when set, fine-grained progress is reported to the UI.

.EXAMPLE
    .\Start-AzureDevOpsCrawler.ps1 `
        -ApiBaseUrl "http://localhost:3001/api" `
        -ApiKey "fgc_abc123..." `
        -OrganizationUrl "https://dev.azure.com/contoso" `
        -Secret "mypat..."
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$ApiKey,

    [Parameter(Mandatory = $true)]
    [string]$OrganizationUrl,

    [Parameter(Mandatory = $true)]
    [string]$Secret,

    [bool]$SyncUsers    = $true,
    [bool]$SyncProjects = $true,
    [bool]$SyncTeams    = $true,
    [bool]$SyncGroups   = $true,
    [switch]$SyncRepos  = $false,

    [bool]$CorrelateWithEntraId = $true,
    [switch]$IncludeStakeholders = $false,

    [int]$JobId = 0
)

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

# ─── Parse org name from URL ──────────────────────────────────────────────────

$OrganizationUrl = $OrganizationUrl.TrimEnd('/')
if ($OrganizationUrl -match 'dev\.azure\.com/([^/?#]+)') {
    $OrgName = $Matches[1]
    $OrgBaseUrl = "https://dev.azure.com/$OrgName"
} elseif ($OrganizationUrl -match '^https?://([^.]+)\.visualstudio\.com') {
    $OrgName = $Matches[1]
    $OrgBaseUrl = "https://dev.azure.com/$OrgName"
} else {
    $OrgName = $OrganizationUrl
    $OrgBaseUrl = "https://dev.azure.com/$OrgName"
}

# ─── Authentication ───────────────────────────────────────────────────────────

$encoded = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$Secret"))
$AdoAuthHeader = "Basic $encoded"

# ─── ADO REST helper ──────────────────────────────────────────────────────────

function Invoke-AdoApi {
    param(
        [string]$Url,
        [int]$MaxAttempts = 4,
        [switch]$NoPaging
    )

    $allItems = [System.Collections.Generic.List[object]]::new()
    $nextUrl  = $Url

    do {
        $attempt = 0
        while ($true) {
            $attempt++
            try {
                $response = Invoke-RestMethod -Uri $nextUrl -Headers @{ Authorization = $AdoAuthHeader } -TimeoutSec 120
                break
            } catch {
                $status = $_.Exception.Response.StatusCode.value__
                $isTransient = (-not $status) -or ($status -ge 500) -or ($status -eq 429)
                if ($isTransient -and $attempt -lt $MaxAttempts) {
                    $wait = [Math]::Pow(2, $attempt)
                    Write-Host "    ADO API transient failure ($status) — retry $attempt in ${wait}s" -ForegroundColor Yellow
                    Start-Sleep -Seconds $wait
                    continue
                }
                throw
            }
        }

        if ($NoPaging) { return $response }

        # ADO paginates via continuationToken. Most endpoints use 'value';
        # memberentitlements uses 'items'; graph APIs use 'value'.
        $items = if ($null -ne $response.value) { $response.value }
                 elseif ($null -ne $response.items) { $response.items }
                 elseif ($null -ne $response.members) { $response.members }
                 else { @($response) }
        foreach ($item in $items) { $allItems.Add($item) }

        # Continuation token lives in the response body for some APIs
        $nextUrl = $null
        if ($response.continuationToken) { $nextUrl = "$Url&continuationToken=$($response.continuationToken)" }
        elseif ($response.'x-ms-continuationtoken') { $nextUrl = "$Url&continuationToken=$($response.'x-ms-continuationtoken')" }
    } while ($nextUrl)

    return $allItems
}

# ─── Ingest API helpers ───────────────────────────────────────────────────────

function Invoke-IngestAPI {
    param([string]$Endpoint, [hashtable]$Body)
    $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
    $json    = $Body | ConvertTo-Json -Depth 20 -Compress
    $uri     = "$ApiBaseUrl/$Endpoint"
    $maxAttempts = 5
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            return Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $json -TimeoutSec 300
        } catch {
            $status = $_.Exception.Response.StatusCode.value__
            $isTransient = (-not $status) -or ($status -ge 500) -or ($status -eq 429)
            if ($isTransient -and $attempt -lt $maxAttempts) {
                $wait = [Math]::Pow(2, $attempt)
                Write-Host "  Ingest API transient failure ($status) — retry $attempt in ${wait}s" -ForegroundColor Yellow
                Start-Sleep -Seconds $wait
                continue
            }
            $body = $_.ErrorDetails.Message ?? $_.Exception.Message
            Write-Host "  ERROR: $Endpoint returned $status (attempt $attempt): $body" -ForegroundColor Red
            throw
        }
    }
}

function Send-IngestBatch {
    param(
        [string]$Endpoint,
        [int]$SystemId,
        [string]$SyncMode = 'full',
        [hashtable]$Scope = @{},
        [array]$Records,
        [int]$BatchSize = 5000
    )
    if (-not $Records -or $Records.Count -eq 0) {
        Write-Host "  No records to send" -ForegroundColor Yellow
        return @{ inserted = 0; updated = 0; deleted = 0 }
    }
    Write-Host "  Sending $($Records.Count) records to $Endpoint..." -ForegroundColor Cyan

    if ($Records.Count -le $BatchSize) {
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = $Records }
        Write-Host "  Result: $($result.inserted) inserted, $($result.updated) updated, $($result.deleted) deleted" -ForegroundColor Green
        return $result
    }

    $syncId = $null; $totalInserted = 0; $totalUpdated = 0; $result = $null
    for ($i = 0; $i -lt $Records.Count; $i += $BatchSize) {
        $batch   = $Records[$i..([Math]::Min($i + $BatchSize - 1, $Records.Count - 1))]
        $isFirst = ($i -eq 0)
        $isLast  = ($i + $BatchSize -ge $Records.Count)
        $body    = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = $batch
                      syncSession = if ($isFirst) { 'start' } elseif ($isLast) { 'end' } else { 'continue' } }
        if ($syncId) { $body.syncId = $syncId }
        $result = Invoke-IngestAPI -Endpoint $Endpoint -Body $body
        if ($isFirst) { $syncId = $result.syncId }
        $totalInserted += ($result.inserted ?? 0)
        $totalUpdated  += ($result.updated ?? 0)
        Write-Host "  Batch $([Math]::Floor($i / $BatchSize) + 1)/$([Math]::Ceiling($Records.Count / $BatchSize)) done" -ForegroundColor Gray
    }
    Write-Host "  Total: $totalInserted inserted, $totalUpdated updated, $($result.deleted ?? 0) deleted" -ForegroundColor Green
    return @{ inserted = $totalInserted; updated = $totalUpdated; deleted = ($result.deleted ?? 0) }
}

function Update-CrawlerProgress {
    param([string]$Step, [int]$Pct, [string]$Detail = '')
    if ($JobId -le 0) { return }
    try {
        $headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
        $body    = @{ jobId = $JobId; step = $Step; pct = $Pct; detail = $Detail } | ConvertTo-Json -Compress
        $resp    = Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post -Headers $headers -Body $body -TimeoutSec 10
        if ($resp.aborted) { throw "Job was aborted server-side" }
    } catch {
        if ($_.Exception.Message -like '*aborted*') { throw }
        Write-Host "  Warning: failed to update progress — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ─── Main ─────────────────────────────────────────────────────────────────────

Write-Host "Azure DevOps Crawler — org: $OrgName" -ForegroundColor Cyan
$SyncStart = (Get-Date).ToUniversalTime().ToString('o')

# Descriptor → UUID lookup built during user sync; used in group/team membership
# resolution to ensure principalId values are always proper UUIDs.
$UserIdLookup = @{}

# ── 1. Register system ────────────────────────────────────────────────────────
Update-CrawlerProgress -Step 'Registering system' -Pct 5

$systemResult = Invoke-IngestAPI -Endpoint 'ingest/systems' -Body @{
    records = @(@{
        systemType  = 'AzureDevOps'
        displayName = "Azure DevOps — $OrgName"
        externalId  = $OrgBaseUrl
    })
}
$SystemId = $systemResult.systemIds[0]
Write-Host "System ID: $SystemId" -ForegroundColor Green

# ── 2. Users ──────────────────────────────────────────────────────────────────
# The vsaex memberentitlements API (which includes access levels) requires a PAT.
if ($SyncUsers) {
    Update-CrawlerProgress -Step 'Fetching users' -Pct 10

    Write-Host "`nSyncing users..." -ForegroundColor Cyan
    $principals = [System.Collections.Generic.List[object]]::new()

    try {
            $entitlements = [System.Collections.Generic.List[object]]::new()
            $nextUrl = "https://vsaex.dev.azure.com/$OrgName/_apis/memberentitlements?api-version=7.1-preview.2&`$top=200"
            do {
                $resp  = Invoke-RestMethod -Uri $nextUrl -Headers @{ Authorization = $AdoAuthHeader } -TimeoutSec 120
                $page  = if ($resp.items) { @($resp.items) } elseif ($resp.members) { @($resp.members) } elseif ($resp.value) { @($resp.value) } else { @() }
                foreach ($item in $page) { $entitlements.Add($item) }
                $token   = $resp.continuationToken
                $nextUrl = if ($token) { "https://vsaex.dev.azure.com/$OrgName/_apis/memberentitlements?api-version=7.1-preview.2&`$top=200&continuationToken=$token" } else { $null }
            } while ($nextUrl)
            Write-Host "  Fetched $($entitlements.Count) member entitlements" -ForegroundColor Gray
            foreach ($e in $entitlements) {
                $user        = $e.member   # API uses 'member', not 'user'
                $accessLevel = $e.accessLevel?.licenseDisplayName ?? $e.accessLevel?.accountLicenseType ?? 'Unknown'

                if (-not $IncludeStakeholders -and $accessLevel -like '*Stakeholder*') { continue }
                if (-not $user -or -not $user.displayName) { continue }

                $ext = @{ accessLevel = $accessLevel }

                if ($CorrelateWithEntraId) {
                    if ($user.originId)        { $ext['originId']        = $user.originId }
                    if ($user.originDirectory) { $ext['originDirectory'] = $user.originDirectory }
                }

                $principalType = if ($user.subjectKind -eq 'servicePrincipal') { 'ServicePrincipal' } else { 'User' }
                # Use Entra OID (stable GUID) when available; entitlement GUID as fallback
                $userId = $user.originId ?? $e.id ?? $user.descriptor
                if ($user.descriptor -and $userId) { $UserIdLookup[$user.descriptor] = $userId }

                $principals.Add(@{
                    id                 = $userId
                    displayName        = $user.displayName
                    email              = $user.mailAddress
                    principalType      = $principalType
                    accountEnabled     = $true
                    extendedAttributes = $ext
                })
            }
        } catch {
            Write-Host "  ERROR syncing users via member entitlements: $($_.Exception.Message)" -ForegroundColor Red
        }

    if ($principals.Count -gt 0) {
        Update-CrawlerProgress -Step 'Ingesting users' -Pct 15
        $result = Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId -SyncMode 'full' -Records $principals
        Write-Host "  Users: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
    }
}

# ── 3. Projects ───────────────────────────────────────────────────────────────
$allProjects = @()
if ($SyncProjects -or $SyncTeams -or $SyncGroups -or $SyncRepos) {
    Update-CrawlerProgress -Step 'Fetching projects' -Pct 20

    Write-Host "`nSyncing projects..." -ForegroundColor Cyan
    try {
        # Projects API returns the continuation token as a response HEADER, not in the
        # body, so Invoke-AdoApi won't paginate it. Use a dedicated loop instead.
        $allProjectsList = [System.Collections.Generic.List[object]]::new()
        $projectsUrl = "$OrgBaseUrl/_apis/projects?api-version=7.1&`$top=200"
        do {
            $pageResp = Invoke-RestMethod -Uri $projectsUrl -Headers @{ Authorization = $AdoAuthHeader } `
                            -ResponseHeadersVariable projRespHeaders -TimeoutSec 120
            foreach ($p in $pageResp.value) { $allProjectsList.Add($p) }
            $contToken = $projRespHeaders['x-ms-continuationtoken']
            $projectsUrl = if ($contToken) { "$OrgBaseUrl/_apis/projects?api-version=7.1&`$top=200&continuationToken=$contToken" } else { $null }
        } while ($projectsUrl)
        $allProjects = @($allProjectsList)
        Write-Host "  Fetched $($allProjects.Count) projects" -ForegroundColor Gray

        # Build project name→id lookup for group scope resolution
        $ProjectNameLookup = @{}
        foreach ($p in $allProjects) { $ProjectNameLookup[$p.name] = $p.id }

        if ($SyncProjects) {
            $projectRecords = $allProjects | ForEach-Object {
                @{
                    id          = $_.id
                    displayName = $_.name
                    description = $_.description
                    resourceType = 'AzureDevOpsProject'
                    extendedAttributes = @{ visibility = $_.visibility; state = $_.state }
                }
            }
            $result = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ resourceType = 'AzureDevOpsProject' } -Records $projectRecords
            Write-Host "  Projects: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
        }
    } catch {
        Write-Host "  ERROR syncing projects: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# Shared list for all Contains relationships — sent as one full-sync batch at the end
# to avoid each section's full-sync overwriting the previous section's data.
$allContainsRelationships = [System.Collections.Generic.List[object]]::new()

# ── 4. Teams + team memberships ───────────────────────────────────────────────
if ($SyncTeams -and $allProjects.Count -gt 0) {
    Update-CrawlerProgress -Step 'Fetching teams' -Pct 30

    Write-Host "`nSyncing teams..." -ForegroundColor Cyan
    $teamRecords     = [System.Collections.Generic.List[object]]::new()
    $teamAssignments = [System.Collections.Generic.List[object]]::new()

    $processed = 0
    foreach ($project in $allProjects) {
        $processed++
        $pct = 30 + [Math]::Floor(($processed / $allProjects.Count) * 15)
        Update-CrawlerProgress -Step "Fetching teams ($processed/$($allProjects.Count))" -Pct $pct -Detail $project.name

        try {
            $teams = @(Invoke-AdoApi -Url "$OrgBaseUrl/$($project.id)/_apis/teams?api-version=7.1&`$top=100")
        } catch {
            Write-Host "  WARNING: could not fetch teams for project $($project.name): $($_.Exception.Message)" -ForegroundColor Yellow
            continue
        }

        foreach ($team in $teams) {
            $teamRecords.Add(@{
                id           = $team.id
                displayName  = $team.name
                description  = $team.description
                resourceType = 'AzureDevOpsTeam'
                extendedAttributes = @{ projectId = $project.id; projectName = $project.name }
            })

            # Team is contained within its project
            $allContainsRelationships.Add(@{
                parentResourceId = $project.id
                childResourceId  = $team.id
                relationshipType = 'Contains'
            })

            # Team members
            try {
                $members = @(Invoke-AdoApi -Url "$OrgBaseUrl/$($project.id)/_apis/teams/$($team.id)/members?api-version=7.1&`$top=500")
                foreach ($m in $members) {
                    $principalId = $m.identity.id ?? $m.identity.descriptor
                    if (-not $principalId) { continue }
                    if ($m.identity.descriptor -and $m.identity.id) {
                        $UserIdLookup[$m.identity.descriptor] = $m.identity.id
                    }
                    $teamAssignments.Add(@{
                        resourceId     = $team.id
                        principalId    = $principalId
                        assignmentType = 'Direct'
                    })
                }
            } catch {
                Write-Host "    WARNING: could not fetch members for team $($team.name): $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }

    Update-CrawlerProgress -Step 'Ingesting teams' -Pct 46
    if ($teamRecords.Count -gt 0) {
        $result = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ resourceType = 'AzureDevOpsTeam' } -Records $teamRecords.ToArray()
        Write-Host "  Teams: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
    }
    if ($teamAssignments.Count -gt 0) {
        $result = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ resourceType = 'AzureDevOpsTeam'; assignmentType = 'Direct' } -Records $teamAssignments.ToArray()
        Write-Host "  Team memberships: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
    }
}

# ── 5. Security groups + memberships ─────────────────────────────────────────
if ($SyncGroups) {
    Update-CrawlerProgress -Step 'Fetching security groups' -Pct 50

    Write-Host "`nSyncing security groups..." -ForegroundColor Cyan
    $groupRecords     = [System.Collections.Generic.List[object]]::new()
    $groupAssignments = [System.Collections.Generic.List[object]]::new()

    try {
        # ADO Graph API returns groups across the entire organization
        $groups = @(Invoke-AdoApi -Url "https://vssps.dev.azure.com/$OrgName/_apis/graph/groups?api-version=7.1-preview.1&`$top=500")
        Write-Host "  Fetched $($groups.Count) security groups" -ForegroundColor Gray

        # Build a descriptor→id lookup for resolving group memberships
        $descriptorLookup = @{}
        foreach ($g in $groups) { $descriptorLookup[$g.descriptor] = $g.originId ?? $g.descriptor }

        foreach ($g in $groups) {
            $groupId = $g.originId ?? $g.descriptor

            $ext = @{
                scopeType       = $g.domain   # 'Project', 'Organization', etc.
                descriptor      = $g.descriptor
            }
            if ($g.origin)          { $ext['originDirectory'] = $g.origin }
            if ($g.originId)        { $ext['originId']        = $g.originId }

            $groupRecords.Add(@{
                id           = $groupId
                displayName  = $g.displayName
                description  = $g.description
                resourceType = 'AzureDevOpsGroup'
                extendedAttributes = $ext
            })

            # The domain field for project-scoped groups is:
            #   vstfs:///Classification/TeamProject/<projectGuid>
            # Extract the GUID directly — more reliable than parsing principalName.
            if ($g.domain -match 'vstfs:///Classification/TeamProject/([0-9a-f\-]{36})') {
                $allContainsRelationships.Add(@{
                    parentResourceId = $Matches[1]
                    childResourceId  = $groupId
                    relationshipType = 'Contains'
                })
            }
        }

        Update-CrawlerProgress -Step 'Fetching group memberships' -Pct 60

        # Resolve memberships in parallel batches
        $processed = 0
        $batchSize = 50
        for ($i = 0; $i -lt $groups.Count; $i += $batchSize) {
            $batch = $groups[$i..([Math]::Min($i + $batchSize - 1, $groups.Count - 1))]
            $processed += $batch.Count
            $pct = 60 + [Math]::Floor(($processed / $groups.Count) * 20)
            Update-CrawlerProgress -Step "Resolving memberships ($processed/$($groups.Count))" -Pct $pct

            $batch | ForEach-Object -Parallel {
                $g           = $_
                $orgName     = $using:OrgName
                $authHeader  = $using:AdoAuthHeader

                try {
                    $memberUrl = "https://vssps.dev.azure.com/$orgName/_apis/graph/memberships/$($g.descriptor)?direction=down&api-version=7.1-preview.1"
                    $resp      = Invoke-RestMethod -Uri $memberUrl -Headers @{ Authorization = $authHeader } -TimeoutSec 30
                    $memberRefs = $resp.value ?? @()
                    foreach ($ref in $memberRefs) {
                        [PSCustomObject]@{
                            groupDescriptor  = $g.descriptor
                            memberDescriptor = $ref.memberDescriptor
                            memberSubjectKind = $ref.memberDescriptor -match '^vssgp\.' ? 'group' : 'user'
                        }
                    }
                } catch {
                    # Non-fatal — some groups may deny membership listing
                }
            } -ThrottleLimit 10 | ForEach-Object {
                # Skip group-to-group entries — principalId must be a user UUID.
                # Transitive group membership is resolved by vw_GraphGroupMembersRecursive.
                if ($_.memberSubjectKind -eq 'group') { return }

                $groupId  = $descriptorLookup[$_.groupDescriptor] ?? $_.groupDescriptor
                # Resolve member descriptor to a UUID via the lookup built during user sync
                $memberId = $UserIdLookup[$_.memberDescriptor]
                if (-not $memberId) { return }  # cannot link without a UUID — skip

                if ($groupId -and $memberId) {
                    $groupAssignments.Add(@{
                        resourceId     = $groupId
                        principalId    = $memberId
                        assignmentType = 'Direct'
                    })
                }
            }
        }

        Update-CrawlerProgress -Step 'Ingesting security groups' -Pct 82
        if ($groupRecords.Count -gt 0) {
            $result = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ resourceType = 'AzureDevOpsGroup' } -Records $groupRecords.ToArray()
            Write-Host "  Groups: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
        }
        if ($groupAssignments.Count -gt 0) {
            $result = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
                -Scope @{ resourceType = 'AzureDevOpsGroup'; assignmentType = 'Direct' } -Records $groupAssignments.ToArray()
            Write-Host "  Group memberships: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
        }

        # Best-effort: resolve project GUIDs referenced by groups but not in the
        # accessible projects list. Calls _apis/projects/<guid> individually;
        # projects that 401/403 are silently skipped.
        $knownProjectIds = @{}
        foreach ($p in $allProjects) { $knownProjectIds[$p.id] = $true }

        $unknownGuids = $allContainsRelationships |
            Where-Object { -not $knownProjectIds[$_.parentResourceId] } |
            ForEach-Object { $_.parentResourceId } |
            Select-Object -Unique

        if ($unknownGuids) {
            Write-Host "  Resolving $($unknownGuids.Count) project(s) not in accessible list..." -ForegroundColor Cyan
            $supplementalProjects = [System.Collections.Generic.List[object]]::new()
            foreach ($guid in $unknownGuids) {
                try {
                    $proj = Invoke-RestMethod -Uri "$OrgBaseUrl/_apis/projects/$guid?api-version=7.1" `
                                -Headers @{ Authorization = $AdoAuthHeader } -TimeoutSec 20
                    $supplementalProjects.Add(@{
                        id           = $proj.id
                        displayName  = $proj.name
                        description  = $proj.description
                        resourceType = 'AzureDevOpsProject'
                        extendedAttributes = @{ visibility = $proj.visibility; state = $proj.state }
                    })
                } catch { <# inaccessible project — no subtitle for its groups #> }
            }
            if ($supplementalProjects.Count -gt 0) {
                $result = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'delta' `
                    -Records $supplementalProjects.ToArray()
                Write-Host "  Supplemental projects: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
            } else {
                Write-Host "  No supplemental projects resolvable (PAT lacks access)" -ForegroundColor Yellow
            }
        }

    } catch {
        Write-Host "  ERROR syncing security groups: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ── 6. Repositories + ACLs ───────────────────────────────────────────────────
# ADO security namespace for Git repositories (repoV2)
# Namespace GUID: 2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87
# Token format: repoV2/{projectId}/{repoId}
# Bit mask → permission label mapping (matches the ADO documentation)
$RepoBitLabels = [ordered]@{
    2     = 'Read'
    4     = 'Contribute'
    8     = 'ForcePush'
    16    = 'CreateBranch'
    32    = 'CreateTag'
    64    = 'ManageNote'
    128   = 'PolicyExempt'
    256   = 'CreateRepository'
    512   = 'DeleteRepository'
    1024  = 'RenameRepository'
    2048  = 'EditPolicies'
    4096  = 'RemoveOthersLocks'
    8192  = 'ManagePermissions'
    16384 = 'PullRequestContribute'
    32768 = 'PullRequestBypassPolicy'
}

function ConvertTo-RepoPermissionLabels {
    param([int]$Allow, [int]$Deny)
    $allowLabels = @()
    $denyLabels  = @()
    foreach ($bit in $RepoBitLabels.Keys) {
        if ($Allow -band $bit) { $allowLabels += $RepoBitLabels[$bit] }
        if ($Deny  -band $bit) { $denyLabels  += $RepoBitLabels[$bit] }
    }
    return @{ allow = $allowLabels; deny = $denyLabels }
}

if ($SyncRepos -and $allProjects.Count -gt 0) {
    Update-CrawlerProgress -Step 'Fetching repositories' -Pct 85

    Write-Host "`nSyncing repositories and ACLs..." -ForegroundColor Cyan
    $repoRecords        = [System.Collections.Generic.List[object]]::new()
    $repoAclAssignments = [System.Collections.Generic.List[object]]::new()

    $processed = 0
    foreach ($project in $allProjects) {
        $processed++
        $pct = 85 + [Math]::Floor(($processed / $allProjects.Count) * 8)
        Update-CrawlerProgress -Step "Fetching repos ($processed/$($allProjects.Count))" -Pct $pct -Detail $project.name

        try {
            $repos = @(Invoke-AdoApi -Url "$OrgBaseUrl/$($project.id)/_apis/git/repositories?api-version=7.1")
            Write-Host "  Project $($project.name): $($repos.Count) repos" -ForegroundColor Gray
        } catch {
            Write-Host "  WARNING: could not fetch repos for project $($project.name): $($_.Exception.Message)" -ForegroundColor Yellow
            continue
        }

        foreach ($repo in $repos) {
            $repoRecords.Add(@{
                id           = $repo.id
                displayName  = $repo.name
                resourceType = 'AzureDevOpsRepo'
                extendedAttributes = @{
                    projectId   = $project.id
                    projectName = $project.name
                    defaultBranch = $repo.defaultBranch
                    remoteUrl   = $repo.remoteUrl
                    size        = $repo.size
                }
            })

            # Repo is contained within its project
            $allContainsRelationships.Add(@{
                parentResourceId = $project.id
                childResourceId  = $repo.id
                relationshipType = 'Contains'
            })

            # Fetch ACLs from the security namespace for this specific repo
            # Token: repoV2/{projectId}/{repoId}  (explicit ACLs on the repo node)
            $aclToken = "repoV2/$($project.id)/$($repo.id)"
            try {
                $aclUrl  = "$OrgBaseUrl/_apis/accesscontrollists/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87?token=$([Uri]::EscapeDataString($aclToken))&includeExtendedInfo=false&api-version=7.1"
                $aclData = Invoke-AdoApi -Url $aclUrl -NoPaging
                $aclList = $aclData.value ?? @()

                foreach ($acl in $aclList) {
                    foreach ($ace in ($acl.acesDictionary.PSObject.Properties.Value ?? @())) {
                        $allow = [int]($ace.allow ?? 0)
                        $deny  = [int]($ace.deny  ?? 0)
                        if ($allow -eq 0 -and $deny -eq 0) { continue }

                        $aceDescriptor = $ace.descriptor
                        $perms = ConvertTo-RepoPermissionLabels -Allow $allow -Deny $deny

                        # ACE descriptors use security-namespace format (e.g. "aad.Abc==").
                        # Resolve to a UUID via the lookup built during user sync; skip if unknown.
                        $principalId = $UserIdLookup[$aceDescriptor]
                        if (-not $principalId) { continue }

                        $repoAclAssignments.Add(@{
                            resourceId     = $repo.id
                            principalId    = $principalId
                            assignmentType = 'Direct'
                            extendedAttributes = @{
                                descriptor    = $aceDescriptor
                                allowBits     = $allow
                                denyBits      = $deny
                                allowLabels   = $perms.allow
                                denyLabels    = $perms.deny
                            }
                        })
                    }
                }
            } catch {
                Write-Host "    WARNING: could not fetch ACLs for repo $($repo.name): $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }

    Update-CrawlerProgress -Step 'Ingesting repositories' -Pct 93
    if ($repoRecords.Count -gt 0) {
        $result = Send-IngestBatch -Endpoint 'ingest/resources' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ resourceType = 'AzureDevOpsRepo' } -Records $repoRecords.ToArray()
        Write-Host "  Repos: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
    }
    if ($repoAclAssignments.Count -gt 0) {
        $result = Send-IngestBatch -Endpoint 'ingest/resource-assignments' -SystemId $SystemId -SyncMode 'full' `
            -Scope @{ resourceType = 'AzureDevOpsRepo'; assignmentType = 'Direct' } -Records $repoAclAssignments.ToArray()
        Write-Host "  Repo ACLs: $($result.inserted) inserted, $($result.updated) updated" -ForegroundColor Green
    }
}

# ── 7. Contains relationships (single full-sync covers teams, groups, and repos) ───
if ($allContainsRelationships.Count -gt 0) {
    Update-CrawlerProgress -Step 'Ingesting parent-child relationships' -Pct 94
    $result = Send-IngestBatch -Endpoint 'ingest/resource-relationships' -SystemId $SystemId -SyncMode 'full' `
        -Scope @{ relationshipType = 'Contains' } -Records $allContainsRelationships.ToArray()
    Write-Host "`nContains relationships: $($result.inserted) inserted, $($result.updated) updated, $($result.deleted) deleted" -ForegroundColor Green
}

# ── 8. Access-scope summary ──────────────────────────────────────────────────
# Emit a clear warning when some groups have unresolvable parent projects so
# operators know to check PAT/SP scope rather than assume a bug.
if ($SyncGroups) {
    $resolvedParentGuids = @{}
    foreach ($p in $allProjects) { $resolvedParentGuids[$p.id] = $true }

    $unresolvedParentCount = ($allContainsRelationships |
        Where-Object { -not $resolvedParentGuids[$_.parentResourceId] } |
        ForEach-Object { $_.parentResourceId } |
        Select-Object -Unique |
        Measure-Object).Count

    if ($unresolvedParentCount -gt 0) {
        Write-Host ""
        Write-Host "─────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
        Write-Host "  ACCESS SCOPE WARNING" -ForegroundColor Yellow
        Write-Host "  $unresolvedParentCount project(s) referenced by security groups could not be resolved." -ForegroundColor Yellow
        Write-Host "  This means the PAT used for this crawler does not have access to those projects." -ForegroundColor Yellow
        Write-Host "  Groups from inaccessible projects are still synced, but their parent project" -ForegroundColor Yellow
        Write-Host "  name will not appear in Identity Atlas." -ForegroundColor Yellow
        Write-Host "  To fix: ensure the PAT owner has at least 'Project Reader' access on all" -ForegroundColor Yellow
        Write-Host "  projects in the organization." -ForegroundColor Yellow
        Write-Host "─────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
        Write-Host ""
    }
}

# ── 9. Sync log ───────────────────────────────────────────────────────────────
Update-CrawlerProgress -Step 'Recording sync log' -Pct 95

try {
    Invoke-IngestAPI -Endpoint 'ingest/sync-log' -Body @{
        syncType    = 'AzureDevOps'
        startTime   = $SyncStart
        endTime     = (Get-Date).ToUniversalTime().ToString('o')
        status      = 'Success'
        tableName   = "AzureDevOps/$OrgName"
    } | Out-Null
} catch { Write-Host "  Warning: sync log write failed — $($_.Exception.Message)" -ForegroundColor Yellow }

Update-CrawlerProgress -Step 'Complete' -Pct 100
Write-Host "`nAzure DevOps sync complete." -ForegroundColor Green
