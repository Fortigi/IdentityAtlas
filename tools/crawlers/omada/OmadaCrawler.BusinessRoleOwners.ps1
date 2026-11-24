<#
.SYNOPSIS
    The owners Omada names on its business roles, as Accountable and Responsible.

.DESCRIPTION
    Omada has an explicit and a manual owner collection on a role. When it names
    exactly one explicit owner, that person is Accountable. With several there is
    no way to tell who answers for the role, so all of them are Responsible, as
    are the manual owners.
#>

# One Omada Resource -> business-role-owner records. Empty for a role without owners.
function ConvertTo-OmadaBusinessRoleOwnerRecords {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Resource)
    $roleId = [string]$Resource.UId
    if (-not $roleId) { return @() }
    $explicit = @($Resource.EXPLICITOWNER | Where-Object { $_ -and $_.UId })
    $manual = @($Resource.MANUALOWNER | Where-Object { $_ -and $_.UId })
    $explicitRole = if ($explicit.Count -eq 1) { 'Accountable' } else { 'Responsible' }
    $records = [System.Collections.Generic.List[hashtable]]::new()
    $seen = @{}
    $add = {
        param($Owner, $Role)
        $key = "$Role|$($Owner.UId)"
        if ($seen.ContainsKey($key)) { return }
        $seen[$key] = $true
        $records.Add(@{ resourceExternalId = $roleId; role = $Role; holder = [string]$Owner.UId; holderName = [string]$Owner.DisplayName })
    }
    foreach ($owner in $explicit) { & $add $owner $explicitRole }
    foreach ($owner in $manual) { & $add $owner 'Responsible' }
    return @($records)
}

# Sends the owners of the business roles among $AllResources. A failure costs the
# owners, never the crawl.
function Sync-OmadaBusinessRoleOwners {
    [CmdletBinding()]
    param([int]$SystemId, $AllResources, [int]$BatchSize = 5000)
    $T = [datetime]::UtcNow
    Write-Host "`nBusiness role owners:" -ForegroundColor Cyan
    try {
        $records = [System.Collections.Generic.List[hashtable]]::new()
        foreach ($item in @($AllResources)) {
            $resource = ConvertTo-OmadaResourceRecord -Resource $item -UserGroupMap @{}
            if (-not $resource -or $resource.resourceType -ne 'BusinessRole') { continue }
            foreach ($record in @(ConvertTo-OmadaBusinessRoleOwnerRecords -Resource $item)) { $records.Add($record) }
        }
        for ($i = 0; $i -lt $records.Count; $i += $BatchSize) {
            $batch = @($records.GetRange($i, [Math]::Min($BatchSize, $records.Count - $i)))
            Invoke-IngestAPI -Endpoint 'ingest/business-role-owners' -Body @{ systemId = $SystemId; records = (ConvertTo-JsonArray $batch) } | Out-Null
        }
        Write-Host "  $($records.Count) owner records" -ForegroundColor Green
        Write-Phase -Name 'BusinessRoleOwners' -Duration ([datetime]::UtcNow - $T) -Records @{ owners = $records.Count }
    }
    catch {
        $message = $_.Exception.Message
        Write-Host "  Business role owners failed: $message" -ForegroundColor Red
        $Script:phaseErrors.Add("BusinessRoleOwners: $message")
        Write-Phase -Name 'BusinessRoleOwners' -Duration ([datetime]::UtcNow - $T) -ErrorMsg $message
    }
}
