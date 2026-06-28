<#
.SYNOPSIS
    Top-level helper functions extracted from Start-OmadaCrawler.ps1.
.DESCRIPTION
    These functions were moved verbatim out of the Start script so they can be
    dot-sourced and unit-tested in isolation. They are dot-sourced back into the
    Start script's own scope, so they continue to read script-scope variables
    (e.g. $ResourceCategoryMapping, $TypeMappings, $Script:phases) at call time
    exactly as before. Behaviour is unchanged.
#>

#region Functions

function Map-ResourceCategory {
    [CmdletBinding()]
    param([string]$Category)
    foreach ($M in $ResourceCategoryMapping) {
        if ($M.category -eq $Category -or $M.category -eq '') {
            return $M.resourceType
        }
    }
    return 'Resource'
}

function Merge-TypeMappings {
    [CmdletBinding()]
    param($Defaults, $Overrides)
    if (-not $Overrides) { return $Defaults }
    $Result = @{}
    foreach ($K in $Defaults.Keys) {
        if ($Overrides.PSObject.Properties.Name -contains $K) {
            $Ov = $Overrides.$K
            if ($Ov -is [System.Management.Automation.PSCustomObject]) {
                # Convert PSCustomObject to hashtable and merge
                $Merged = @{}
                foreach ($Dk in $Defaults[$K].Keys) { $Merged[$Dk] = $Defaults[$K][$Dk] }
                foreach ($Ok in $Ov.PSObject.Properties) { $Merged[$Ok.Name] = $Ok.Value }
                $Result[$K] = $Merged
            } elseif ($Ov -is [array]) {
                $Result[$K] = @($Ov)
            } else {
                $Result[$K] = $Ov
            }
        } else {
            $Result[$K] = $Defaults[$K]
        }
    }
    return $Result
}

function Map-IdentityTypeToAtlas {
    [CmdletBinding()]
    param([string]$OmadaType)
    $Map = $TypeMappings['identityTypeToIdentityAtlas']
    if ($Map.ContainsKey($OmadaType)) { return $Map[$OmadaType] }
    Write-Host "    Warning: unknown IdentityType '$OmadaType' — defaulting to 'User'" -ForegroundColor Yellow
    return 'User'
}

function Map-ResourceTypeToAtlas {
    [CmdletBinding()]
    param([string]$OmadaType)
    $Map = $TypeMappings['resourceTypeToIdentityAtlas']
    if ($Map.ContainsKey($OmadaType)) { return $Map[$OmadaType] }
    # Normalise: remove spaces, keep as-is
    return $OmadaType -replace '\s+', ''
}

function Map-ContextTypeToAtlas {
    [CmdletBinding()]
    param([string]$OmadaType)
    $Map = $TypeMappings['contextTypeToIdentityAtlas']
    if ($Map.ContainsKey($OmadaType)) { return $Map[$OmadaType] }
    return $OmadaType -replace '\s+', ''
}

# ─── Step logging ─────────────────────────────────────────────────
function Write-Step {
    [CmdletBinding()]
    param([string]$Msg)
    Write-Host "  → $Msg" -ForegroundColor DarkGray
}

function Write-Phase {
    [CmdletBinding()]
    param([string]$Name, [TimeSpan]$Duration, [string]$ErrorMsg = $Null, [hashtable]$Records = $Null)
    $Phase = @{ name = $Name; durationMs = [int]$Duration.TotalMilliseconds; status = if ($ErrorMsg) { 'failed' } else { 'ok' } }
    if ($ErrorMsg)  { $Phase.error   = $ErrorMsg }
    if ($Records)   { $Phase.records = $Records }
    $Script:phases.Add($Phase)
}

function Send-IngestBatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Endpoint,
        [Parameter(Mandatory)] [int]$SystemId,
        [string]$SyncMode   = 'full',
        [hashtable]$Scope   = @{},
        [array]$Records     = @(),
        [string[]]$DeletedIds = @(),
        [int]$BatchSize     = 5000
    )
    if (-not $Records -or $Records.Count -eq 0) {
        # Still send an empty full-sync batch so the server can scoped-delete stale data
        $Body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = @() }
        return Invoke-IngestAPI -Endpoint $Endpoint -Body $Body
    }

    if ($DeletedIds.Count -gt 0) {
        $DelBody = @{ systemId = $SystemId; syncMode = 'delta'; scope = $Scope; records = @(); deletedIds = ConvertTo-JsonArray $DeletedIds }
        Invoke-IngestAPI -Endpoint $Endpoint -Body $DelBody | Out-Null
    }

    if ($Records.Count -le $BatchSize) {
        $Body = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = ConvertTo-JsonArray $Records }
        return Invoke-IngestAPI -Endpoint $Endpoint -Body $Body
    }

    # Chunked session for large batches
    $SyncId = $Null; $TotalInserted = 0; $TotalUpdated = 0; $TotalDeleted = 0
    for ($I = 0; $I -lt $Records.Count; $I += $BatchSize) {
        $Chunk   = $Records[$I..([Math]::Min($I + $BatchSize - 1, $Records.Count - 1))]
        $IsFirst = ($I -eq 0)
        $IsLast  = ($I + $BatchSize -ge $Records.Count)
        $Body    = @{ systemId = $SystemId; syncMode = $SyncMode; scope = $Scope; records = ConvertTo-JsonArray $Chunk
                      syncSession = if ($IsFirst) { 'start' } elseif ($IsLast) { 'end' } else { 'continue' } }
        if ($SyncId) { $Body.syncId = $SyncId }
        $Result = Invoke-IngestAPI -Endpoint $Endpoint -Body $Body
        if ($IsFirst -and $Result.syncId) { $SyncId = $Result.syncId }
        $TotalInserted += ($Result.inserted ?? 0); $TotalUpdated += ($Result.updated ?? 0); $TotalDeleted += ($Result.deleted ?? 0)
    }
    return @{ inserted = $TotalInserted; updated = $TotalUpdated; deleted = $TotalDeleted }
}

#endregion Functions
