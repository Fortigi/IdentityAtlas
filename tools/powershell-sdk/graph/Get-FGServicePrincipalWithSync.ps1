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

    # Strategy: first try to get only provisioning-tagged SPs (fast), then fall back to
    # well-known HR/sync app names. Avoids iterating over all 3000+ SPs in large tenants.
    $spList = [System.Collections.Generic.List[PSObject]]::new()

    if ($Filter) {
        # User-specified filter — use as-is
        $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=$Filter"
        $filterResult = Invoke-FGGetRequest -URI $URI
        if ($filterResult) { foreach ($r in $filterResult) { $spList.Add($r) } }
    } else {
        # Query only SPs likely to have provisioning configured:
        # 1. Known provisioning app IDs (Cloud Sync, Workday, SuccessFactors, etc.)
        # 2. SPs with "WindowsAzureActiveDirectoryIntegratedApp" tag (gallery apps with provisioning)
        $knownProvisioningAppIds = @(
            "1a4721b3-e57f-4451-ae87-ef078703ec94"  # Azure AD Connect Cloud Sync
            "2a1600fe-e5a8-42d0-835e-5f21f8ae2ec5"  # Workday to AAD User Provisioning
            "6402503b-7adb-415d-91b2-cf8a9e7f9948"  # SuccessFactors to AAD User Provisioning
        )

        # Query by known appIds
        foreach ($appId in $knownProvisioningAppIds) {
            $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=appId eq '$appId'"
            $result = Invoke-FGGetRequest -URI $URI -ErrorAction SilentlyContinue
            if ($result) { foreach ($r in $result) { $spList.Add($r) } }
        }

        # Query by common HR provisioning display name patterns
        $hrNamePatterns = @("Workday", "SuccessFactors", "SAP", "Oracle HCM", "BambooHR", "Ceridian")
        foreach ($pattern in $hrNamePatterns) {
            $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=startswith(displayName,'$pattern')"
            $result = Invoke-FGGetRequest -URI $URI -ErrorAction SilentlyContinue
            if ($result) { foreach ($r in $result) { $spList.Add($r) } }
        }

        # Query SPs tagged as provisioning-enabled gallery apps
        $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=tags/any(t:t eq 'WindowsAzureActiveDirectoryGalleryApplicationNonPrimaryV1')"
        $galleryApps = Invoke-FGGetRequest -URI $URI -ErrorAction SilentlyContinue
        if ($galleryApps) { foreach ($r in $galleryApps) { $spList.Add($r) } }

        # Also check SCIM-provisioned apps (custom SCIM apps often have this tag)
        $URI = "https://graph.microsoft.com/beta/servicePrincipals?`$select=id,displayName,appId,tags&`$filter=tags/any(t:t eq 'WindowsAzureActiveDirectoryCustomSingleSignOnApplication')"
        $customApps = Invoke-FGGetRequest -URI $URI -ErrorAction SilentlyContinue
        if ($customApps) { foreach ($r in $customApps) { $spList.Add($r) } }

        # Deduplicate by id
        $seen = @{}
        $spList = [System.Collections.Generic.List[PSObject]]::new(
            @($spList | Where-Object {
                if ($seen[$_.id]) { $false } else { $seen[$_.id] = $true; $true }
            })
        )
    }

    $AllServicePrincipals = $spList.ToArray()
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
            # Try to get synchronization jobs
            $Jobs = Get-FGSynchronizationJob -ServicePrincipalId $sp.id -ErrorAction SilentlyContinue

            if ($Jobs) {
                # Ensure Jobs is always an array
                if ($Jobs -isnot [Array]) {
                    $Jobs = @($Jobs)
                }

                # Determine app type
                $AppType = "Unknown"
                if ($sp.appId -eq "1a4721b3-e57f-4451-ae87-ef078703ec94") {
                    $AppType = "Cloud Sync"
                    # Skip if not including Cloud Sync
                    if (-not $IncludeCloudSync) {
                        continue
                    }
                }
                elseif ($sp.displayName -like "*Workday*") {
                    $AppType = "HR Provisioning (Workday)"
                }
                elseif ($sp.displayName -like "*SuccessFactors*" -or $sp.displayName -like "*SAP*") {
                    $AppType = "HR Provisioning (SuccessFactors)"
                }
                elseif ($Jobs | Where-Object { $_.id -like "scim.*" }) {
                    $AppType = "SCIM Application"
                }
                elseif ($sp.displayName -like "*Azure Active Directory*" -or $sp.displayName -like "*Microsoft Entra*") {
                    $AppType = "Cloud Sync / AD"
                }
                else {
                    $AppType = "Enterprise Application"
                }

                # Build result object
                $ResultObject = [PSCustomObject]@{
                    DisplayName         = $sp.displayName
                    AppType            = $AppType
                    ServicePrincipalId = $sp.id
                    AppId              = $sp.appId
                    Tags               = $sp.tags
                    JobCount           = $Jobs.Count
                }

                # Add job details if requested
                if ($IncludeJobs) {
                    $ResultObject | Add-Member -NotePropertyName "Jobs" -NotePropertyValue $Jobs
                }

                # Add schema details if requested
                if ($IncludeSchema) {
                    $Schemas = @()
                    foreach ($job in $Jobs) {
                        try {
                            $Schema = Get-FGSynchronizationSchema -ServicePrincipalId $sp.id -JobId $job.id -ErrorAction SilentlyContinue
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
                    $ResultObject | Add-Member -NotePropertyName "Schemas" -NotePropertyValue $Schemas
                }

                $ResultsList.Add($ResultObject)
            }
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
