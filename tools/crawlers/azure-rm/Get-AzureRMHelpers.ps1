<#
.SYNOPSIS
    Azure Resource Manager REST helpers — auth + paged GET.

.DESCRIPTION
    Azure RM is a plain JSON REST API (not OData), so this crawler does not depend on the
    `odata` base layer. Authentication reuses the worker's Graph SDK: Get-FGAccessToken already
    supports -Resource "https://management.azure.com/" (client-credentials), so no new auth code
    is needed. These helpers add ARM-specific paging (follow `nextLink`) and throttling handling
    (honour 429 + Retry-After, the ARM read-limit response).

    Dot-source from the crawler entry point:
        . (Join-Path $PSScriptRoot 'Get-AzureRMHelpers.ps1')
#>

$script:ARMSession = $null

# Base URL is a constant — inlined in Resolve-ARMUri rather than held in a top-level $script:
# var, because the dispatcher dot-sources crawler libraries inside a ForEach-Object block, where
# a top-level $script: assignment does not reach the scope the functions read at call time.
$ARM_BASE_URL = 'https://management.azure.com'

function Connect-AzureRM {
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$TenantId,
        [Parameter(Mandatory)] [string]$ClientId,
        [Parameter(Mandatory)] [string]$ClientSecret
    )
    # Stored so the token can be refreshed mid-crawl (ARM tokens last ~60-90 min; a deep crawl
    # of many scopes can outlast that).
    $script:ARMSession = @{
        TenantId     = $TenantId
        ClientId     = $ClientId
        ClientSecret = $ClientSecret
        AcquiredAt   = [datetime]::UtcNow
    }
    Get-FGAccessToken -ClientId $ClientId -ClientSecret $ClientSecret -TenantId $TenantId `
        -Resource 'https://management.azure.com/'
    if (-not $Global:AccessToken) {
        throw "Azure RM: failed to acquire a management.azure.com access token"
    }
    Write-Host "  Azure RM: authenticated to management.azure.com (tenant $TenantId)" -ForegroundColor Green
}

function Update-ARMTokenIfNeeded {
    [CmdletBinding()]
    param()
    if (-not $script:ARMSession) { throw "Azure RM: not connected. Call Connect-AzureRM first." }
    if (([datetime]::UtcNow - $script:ARMSession.AcquiredAt).TotalMinutes -ge 45) {
        Get-FGAccessToken -ClientId $script:ARMSession.ClientId -ClientSecret $script:ARMSession.ClientSecret `
            -TenantId $script:ARMSession.TenantId -Resource 'https://management.azure.com/'
        $script:ARMSession.AcquiredAt = [datetime]::UtcNow
    }
}

# Internal: extract the HTTP status code from a caught error record (0/null when absent).
function Get-ARMErrorStatus {
    [CmdletBinding()]
    param($ErrorRecord)
    try { return [int]$ErrorRecord.Exception.Response.StatusCode } catch { return $null }
}

# Internal: is this an HTTP status worth retrying (throttling, 5xx, or no status at all)?
function Test-ARMTransientStatus {
    [CmdletBinding()]
    param($Status)
    if ($Status -eq 429) { return $true }
    if ($Status -ge 500 -and $Status -lt 600) { return $true }
    return (-not $Status)
}

# Internal: seconds to wait before the next retry — honour Retry-After, else exponential backoff.
function Get-ARMRetryWait {
    [CmdletBinding()]
    param($ErrorRecord, [int]$Attempt)
    $retryAfter = 0
    try { $retryAfter = [int]($ErrorRecord.Exception.Response.Headers['Retry-After']) } catch {}
    if ($retryAfter -gt 0) { return $retryAfter }
    return [Math]::Min(60, [int][Math]::Pow(2, $Attempt))
}

# Internal: GET one URI with retry on 429/5xx (honouring Retry-After).
function Invoke-ARMRequestRaw {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$Uri, [int]$MaxRetries = 5)
    $attempt = 0
    while ($true) {
        $attempt++
        Update-ARMTokenIfNeeded
        $Global:AzCallCount = [int]$Global:AzCallCount + 1
        try {
            return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 120 `
                -Headers @{ Authorization = "Bearer $Global:AccessToken" }
        } catch {
            $status = Get-ARMErrorStatus -ErrorRecord $_
            $canRetry = (Test-ARMTransientStatus -Status $status) -and ($attempt -le $MaxRetries)
            if (-not $canRetry) { throw }
            $wait = Get-ARMRetryWait -ErrorRecord $_ -Attempt $attempt
            Write-Host "    ARM ${status}: retry $attempt/$MaxRetries in ${wait}s" -ForegroundColor DarkYellow
            Start-Sleep -Seconds $wait
        }
    }
}

# Resolve a path (or absolute URL) against the ARM base.
function Resolve-ARMUri {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$Path)
    if ($Path -match '^https?://') { return $Path }
    return 'https://management.azure.com' + $Path
}

<#
.SYNOPSIS
    GET an ARM list endpoint, following `nextLink` across all pages; returns a flat array of the
    `value` items.
#>
function Invoke-ARMList {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$Path, [int]$MaxRetries = 5)
    $uri = Resolve-ARMUri -Path $Path
    $items = [System.Collections.Generic.List[object]]::new()
    while ($uri) {
        $resp = Invoke-ARMRequestRaw -Uri $uri -MaxRetries $MaxRetries
        if ($null -ne $resp.value) { foreach ($v in $resp.value) { [void]$items.Add($v) } }
        $uri = $resp.nextLink
    }
    return $items
}

<#
.SYNOPSIS
    GET a single ARM resource (no paging).
#>
function Invoke-ARMGet {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$Path, [int]$MaxRetries = 5)
    return Invoke-ARMRequestRaw -Uri (Resolve-ARMUri -Path $Path) -MaxRetries $MaxRetries
}
