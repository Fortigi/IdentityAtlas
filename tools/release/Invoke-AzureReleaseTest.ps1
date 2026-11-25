<#
.SYNOPSIS
    One Azure variant of the release test, in a resource group of its own.

.DESCRIPTION
    Variants (ReleaseTest.Azure.ps1; the steps are in ReleaseTest.AzureFlow.ps1):
      main, main-rg       main.json only, without / with the report generator.
                          An Azure install has sign-in on from the first
                          deploy, so this checks it is locked: /auth-config
                          enabled and not configured, data endpoints 401
      auth, auth-rg       main.json (locked) then main-auth.json, the sign-in
                          checks, and demo data loaded as the Admin caller
      main-upgrade        previous stable's main.json, then the candidate's
                          over it: migrated and still locked
      auth-upgrade        previous stable's main.json + main-auth.json, demo
                          and person-made data as the Admin caller, then the
                          candidate's main.json (locked again) + main-auth.json:
                          same totals and records afterwards

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
    [string] $AdminCallerId = '',
    [string] $RunUrl = '',
    # Empty = $script:AzureRegions (ReleaseTest.Azure.ps1), which the workflow's cleanup also uses.
    [string[]] $Regions = @(),
    [string] $WorkDir = (Join-Path ([IO.Path]::GetTempPath()) "ia-azure-$PID")
)

$ErrorActionPreference = 'Stop'
foreach ($part in 'Functions', 'Docker', 'SignIn', 'CuratedData', 'Azure', 'AzureFlow') {
    . (Join-Path $PSScriptRoot "ReleaseTest.$part.ps1")
}

Assert-ReleaseTestGroupName $Group
if (-not $Regions) { $Regions = $script:AzureRegions }
try {
    $ctx = New-AzureRunContext -Variant $Variant -Candidate $Candidate -PreviousStable $PreviousStable -Group $Group `
        -TenantId $TenantId -SsoClientId $SsoClientId -RoleCallerId $RoleCallerId -NoRoleCallerId $NoRoleCallerId -AdminCallerId $AdminCallerId `
        -WorkDir $WorkDir -RepoAzure (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'azure')
    New-Item -ItemType Directory -Force $WorkDir | Out-Null
    # The whole variant per region: an upgrade restarts from the previous release.
    $region = Invoke-InRegionWithFallback -BaseName $Group -Regions $Regions -RunUrl $RunUrl -Body {
        param([string] $InGroup)
        $ctx.Group = $InGroup
        if ($ctx.V.Upgrade) { Invoke-AzureUpgrade $ctx } else { Invoke-AzureFresh $ctx }
    }
    Write-Step "Azure $Variant passed for $Candidate in $region"
} catch {
    Write-Host "::error::Azure $Variant failed for ${Candidate}: $_"
    exit 1
}
