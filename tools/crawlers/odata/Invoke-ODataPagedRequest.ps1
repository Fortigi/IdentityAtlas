<#
.SYNOPSIS
    Thin wrapper that fetches all records from an OData endpoint using $skip pagination.
.DESCRIPTION
    Combines two pagination strategies:
      1. @odata.nextLink  — standard OData cursor (followed automatically by Invoke-ODataGetRequest)
      2. $skip pagination — manual offset paging for servers that do not return
                            @odata.nextLink but still honour $top and $skip.

    The loop stops when a page returns zero records. Stopping on Count == 0
    is the only safe termination condition — some endpoints return variable-size
    pages (fewer than $top even when more records remain).

    The caller gets a flat list of all records with no pagination ceremony.
#>

#region Functions

function Invoke-ODataPagedRequest {
    [CmdletBinding()]
    [OutputType([System.Collections.Generic.List[object]])]
    param(
        [Parameter(Mandatory)] [string]$Path,
        [hashtable]$QueryParams = @{},
        [int]$PageSize  = 100,
        [int]$MaxRetries = 5,
        [string]$OverrideBaseUrl = ''  # pass through to Invoke-ODataGetRequest
    )

    if ($null -eq $script:ODataSession) { throw "OData: not connected. Call Connect-ODataAPI first." }

    $all  = [System.Collections.Generic.List[object]]::new()
    $skip = 0

    do {
        # Build per-page params: merge caller params with $top and $skip.
        # Use single-quoted keys so the literal '$top'/'$skip' strings are preserved
        # (double-quoted would interpolate them as empty PowerShell variables).
        $qp = @{ '$top' = $PageSize; '$skip' = $skip }
        foreach ($kv in $QueryParams.GetEnumerator()) { $qp[$kv.Key] = $kv.Value }

        $page = Invoke-ODataGetRequest -Path $Path -QueryParams $qp `
            -MaxRetries $MaxRetries -OverrideBaseUrl $OverrideBaseUrl

        foreach ($r in $page) { $all.Add($r) }

        # Advance skip by the actual number of records received, not PageSize.
        $skip += $page.Count

    } while ($page.Count -gt 0)

    return $all
}

#endregion Functions
