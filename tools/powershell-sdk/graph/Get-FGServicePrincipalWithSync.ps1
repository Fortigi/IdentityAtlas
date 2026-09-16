function Add-FGSyncQueryResult {
    # Runs one discovery query and appends any results to the shared list.
    Param(
        [string]$Uri,
        $List
    )

    $result = Invoke-FGGetRequest -URI $Uri -ErrorAction SilentlyContinue
    if ($result) {
        foreach ($r in $result) { $List.Add($r) }
    }
}

function Get-FGSyncDedupById {
    # Collapses candidate service principals to one entry per id.
    Param($Items)

    $seen = @{}
    $deduped = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($sp in $Items) {
        if (-not $seen[$sp.id]) {
            $seen[$sp.id] = $true
            $deduped.Add($sp)
        }
    }
    return , $deduped.ToArray()
}

function Get-FGSyncCandidateByDiscovery {
    # Queries only SPs likely to have provisioning configured, avoiding a full
    # iteration over every SP in large tenants:
    #   1. Known provisioning app IDs (Cloud Sync, Workday, SuccessFactors, ...)
    #   2. Common HR provisioning display-name patterns
    #   3. SPs tagged as provisioning-enabled gallery / custom SSO apps
    $spList = [System.Collections.Generic.List[PSObject]]::new()

    $knownProvisioningAppIds = @(
        "1a4721b3-e57f-4451-ae87-ef078703ec94"  # Azure AD Connect Cloud Sync
        "2a1600fe-e5a8-42d0-835e-5f21f8ae2ec5"  # Workday to AAD User Provisioning
        "6402503b-7adb-415d-91b2-cf8a9e7f9948"  # SuccessFactors to AAD User Provisioning
    )
    foreach ($appId in $knownProvisioningAppIds) {
        $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=appId eq '$appId'"
        Add-FGSyncQueryResult -Uri $URI -List $spList
    }

    $hrNamePatterns = @("Workday", "SuccessFactors", "SAP", "Oracle HCM", "BambooHR", "Ceridian")
    foreach ($pattern in $hrNamePatterns) {
        $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=startswith(displayName,'$pattern')"
        Add-FGSyncQueryResult -Uri $URI -List $spList
    }

    $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=tags/any(t:t eq 'WindowsAzureActiveDirectoryGalleryApplicationNonPrimaryV1')"
    Add-FGSyncQueryResult -Uri $URI -List $spList

    $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=tags/any(t:t eq 'WindowsAzureActiveDirectoryCustomSingleSignOnApplication')"
    Add-FGSyncQueryResult -Uri $URI -List $spList

    return , (Get-FGSyncDedupById -Items $spList)
}

function Get-FGSyncCandidate {
    # Resolves the candidate service-principal set: a user-supplied filter is used
    # as-is; otherwise fall back to the well-known provisioning discovery queries.
    Param([string]$Filter)

    if ($Filter) {
        $spList = [System.Collections.Generic.List[PSObject]]::new()
        $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=$Filter"
        $filterResult = Invoke-FGGetRequest -URI $URI
        if ($filterResult) {
            foreach ($r in $filterResult) { $spList.Add($r) }
        }
        return , $spList.ToArray()
    }

    return , (Get-FGSyncCandidateByDiscovery)
}

function Get-FGSyncAppType {
    # Classifies a service principal by appId, display name, and job ids.
    Param($ServicePrincipal, $Jobs)

    if ($ServicePrincipal.appId -eq "1a4721b3-e57f-4451-ae87-ef078703ec94") {
        return "Cloud Sync"
    }
    if ($ServicePrincipal.displayName -like "*Workday*") {
        return "HR Provisioning (Workday)"
    }
    if ($ServicePrincipal.displayName -like "*SuccessFactors*" -or $ServicePrincipal.displayName -like "*SAP*") {
        return "HR Provisioning (SuccessFactors)"
    }
    if ($Jobs | Where-Object { $_.id -like "scim.*" }) {
        return "SCIM Application"
    }
    if ($ServicePrincipal.displayName -like "*Azure Active Directory*" -or $ServicePrincipal.displayName -like "*Microsoft Entra*") {
        return "Cloud Sync / AD"
    }
    return "Enterprise Application"
}

function Get-FGSyncJobSchema {
    # Retrieves the synchronization schema for each job, tolerating failures.
    Param($ServicePrincipalId, $Jobs)

    $Schemas = @()
    foreach ($job in $Jobs) {
        try {
            $Schema = Get-FGSynchronizationSchema -ServicePrincipalId $ServicePrincipalId -JobId $job.id -ErrorAction SilentlyContinue
            if ($Schema) {
                $Schemas += [PSCustomObject]@{
                    JobId  = $job.id
                    Schema = $Schema
                }
            }
        }
        catch {
            Write-Verbose "Could not retrieve schema for job $($job.id): $_"
        }
    }
    return , $Schemas
}

