<#
.SYNOPSIS
    Shared helpers: read and switch the experimental riskScoring feature flag.

.DESCRIPTION
    Risk scoring is an experimental feature and OFF on a fresh install
    (FEATURE_RISK_SCORING). While it is off every risk-scoring and risk-LLM
    endpoint answers 404 - /risk-scores, /risk-profiles, /risk-classifiers,
    /risk-scoring/runs, /admin/llm, /admin/risk-profile, /admin/classifiers.
    The scripts that exercise those endpoints dot-source this file and switch
    the flag on first, through the same toggle the Admin -> Experimental tab
    uses (POST /api/admin/features/toggle).

    Dot-source it:  . (Join-Path $PSScriptRoot 'RiskScoringFeature.ps1')
#>

function Get-RiskScoringFeature {
    param([Parameter(Mandatory)][string]$ApiBaseUrl)
    $features = Invoke-RestMethod -Uri "$ApiBaseUrl/features" -Method Get -TimeoutSec 30 -ErrorAction Stop
    return ($features.riskScoring -eq $true)
}

function Set-RiskScoringFeature {
    param(
        [Parameter(Mandatory)][string]$ApiBaseUrl,
        [Parameter(Mandatory)][bool]$Enabled
    )
    $body = @{ feature = 'riskScoring'; enabled = $Enabled } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$ApiBaseUrl/admin/features/toggle" -Method Post -ContentType 'application/json' `
        -Body $body -TimeoutSec 30 -ErrorAction Stop | Out-Null
}

# Switch the flag on (a no-op when it already is). Returns $true when it was
# already on, so a caller can put it back afterwards. Throws when the toggle is
# refused - the caller reports that as a failure instead of a cascade of 404s.
function Enable-RiskScoringFeature {
    param([Parameter(Mandatory)][string]$ApiBaseUrl)
    $wasOn = Get-RiskScoringFeature -ApiBaseUrl $ApiBaseUrl
    if (-not $wasOn) { Set-RiskScoringFeature -ApiBaseUrl $ApiBaseUrl -Enabled $true }
    return $wasOn
}

# The HTTP status a request answers with (0 when there was no response at all).
function Get-RiskEndpointStatus {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method = 'Get'
    )
    $params = @{ Uri = $Uri; Method = $Method; TimeoutSec = 30; ErrorAction = 'Stop' }
    if ($Method -ne 'Get') { $params.ContentType = 'application/json'; $params.Body = '{}' }
    try {
        Invoke-RestMethod @params | Out-Null
        return 200
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

# Switch the flag on and report it through the calling script's Write-Result
# (each nightly script defines its own). Returns $false when the toggle was
# refused, so the caller stops instead of reporting a cascade of 404s.
function Initialize-RiskScoringFeature {
    param(
        [Parameter(Mandatory)][string]$ApiBaseUrl,
        [Parameter(Mandatory)][string]$ResultName
    )
    try {
        $wasOn = Enable-RiskScoringFeature -ApiBaseUrl $ApiBaseUrl
        $detail = if ($wasOn) { 'already on' } else { 'switched on' }
        Write-Result $ResultName $true $detail | Out-Null
        return $true
    } catch {
        Write-Result $ResultName $false "could not switch risk scoring on: $($_.Exception.Message)" | Out-Null
        return $false
    }
}
