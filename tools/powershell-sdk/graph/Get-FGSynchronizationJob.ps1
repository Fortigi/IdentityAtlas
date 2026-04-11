function Get-FGSynchronizationJob {
    <#
    .SYNOPSIS
        Gets synchronization jobs for a service principal.

    .DESCRIPTION
        Retrieves synchronization jobs configured for a service principal in Entra ID.
        This includes provisioning jobs for Cloud Sync, HR provisioning (Workday/SuccessFactors),
        and SCIM-enabled enterprise applications.

    .PARAMETER ServicePrincipalId
        The object ID of the service principal to query for synchronization jobs.

    .PARAMETER JobId
        Optional. The specific synchronization job ID to retrieve.
        If not specified, all jobs for the service principal are returned.

    .EXAMPLE
        Get-FGSynchronizationJob -ServicePrincipalId "12345678-1234-1234-1234-123456789012"
        Returns all synchronization jobs for the specified service principal.

    .EXAMPLE
        Get-FGSynchronizationJob -ServicePrincipalId "12345678-1234-1234-1234-123456789012" -JobId "job.1234"
        Returns a specific synchronization job.

    .NOTES
        Requires the following Graph API permissions:
        - Synchronization.Read.All (read-only)
        - Synchronization.ReadWrite.All (full access)

    .LINK
        https://learn.microsoft.com/en-us/graph/api/resources/synchronization-overview
    #>

    [alias("Get-SynchronizationJob")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true, Position = 0)]
        [Alias("ObjectId", "Id")]
        [string]$ServicePrincipalId,

        [Parameter(Mandatory = $false, Position = 1)]
        [string]$JobId
    )

    # Build URI
    if ($JobId) {
        $URI = "https://graph.microsoft.com/beta/servicePrincipals/$ServicePrincipalId/synchronization/jobs/$JobId"
    }
    else {
        $URI = "https://graph.microsoft.com/beta/servicePrincipals/$ServicePrincipalId/synchronization/jobs"
    }

    # Call base function
    try {
        $ReturnValue = Invoke-FGGetRequest -URI $URI
        return $ReturnValue
    }
    catch {
        # If 404, service principal doesn't have synchronization configured
        if ($_.Exception.Response.StatusCode.value__ -eq 404) {
            Write-Verbose "No synchronization jobs found for service principal: $ServicePrincipalId"
            return $null
        }
        else {
            throw $_
        }
    }
}
