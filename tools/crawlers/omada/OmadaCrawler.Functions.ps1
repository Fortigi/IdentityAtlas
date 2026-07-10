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

function ConvertTo-AtlasResourceCategory {
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
    $overrideNames = $Overrides.PSObject.Properties.Name
    $Result = @{}
    foreach ($K in $Defaults.Keys) {
        if ($overrideNames -contains $K) {
            $Result[$K] = Merge-OmadaOverrideValue -DefaultValue $Defaults[$K] -Override $Overrides.$K
        }
        else {
            $Result[$K] = $Defaults[$K]
        }
    }
    return $Result
}

function Merge-OmadaOverrideValue {
    # Resolve one config override against its default: a PSCustomObject is merged onto
    # the default hashtable; an array replaces wholesale; a scalar replaces. Extracted
    # from Merge-TypeMappings to keep both units flat.
    [CmdletBinding()]
    param($DefaultValue, $Override)
    if ($Override -is [System.Management.Automation.PSCustomObject]) {
        $Merged = @{}
        foreach ($Dk in $DefaultValue.Keys) { $Merged[$Dk] = $DefaultValue[$Dk] }
        foreach ($Ok in $Override.PSObject.Properties) { $Merged[$Ok.Name] = $Ok.Value }
        return $Merged
    }
    if ($Override -is [array]) { return @($Override) }
    return $Override
}

function ConvertTo-AtlasIdentityType {
    [CmdletBinding()]
    param([string]$OmadaType)
    $Map = $TypeMappings['identityTypeToIdentityAtlas']
    if ($Map.ContainsKey($OmadaType)) { return $Map[$OmadaType] }
    Write-Host "    Warning: unknown IdentityType '$OmadaType' — defaulting to 'User'" -ForegroundColor Yellow
    return 'User'
}

function ConvertTo-AtlasResourceType {
    [CmdletBinding()]
    param([string]$OmadaType)
    $Map = $TypeMappings['resourceTypeToIdentityAtlas']
    if ($Map.ContainsKey($OmadaType)) { return $Map[$OmadaType] }
    # Normalise: remove spaces, keep as-is
    return $OmadaType -replace '\s+', ''
}

function ConvertTo-AtlasContextType {
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

# Thin adapter over the shared Invoke-CrawlerIngestBatch (tools/crawlers/shared/
# Invoke-CrawlerIngest.ps1). Omada's original behaviour is the shared default —
# no -SkipWhenEmpty, so an empty batch is still sent as a full sync and the
# server scoped-deletes stale rows.
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
    Invoke-CrawlerIngestBatch -Endpoint $Endpoint -SystemId $SystemId -SyncMode $SyncMode -Scope $Scope `
        -Records $Records -DeletedIds $DeletedIds -BatchSize $BatchSize
}

#endregion Functions
