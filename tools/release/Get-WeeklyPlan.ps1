<#
.SYNOPSIS
    Decides what this week's release run does; writes it to $GITHUB_OUTPUT. Read-only.

.DESCRIPTION
    Gathers the facts from the checkout (tags, origin/main, origin/release/X.Y,
    the Dependabot commits on main) and the Actions API (has the newest
    pre-release a release-tested-<tag> artifact?). The decisions themselves are
    pure functions in ReleaseWeekly.Functions.ps1, unit-tested in
    test/unit/ReleaseWeekly.Tests.ps1.

    Outputs:
      candidate, azure, marker        test an existing candidate (edge, or a
                                      pre-release nobody tested); an empty
                                      candidate means nothing extra this run
      stable_needed, stable_version, stable_beta, stable_sha, stable_azure
                                      the stable route: a patch release of
                                      release/X.Y
      beta_needed, beta_version, beta_sha, beta_azure
                                      the beta route: a new beta of main

    -Override (a candidate asked for by hand) tests only that and starts no route.

.EXAMPLE
    pwsh tools/release/Get-WeeklyPlan.ps1 -Repository Fortigi/IdentityAtlas
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Repository,
    [string] $Override = '',
    [switch] $RetryStable,
    [string] $Main = 'origin/main',
    [string] $Remote = 'origin'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'ReleaseRoute.Functions.ps1')
. (Join-Path $PSScriptRoot 'ReleaseWeekly.Functions.ps1')

$Templates = @('azure')
$Shipped = @('app/api', 'app/ui', 'setup/docker')
$NoRoute = @{ Sha = ''; Plan = @{ Needed = $false; Reason = 'a candidate was asked for by hand' } }

function Test-MarkerExists([string] $Name) {
    $count = gh api "repos/$Repository/actions/artifacts?name=$([uri]::EscapeDataString($Name))&per_page=1" --jq '.total_count'
    if ($LASTEXITCODE -ne 0) { throw "Could not list artifacts named $Name." }
    [int]$count -gt 0
}

function Test-Changed([string] $From, [string] $To, [string[]] $Paths) {
    & git diff --quiet $From $To -- @Paths
    $LASTEXITCODE -eq 1
}

function Get-StableFacts([string[]] $Tags) {
    $stable = (Get-StableTag $Tags | Select-Object -First 1)
    if (-not $stable) { return @{ Sha = ''; Plan = (Get-StableRoutePlan -Tags $Tags) } }
    $branch = "$Remote/$(Get-ReleaseLineName $stable)"
    $sha = (& git rev-parse --verify --quiet "$branch^{commit}") -join ''
    if (-not $sha) { return @{ Sha = ''; Plan = (Get-StableRoutePlan -Tags $Tags -BranchExists $false) } }
    & git merge-base --is-ancestor $stable $sha
    $contains = $LASTEXITCODE -eq 0
    $new = [int]((Invoke-Git rev-list --count "$stable..$sha") -join '')
    $attempted = @(Invoke-Git tag --points-at $sha | Where-Object { $_ -match '-beta\.\d+$' })
    $plan = Get-StableRoutePlan -Tags $Tags -BranchExists $true -ContainsStable $contains -NewCommits $new `
        -AttemptedAtHead $attempted -TemplatesChanged (Test-Changed $stable $sha $Templates) -Retry:$RetryStable
    @{ Sha = $sha; Plan = $plan }
}

function Get-BetaFacts([string[]] $Tags) {
    $stable = (Get-StableTag $Tags | Select-Object -First 1)
    $mainSha = (Invoke-Git rev-parse "$Main^{commit}") -join ''
    $next = Get-NextMinorBeta $Tags
    $since = if ($next.Previous) { $next.Previous } else { (Invoke-Git merge-base $stable $mainSha) -join '' }
    $commits = @(Invoke-Git rev-list --author=dependabot "$since..$mainSha" -- @Shipped)
    $shipped = @($commits | Where-Object { Test-ShippedDependencyCommit ((Invoke-Git log -1 --format=%B $_) -join "`n") }).Count
    $plan = Get-BetaRoutePlan -Tags $Tags -ShippedUpdates $shipped -TemplatesChanged (Test-Changed $since $mainSha $Templates)
    @{ Sha = $mainSha; Plan = $plan }
}

function Get-TestPlan([string[]] $Tags, [bool] $BetaRoute) {
    $preRelease = Get-NewestPreRelease $Tags
    $tested = @(if ($preRelease -and (Test-MarkerExists (Get-TestedMarkerName $preRelease))) { $preRelease })
    Get-WeeklyPlan -Tags $Tags -Tested $tested -Override $Override -BetaRoute:$BetaRoute
}

# The release line the stable route would use, when Dependabot does not point at it.
function Get-LineWarning($Plan) {
    if ($Override -or -not $Plan.ContainsKey('Line')) { return '' }
    $config = Get-Content -Raw '.github/dependabot.yml'
    if (Test-DependabotTargetsLine -Config $config -Line $Plan.Line) { return '' }
    Write-Host "::warning::.github/dependabot.yml does not target $($Plan.Line)"
    $Plan.Line
}

$tags = @(git tag --list 'v*')
$stableRoute = if ($Override) { $NoRoute } else { Get-StableFacts $tags }
$betaRoute = if ($Override) { $NoRoute } else { Get-BetaFacts $tags }
$test = Get-TestPlan $tags ([bool]$betaRoute.Plan.Needed)
$marker = if ($test.Candidate -and $test.Candidate -ne 'edge') { Get-TestedMarkerName $test.Candidate } else { '' }

$out = [ordered]@{ candidate = $test.Candidate; azure = ([bool]$test.Azure).ToString().ToLower(); marker = $marker }
$routes = @(
    (ConvertTo-RouteOutput -Name stable -Plan $stableRoute.Plan -Sha $stableRoute.Sha -Keys @('Version', 'Beta')),
    (ConvertTo-RouteOutput -Name beta -Plan $betaRoute.Plan -Sha $betaRoute.Sha))
foreach ($route in $routes) { foreach ($key in $route.Keys) { $out[$key] = $route[$key] } }
$lines = $out.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
if ($env:GITHUB_OUTPUT) { $lines | Add-Content $env:GITHUB_OUTPUT }

$summary = Format-WeeklySummary -Stable $stableRoute.Plan -Beta $betaRoute.Plan -Test $test -LineWarning (Get-LineWarning $stableRoute.Plan)
if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content $env:GITHUB_STEP_SUMMARY }
$lines
$summary
