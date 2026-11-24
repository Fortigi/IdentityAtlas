<#
.SYNOPSIS
    One Azure variant of the release test, in a resource group of its own.

.DESCRIPTION
    Variants (ReleaseTest.Azure.ps1):
      main, main-rg       main.json, sign-in off, without / with the report generator
      auth, auth-rg       main.json then main-auth.json (sign-in on), without / with
      main-upgrade        previous stable's main.json, demo data, then the
                          candidate's main.json over it: same totals afterwards
      auth-upgrade        the same with main-auth.json after each main.json

    The previous stable's templates come from its GitHub release
    (IdentityAtlas-azure-<version>.zip, pinned to its images); the candidate's
    from its release too, or from azure/ in this checkout for edge, which has
    none and follows imageChannel=edge.

    -Group is the name for the first region's group. This script creates it
    (Invoke-InRegionWithFallback); on SkuNotAvailable it deletes it and runs
    the whole variant again in the next of -Regions, in <group>-<region>. The
    workflow always deletes all of them (Remove-ReleaseTestRegionGroup).

.EXAMPLE
    pwsh tools/release/Invoke-AzureReleaseTest.ps1 -Variant auth-upgrade -Candidate v6.1.2-beta.1 -PreviousStable v6.1.1 -Group ia-reltest-123-1-auth-upgrade ...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Variant,
    [Parameter(Mandatory)][string] $Candidate,
    [Parameter(Mandatory)][string] $PreviousStable,
    [Parameter(Mandatory)][string] $Group,
    [string] $TenantId = '',
    [string] $SsoClientId = '',
    [string] $RoleCallerId = '',
    [string] $NoRoleCallerId = '',
    [string] $RunUrl = '',
    # Empty = $script:AzureRegions (ReleaseTest.Azure.ps1), which the workflow's cleanup also uses.
    [string[]] $Regions = @(),
    [string] $WorkDir = (Join-Path ([IO.Path]::GetTempPath()) "ia-azure-$PID")
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'ReleaseTest.Docker.ps1')
. (Join-Path $PSScriptRoot 'ReleaseTest.SignIn.ps1')
. (Join-Path $PSScriptRoot 'ReleaseTest.Azure.ps1')

Assert-ReleaseTestGroupName $Group
$v = Get-AzureVariant $Variant
$repoAzure = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'azure'
$script:Token = ''

$script:TemplateDirs = @{}
function Get-TemplateDir([string] $Ref) {
    if ($Ref -eq 'edge') { return $repoAzure }
    if (-not $script:TemplateDirs.ContainsKey($Ref)) { $script:TemplateDirs[$Ref] = Get-ReleaseTemplateDir $Ref }
    $script:TemplateDirs[$Ref]
}

function Get-ReleaseTemplateDir([string] $Ref) {
    $dir = Join-Path $WorkDir $Ref
    & gh release download $Ref --pattern 'IdentityAtlas-azure-*.zip' --dir $dir --clobber
    if ($LASTEXITCODE -ne 0) { throw "Release $Ref has no Azure template package." }
    Expand-Archive -Path (Get-ChildItem $dir -Filter '*.zip' | Select-Object -First 1).FullName -DestinationPath $dir -Force
    Join-Path $dir 'azure'
}

function Deploy-Main([string] $Ref, [string] $Step) {
    $params = Get-DeploymentParameter -ImageTag (ConvertTo-ImageTag $Ref) -ReportGenerator:$v.ReportGenerator
    Write-Step "$Step`: main.json of $Ref"
    $outputs = Invoke-ReleaseTestDeployment -Group $Group -TemplateFile (Join-Path (Get-TemplateDir $Ref) 'main.json') -ParametersJson $params -Name "$Step-main"
    Get-AppApiUrl $outputs
}

function Deploy-SignIn([string] $Ref, [string] $Step) {
    Write-Step "$Step`: main-auth.json of $Ref"
    $auth = @{ parameters = @{ entraTenantId = @{ value = $TenantId }; entraClientId = @{ value = $SsoClientId } } } | ConvertTo-Json -Depth 4
    Invoke-ReleaseTestDeployment -Group $Group -TemplateFile (Join-Path (Get-TemplateDir $Ref) 'main-auth.json') -ParametersJson $auth -Name "$Step-auth" | Out-Null
}

# Step 1 and, for a sign-in variant, Step 2 — the order the deployment docs give.
# main.json replaces the app settings, so after every main.json main-auth.json
# has to run again (azure/main-auth.bicep, header).
function Deploy-Release([string] $Ref, [string] $Step) {
    $api = Deploy-Main $Ref $Step
    if ($v.SignIn) { Deploy-SignIn $Ref $Step }
    $api
}

