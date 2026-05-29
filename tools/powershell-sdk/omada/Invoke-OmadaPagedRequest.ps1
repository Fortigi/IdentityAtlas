<#
.SYNOPSIS
    Thin wrapper that fetches all records from an Omada OData endpoint.
.DESCRIPTION
    Omada uses OData 4.0. Passes $top to set the page size; Invoke-OmadaGetRequest
    then follows @odata.nextLink automatically until all pages are collected.
    The caller gets a flat list of all records with no pagination ceremony.
#>

function Invoke-OmadaPagedRequest {
    [OutputType([System.Collections.Generic.List[object]])]
    param(
        [Parameter(Mandatory)] [string]$Path,
        [hashtable]$QueryParams = @{},
        [int]$PageSize  = 100,
        [int]$MaxRetries = 5
    )

    if ($null -eq $script:OmadaSession) { throw "Omada: not connected. Call Connect-OmadaAPI first." }

    # OData pagination: $top sets the page size. The server includes
    # @odata.nextLink in the response when more pages exist; Invoke-OmadaGetRequest
    # follows those links until exhausted.
    $params = @{ '$top' = $PageSize }
    foreach ($kv in $QueryParams.GetEnumerator()) { $params[$kv.Key] = $kv.Value }

    return Invoke-OmadaGetRequest -Path $Path -QueryParams $params -MaxRetries $MaxRetries
}
