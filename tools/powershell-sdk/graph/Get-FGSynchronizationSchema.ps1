function Get-FGSynchronizationSchema {
    <#
    .SYNOPSIS
        Gets the synchronization schema for a service principal's synchronization job.

    .DESCRIPTION
        Retrieves the synchronization schema which contains attribute mappings, object mappings,
        and synchronization rules for a provisioning job. This includes the complete configuration
        of how attributes flow from source to target directory.

    .PARAMETER ServicePrincipalId
        The object ID of the service principal.

    .PARAMETER JobId
        The synchronization job ID.

    .PARAMETER TemplateId
        Optional. Retrieve schema from a synchronization template instead of a job.
        Use this to get default schemas for application templates.

    .EXAMPLE
        Get-FGSynchronizationSchema -ServicePrincipalId "12345678-1234-1234-1234-123456789012" -JobId "job.1234"
        Returns the synchronization schema including all attribute mappings for the specified job.

    .EXAMPLE
        Get-FGSynchronizationSchema -ServicePrincipalId "12345678-1234-1234-1234-123456789012" -TemplateId "customappsso"
        Returns the default schema template for a custom SCIM application.

    .NOTES
        Requires the following Graph API permissions:
        - Synchronization.Read.All (read-only)
        - Synchronization.ReadWrite.All (full access)

        The schema contains:
        - synchronizationRules: Rules defining how objects are synchronized
        - objectMappings: Mappings between source and target objects
        - attributeMappings: Individual attribute mapping configurations

    .LINK
        https://learn.microsoft.com/en-us/graph/api/resources/synchronization-synchronizationschema
    #>

    [alias("Get-SynchronizationSchema")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true, Position = 0)]
        [Alias("ObjectId", "Id")]
        [string]$ServicePrincipalId,

        [Parameter(Mandatory = $false, Position = 1, ParameterSetName = "Job")]
        [string]$JobId,

        [Parameter(Mandatory = $false, Position = 1, ParameterSetName = "Template")]
        [string]$TemplateId
    )

    # Build URI based on parameter set
    if ($JobId) {
        $URI = "https://graph.microsoft.com/beta/servicePrincipals/$ServicePrincipalId/synchronization/jobs/$JobId/schema"
    }
    elseif ($TemplateId) {
        $URI = "https://graph.microsoft.com/beta/servicePrincipals/$ServicePrincipalId/synchronization/templates/$TemplateId/schema"
    }
    else {
        throw "Either JobId or TemplateId must be specified"
    }

    # Call base function
    try {
        $ReturnValue = Invoke-FGGetRequest -URI $URI
        return $ReturnValue
    }
    catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) {
            Write-Verbose "No synchronization schema found for service principal: $ServicePrincipalId"
            return $null
        }
        else {
            throw $_
        }
    }
}