function Wait-Release([string] $BaseUrl, [string] $Ref) {
    # A redeploy restarts the app; until then the old container still answers.
    # Wait for the version first, so a schemaReady from the old one does not count.
    $tag = ConvertTo-ImageTag $Ref
    Wait-Until -Description "$BaseUrl to run $tag" -TimeoutSec 1200 -IntervalSec 15 -Condition {
        Assert-RunningVersion -BaseUrl $BaseUrl -ImageTag $tag; $true
    } | Out-Null
    Wait-SchemaReady -BaseUrl $BaseUrl -TimeoutSec 1200
}

function Assert-Variant([string] $BaseUrl) {
    if ($v.SignIn) {
        Assert-AuthConfig -BaseUrl $BaseUrl -SsoClientId $SsoClientId
        $tokens = Get-SignInToken -TenantId $TenantId -SsoClientId $SsoClientId -RoleCallerId $RoleCallerId -NoRoleCallerId $NoRoleCallerId
        $script:Token = $tokens['role']
        $problems = @(Invoke-SignInCheck -BaseUrl $BaseUrl -Tokens $tokens)
        if ($problems.Count -gt 0) { throw "Sign-in checks failed: $($problems -join '; ')" }
    } else {
        $failed = @(Invoke-SmokeTest -BaseUrl $BaseUrl)
        if ($failed.Count -gt 0) { throw "Read endpoints failed: $($failed -join '; ')" }
    }
    if ($v.ReportGenerator) { Assert-ReportGeneratorDeployed }
}

function Assert-ReportGeneratorDeployed {
    # Only the Container App's presence and state: asking the model a question
    # needs a role with data.read.reports, which the test's caller does not
    # hold, and a cold start of the scale-to-zero app is not what is tested here.
    $apps = @(Invoke-Az containerapp list --resource-group $Group)
    $rg = $apps | Where-Object { (Get-Prop $_ 'name') -like '*-report-generator' }
    if (-not $rg) { throw 'deployReportGenerator=true, but no report-generator Container App was deployed.' }
    $state = Get-Prop (Get-Prop $rg 'properties') 'provisioningState'
    if ($state -ne 'Succeeded') { throw "The report-generator Container App is '$state'." }
}

function Invoke-Fresh {
    $api = Deploy-Release $Candidate 'fresh'
    Wait-Release $api $Candidate
    Assert-Variant $api
    if (-not $v.SignIn) {
        Invoke-DemoLoad -BaseUrl $api -TimeoutSec 900
        if (-not (Get-ApiTotal -BaseUrl $api).Users) { throw 'No users after the demo load.' }
    }
}

function Invoke-Upgrade {
    # The previous release first, sign-in off: loading demo data needs an
    # Admin, which the test's caller is not, so it goes in before sign-in is
    # switched on — which is also when an operator would load it.
    $api = Deploy-Main $PreviousStable 'previous'
    Wait-Release $api $PreviousStable
    Invoke-DemoLoad -BaseUrl $api -TimeoutSec 900
    $before = Get-ApiTotal -BaseUrl $api
    if (-not $before.Users) { throw 'The previous release shows no users after the demo load.' }
    if ($v.SignIn) { Deploy-SignIn $PreviousStable 'previous' }

    $api = Deploy-Release $Candidate 'candidate'
    Wait-Release $api $Candidate
    Assert-Variant $api
    $problems = @(Compare-RowCount -Before $before -After (Get-ApiTotal -BaseUrl $api -Token $script:Token))
    if ($problems.Count -gt 0) { throw "After the upgrade: $($problems -join '; ')" }
}

if ($v.SignIn -and -not ($TenantId -and $SsoClientId -and $RoleCallerId -and $NoRoleCallerId)) {
    throw "Variant $Variant needs -TenantId, -SsoClientId, -RoleCallerId and -NoRoleCallerId."
}
New-Item -ItemType Directory -Force $WorkDir | Out-Null
if (-not $Regions) { $Regions = $script:AzureRegions }
try {
    # The whole variant per region: an upgrade restarts from the previous release.
    $region = Invoke-InRegionWithFallback -BaseName $Group -Regions $Regions -RunUrl $RunUrl -Body {
        param([string] $InGroup)
        $script:Group = $InGroup
        $script:Token = ''
        if ($v.Upgrade) { Invoke-Upgrade } else { Invoke-Fresh }
    }
    Write-Step "Azure $Variant passed for $Candidate in $region"
} catch {
    Write-Host "::error::Azure $Variant failed for ${Candidate}: $_"
    exit 1
}
