<#
.SYNOPSIS
    Thin wrapper for Omada endpoints that always use numeric pagination.
#>

function Invoke-OmadaPagedRequest {
    <#
    .SYNOPSIS
        Walk all pages of a numeric-paged Omada endpoint.
    .DESCRIPTION
        Forces numeric pagination regardless of what the first response contains.
        Use for high-volume endpoints that are known to use ?page=N&pageSize=N.
    #>
    [OutputType([System.Collections.Generic.List[object]])]
    param(
        [Parameter(Mandatory)] [string]$Path,
        [hashtable]$QueryParams = @{},
        [int]$PageSize = 100,
        [int]$MaxRetries = 5
    )

    if ($null -eq $script:OmadaSession) { throw "Omada: not connected. Call Connect-OmadaAPI first." }

    $base = $script:OmadaSession.BaseUrl
    $all  = [System.Collections.Generic.List[object]]::new()
    $page = 1

    while ($true) {
        $params = @{ page = $page; pageSize = $PageSize }
        foreach ($kv in $QueryParams.GetEnumerator()) { $params[$kv.Key] = $kv.Value }

        $batch = Invoke-OmadaGetRequest -Path $Path -QueryParams $params -PageSize $PageSize -MaxRetries $MaxRetries
        if (-not $batch -or $batch.Count -eq 0) { break }
        foreach ($r in $batch) { $all.Add($r) }
        if ($batch.Count -lt $PageSize) { break }
        $page++
    }

    return $all
}