function New-FGSyncResult {
    # Builds the result object, optionally attaching job and schema detail.
    Param(
        $ServicePrincipal,
        $Jobs,
        [string]$AppType,
        [switch]$IncludeJobs,
        [switch]$IncludeSchema
    )

    $ResultObject = [PSCustomObject]@{
        DisplayName        = $ServicePrincipal.displayName
        AppType            = $AppType
        ServicePrincipalId = $ServicePrincipal.id
        AppId              = $ServicePrincipal.appId
        Tags               = $ServicePrincipal.tags
        JobCount           = $Jobs.Count
    }

    if ($IncludeJobs) {
        $ResultObject | Add-Member -NotePropertyName "Jobs" -NotePropertyValue $Jobs
    }

    if ($IncludeSchema) {
        $Schemas = Get-FGSyncJobSchema -ServicePrincipalId $ServicePrincipal.id -Jobs $Jobs
        $ResultObject | Add-Member -NotePropertyName "Schemas" -NotePropertyValue $Schemas
    }

    return $ResultObject
}

function Get-FGSyncResultForSp {
    # Checks one candidate SP for sync jobs and returns its result object, or
    # $null when it has no jobs or is a skipped Cloud Sync SP.
    Param(
        $ServicePrincipal,
        [switch]$IncludeCloudSync,
        [switch]$IncludeJobs,
        [switch]$IncludeSchema
    )

    $Jobs = Get-FGSynchronizationJob -ServicePrincipalId $ServicePrincipal.id -ErrorAction SilentlyContinue
    if (-not $Jobs) { return $null }
    if ($Jobs -isnot [Array]) { $Jobs = @($Jobs) }

    $AppType = Get-FGSyncAppType -ServicePrincipal $ServicePrincipal -Jobs $Jobs
    if ($AppType -eq "Cloud Sync" -and -not $IncludeCloudSync) { return $null }

    return New-FGSyncResult -ServicePrincipal $ServicePrincipal -Jobs $Jobs -AppType $AppType -IncludeJobs:$IncludeJobs -IncludeSchema:$IncludeSchema
}

function Get-FGServicePrincipalWithSync {
    <#
    .SYNOPSIS
        Gets service principals that have synchronization configured.

    .DESCRIPTION
        Retrieves service principals with provisioning/synchronization jobs configured.
        This function discovers all apps with attribute mapping configurations including:
        - Azure AD Connect Cloud Sync
        - HR provisioning (Workday, SuccessFactors, custom HR)
        - SCIM-enabled enterprise applications
        - Other provisioning-enabled apps

    .PARAMETER IncludeCloudSync
        Include Azure AD Connect Cloud Sync service principal (appId: 1a4721b3-e57f-4451-ae87-ef078703ec94).

    .PARAMETER IncludeJobs
        Include synchronization job details in the output.

    .PARAMETER IncludeSchema
        Include synchronization schema (attribute mappings) in the output.
        This will make the function slower but provides complete mapping information.

    .PARAMETER Filter
        Optional. Filter string to apply to service principal query.
        Example: "startswith(displayName,'Workday')"

    .EXAMPLE
        Get-FGServicePrincipalWithSync
        Returns all service principals that have synchronization configured.

    .EXAMPLE
        Get-FGServicePrincipalWithSync -IncludeCloudSync
        Returns all service principals including Cloud Sync configuration.

    .EXAMPLE
        Get-FGServicePrincipalWithSync -IncludeSchema
        Returns all service principals with complete attribute mapping schemas.

    .EXAMPLE
        Get-FGServicePrincipalWithSync -Filter "startswith(displayName,'Workday')"
        Returns only Workday provisioning apps with synchronization.

    .NOTES
        Requires the following Graph API permissions:
        - Application.Read.All
        - Synchronization.Read.All

        This function iterates through all service principals to check for sync jobs,
        which may take time in large tenants.

    .LINK
        https://learn.microsoft.com/en-us/graph/api/resources/synchronization-overview
    #>

    [alias("Get-ServicePrincipalWithSync")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $false)]
        [switch]$IncludeCloudSync,

        [Parameter(Mandatory = $false)]
        [switch]$IncludeJobs,

        [Parameter(Mandatory = $false)]
        [switch]$IncludeSchema,

        [Parameter(Mandatory = $false)]
        [string]$Filter
    )

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Discovering service principals with synchronization..." -ForegroundColor Cyan

    $AllServicePrincipals = @(Get-FGSyncCandidate -Filter $Filter)
    Write-Host "  Found $($AllServicePrincipals.Count) candidate service principal(s) to check" -ForegroundColor Cyan

    $ResultsList = [System.Collections.Generic.List[PSObject]]::new()
    $Count = 0
    $TotalCount = $AllServicePrincipals.Count

    # Check each candidate service principal for synchronization jobs
    foreach ($sp in $AllServicePrincipals) {
        $Count++

        # Progress indicator (every 10 or at end)
        if ($Count % 10 -eq 0 -or $Count -eq $TotalCount) {
            Write-Host "  Progress: $Count/$TotalCount service principals checked" -ForegroundColor Cyan
        }

        try {
            $result = Get-FGSyncResultForSp -ServicePrincipal $sp -IncludeCloudSync:$IncludeCloudSync -IncludeJobs:$IncludeJobs -IncludeSchema:$IncludeSchema
            if ($result) { $ResultsList.Add($result) }
        }
        catch {
            # No sync jobs or permission issue - skip silently
            Write-Verbose "Could not check synchronization for $($sp.displayName): $_"
        }
    }

    $Results = $ResultsList.ToArray()
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Discovery complete: Found $($Results.Count) service principal(s) with synchronization" -ForegroundColor Green

    return $Results
}
