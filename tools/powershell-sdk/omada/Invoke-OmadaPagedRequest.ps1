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
    within a page. The loop stops when a page returns fewer records than $PageSize,
    indicating the last page has been reached.

    The caller gets a flat list of all records with no pagination ceremony.
#>

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

        # Advance skip by PageSize for the next iteration.
        # Stop when the page is shorter than PageSize (last page) or empty.
        $skip += $PageSize

    } while ($page.Count -ge $PageSize)

    return $all
}
