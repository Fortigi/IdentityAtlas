<#
.SYNOPSIS
    Thin wrapper that fetches all records from an Omada OData endpoint.
.DESCRIPTION
    Omada uses OData 4.0. Combines two pagination strategies:
      1. @odata.nextLink  — standard OData cursor (Cloud / some on-prem configs)
      2. $skip pagination — manual offset paging for servers that do not return
                             @odata.nextLink but still honour $top and $skip.

    The two strategies are complementary: each page is fetched with an explicit
    $skip offset. Invoke-OmadaGetRequest will follow any @odata.nextLink returned
    within a page. The loop stops when a page returns zero records.

    IMPORTANT: The Builtin CalculatedAssignments endpoint returns variable-size
    pages (fewer than $top even when more records remain), so stopping on
    page.Count < $PageSize would cut the result short. Stopping on Count == 0
    is the only safe termination condition for all Omada OData endpoints.

    The caller gets a flat list of all records with no pagination ceremony.
#>

#region Functions

function Invoke-OmadaPagedRequest {
    [CmdletBinding()]
    [OutputType([System.Collections.Generic.List[object]])]
    param(
        [Parameter(Mandatory)] [string]$Path,
        [hashtable]$QueryParams = @{},
        [int]$PageSize  = 100,
        [int]$MaxRetries = 5,
        [string]$OverrideBaseUrl = ''  # pass through to Invoke-OmadaGetRequest (e.g. Builtin URL)
    )

    if ($null -eq $script:OmadaSession) { throw "Omada: not connected. Call Connect-OmadaAPI first." }

    $all  = [System.Collections.Generic.List[object]]::new()
    $skip = 0

    do {
        # Build per-page params: merge caller params with $top and $skip.
        # Use single-quoted keys so the literal '$top'/'$skip' strings are preserved
        # (double-quoted would interpolate them as empty PowerShell variables).
        $qp = @{ '$top' = $PageSize; '$skip' = $skip }
        foreach ($kv in $QueryParams.GetEnumerator()) { $qp[$kv.Key] = $kv.Value }

        $page = Invoke-OmadaGetRequest -Path $Path -QueryParams $qp `
            -MaxRetries $MaxRetries -OverrideBaseUrl $OverrideBaseUrl

        foreach ($r in $page) { $all.Add($r) }

        # Advance skip by the actual number of records received, not PageSize.
        # The Builtin endpoint can return fewer than $top records even when more
        # remain, so we must continue until we get an empty page (Count == 0).
        $skip += $page.Count

    } while ($page.Count -gt 0)

    return $all
}

#endregion Functions
