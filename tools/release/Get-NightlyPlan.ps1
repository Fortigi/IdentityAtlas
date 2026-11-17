<#
.SYNOPSIS
    Decides what tonight's release run tests; writes it to $GITHUB_OUTPUT.

.DESCRIPTION
    Reads the tags from the checkout and asks the Actions API whether the newest
    pre-release already has its release-tested-<tag> artifact. The decision
    itself is Get-NightlyPlan (ReleaseNightly.Functions.ps1).

    Outputs: candidate, azure (true/false), marker (artifact name, empty for edge).

.EXAMPLE
    pwsh tools/release/Get-NightlyPlan.ps1 -Repository Fortigi/IdentityAtlas
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Repository,
    [string] $Override = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'ReleaseNightly.Functions.ps1')

function Test-MarkerExists([string] $Name) {
    $count = gh api "repos/$Repository/actions/artifacts?name=$([uri]::EscapeDataString($Name))&per_page=1" --jq '.total_count'
    if ($LASTEXITCODE -ne 0) { throw "Could not list artifacts named $Name." }
    [int]$count -gt 0
}

$tags = @(git tag --list 'v*')
$beta = Get-NewestPreRelease $tags
$tested = @(if ($beta -and (Test-MarkerExists (Get-TestedMarkerName $beta))) { $beta })
$plan = Get-NightlyPlan -Tags $tags -Tested $tested -Override $Override
$marker = if ($plan.Candidate -eq 'edge') { '' } else { Get-TestedMarkerName $plan.Candidate }

$lines = @("candidate=$($plan.Candidate)", "azure=$($plan.Azure.ToString().ToLower())", "marker=$marker")
if ($env:GITHUB_OUTPUT) { $lines | Add-Content $env:GITHUB_OUTPUT }
if ($env:GITHUB_STEP_SUMMARY) {
    "## Tonight: ``$($plan.Candidate)``$(if ($plan.Azure) { ' with Azure' } else { ', no Azure' })", '', $plan.Reason | Add-Content $env:GITHUB_STEP_SUMMARY
}
$lines
"reason=$($plan.Reason)"
