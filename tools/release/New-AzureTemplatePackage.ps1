<#
.SYNOPSIS
    Package the Azure template of a release, pinned to that release's images.

.DESCRIPTION
    The cut workflows attach the result to the GitHub release as
    IdentityAtlas-azure-<version>.zip. Inside is azure/ as it is at the release tag,
    with ONE change: the imageTag parameter defaults to this release's image
    version, in both main.bicep and the compiled main.json.

    So a template and the images it deploys can no longer drift apart. A
    deployment that takes its template from release X runs release X's images,
    without anyone filling in a version. An operator who manages the deployment
    as code copies the package into their own repository, which also keeps the
    template, and its infrastructure changes, under their own review.

    The repository's azure/ folder is not changed: the Deploy to Azure button
    reads main's main.json and keeps following imageChannel.

    A release branch whose template predates the imageTag parameter has nothing
    to pin. The script then writes no package, says so and exits 0, so an old
    hotfix is still released, just without the package.

.PARAMETER Version
    The image version of this release: X.Y.Z.0 for a release, X.Y.Z-beta.N (or
    -rc.N / -alpha.N) for a pre-release — the tag docker-publish pushes.

.PARAMETER AzureDir
    The azure/ folder to package. Default: azure (relative to the current directory).

.PARAMETER OutFile
    Path of the zip to write.

.EXAMPLE
    pwsh tools/release/New-AzureTemplatePackage.ps1 -Version 6.0.2.0 -OutFile IdentityAtlas-azure-6.0.2.zip
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+(\.0|-(alpha|beta|rc)\.\d+)$')]
    [string] $Version,

    [string] $AzureDir = 'azure',

    [Parameter(Mandatory)]
    [string] $OutFile
)

$ErrorActionPreference = 'Stop'

# The exact unstamped declarations. Matched literally and required exactly once:
# a template that declares the parameter differently must stop the release, not
# ship a package that silently deploys whatever the channel points at.
$BicepDeclaration = "param imageTag string = ''"
$JsonDeclaration  = '"imageTag": {\s*"type": "string",\s*"defaultValue": ""'

$bicepPath = Join-Path $AzureDir 'main.bicep'
$jsonPath  = Join-Path $AzureDir 'main.json'
foreach ($p in $bicepPath, $jsonPath) {
    if (-not (Test-Path $p)) { throw "$p not found: is '$AzureDir' the azure/ folder?" }
}

$bicep = [System.IO.File]::ReadAllText((Resolve-Path $bicepPath))
$json  = [System.IO.File]::ReadAllText((Resolve-Path $jsonPath))

if (-not $bicep.Contains('param imageTag ')) {
    Write-Warning "This template has no imageTag parameter (it predates pinned releases): no Azure template package is written."
    return
}

$bicepCount = ([regex]::Matches($bicep, [regex]::Escape($BicepDeclaration))).Count
$jsonCount  = ([regex]::Matches($json, $JsonDeclaration)).Count
if ($bicepCount -ne 1 -or $jsonCount -ne 1) {
    throw "Expected the unstamped imageTag declaration exactly once in main.bicep and main.json; found $bicepCount and $jsonCount. Was main.json rebuilt after main.bicep changed?"
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) "ia-azure-$([guid]::NewGuid().ToString('N'))"
try {
    $target = Join-Path $stage 'azure'
    Copy-Item -Path $AzureDir -Destination $target -Recurse

    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $target 'main.bicep'),
        $bicep.Replace($BicepDeclaration, "param imageTag string = '$Version'"), $utf8)
    [System.IO.File]::WriteAllText((Join-Path $target 'main.json'),
        [regex]::Replace($json, $JsonDeclaration, { param($m) $m.Value -replace '"defaultValue": ""$', "`"defaultValue`": `"$Version`"" }), $utf8)

    # Read back what will ship: a stamp that did not land must not be released.
    $stamped = Get-Content (Join-Path $target 'main.json') -Raw | ConvertFrom-Json
    if ($stamped.parameters.imageTag.defaultValue -ne $Version) {
        throw "main.json in the package does not default imageTag to $Version"
    }

    # A plain-text marker, so a copy in someone's repository says which release it is.
    [System.IO.File]::WriteAllText((Join-Path $target 'RELEASE'), "$Version`n", $utf8)

    $outDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($OutFile))
    if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
    Compress-Archive -Path $target -DestinationPath $OutFile
    Write-Host "Packaged azure/ pinned to $Version -> $OutFile"
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
