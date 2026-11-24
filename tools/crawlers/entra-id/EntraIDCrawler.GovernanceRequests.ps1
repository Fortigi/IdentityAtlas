<#
.SYNOPSIS
    Open access-package requests: who is waiting for a business role.

.DESCRIPTION
    Own file so EntraIDCrawler.Phases.ps1 stays under the file-length ratchet.
    Only open requests are kept. A finished request is history and already shows
    as an assignment, or as nothing when it was denied.
#>

$script:EntraOpenRequestStates = @('submitted', 'pendingApproval', 'delivering', 'scheduled')

# One Graph request -> an ingest/governance/requests record, or $null when it is
# closed or names no access package.
function ConvertTo-EntraAssignmentRequestRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Request)
    if ("$($Request.state)" -notin $script:EntraOpenRequestStates) { return $null }
    $apId = if ($Request.accessPackage) { $Request.accessPackage.id } else { $null }
    if (-not $Request.id -or -not $apId) { return $null }
    $record = @{
        id                = $Request.id
        resourceId        = $apId
        requestType       = $Request.requestType
        requestState      = $Request.state
        requestStatus     = $Request.status
        justification     = $Request.justification
        createdDateTime   = $Request.createdDateTime
        completedDateTime = $Request.completedDateTime
    }
    if ($Request.requestor) {
        if ($Request.requestor.objectId) { $record.requestorId = $Request.requestor.objectId }
        $record.requestor = @{ displayName = $Request.requestor.displayName; email = $Request.requestor.email }
    }
    return $record
}

# Always a full load, also when empty: that is what clears a request that has
# been decided since the last run. A failed read sends nothing, so it never does.
function Sync-EntraGovernanceRequests {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int]$SystemId)

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $errorMessage = $null
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing governance (open access requests)..." -ForegroundColor Cyan
    try {
        $records = [System.Collections.Generic.List[hashtable]]::new()
        Invoke-FGGetRequestStream -URI "https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentRequests?`$expand=requestor,accessPackage" | ForEach-Object {
            $record = ConvertTo-EntraAssignmentRequestRecord -Request $_
            if ($record) { $records.Add($record) }
        }
        Invoke-CrawlerIngestBatch -Endpoint 'ingest/governance/requests' -SystemId $SystemId -SyncMode 'full' -Records @($records) | Out-Null
        Write-Host "  $($records.Count) open access requests" -ForegroundColor Green
    }
    catch {
        $errorMessage = $_.Exception.Message
        Write-Host "  Access request sync failed: $errorMessage" -ForegroundColor Red
        $script:phaseErrors.Add("Governance/AssignmentRequests: $errorMessage")
    }
    $stopwatch.Stop()
    Write-Phase -Name 'Governance/AssignmentRequests' -Duration $stopwatch.Elapsed -ErrorMsg $errorMessage
}
