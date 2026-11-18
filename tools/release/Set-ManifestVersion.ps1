<#
.SYNOPSIS
    Stamps a release or pre-release version into a module manifest (.psd1).

.DESCRIPTION
    The cut-* workflows stamp the version they release into the checkout the
    portable ZIPs are built from. ModuleVersion has to stay a System.Version,
    or Import-Module refuses the manifest and every worker job of that build
    fails. A pre-release version is therefore split in two:

        6.2.0-beta.1  ->  ModuleVersion = '6.2.0'
                          PrivateData.PSData.Prerelease = 'beta.1'

    The version readers (app/api/src/version.js) join them back with a '-', so
    the running app still reports exactly the tag. A version without a label is
    stamped into ModuleVersion as given, and an active Prerelease left in the
    manifest is commented out again.

.EXAMPLE
    pwsh tools/release/Set-ManifestVersion.ps1 -Path setup/IdentityAtlas.psd1 -Version 6.2.0-beta.1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Version
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^(?<core>\d+\.\d+\.\d+(?:\.\d+)?)(?:-(?<label>[0-9A-Za-z][0-9A-Za-z.-]*))?$') {
    throw "Version '$Version' is not Major.Minor.Patch[.Revision][-label]."
}
$core  = $Matches['core']
$label = $Matches['label']

$text = Get-Content -LiteralPath $Path -Raw
$versionLine    = "(?m)^(\s*)ModuleVersion\s*=\s*'[^']*'"
$prereleaseLine = "(?m)^(\s*)#?\s*Prerelease\s*=\s*'[^']*'"
if ($text -notmatch $versionLine) { throw "No ModuleVersion line in $Path." }
$text = $text -replace $versionLine, "`${1}ModuleVersion = '$core'"

if ($label) {
    if ($text -notmatch $prereleaseLine) { throw "No Prerelease line in $Path to carry '$label'." }
    $text = $text -replace $prereleaseLine, "`${1}Prerelease = '$label'"
} else {
    $text = $text -replace $prereleaseLine, "`${1}# Prerelease = ''"
}

Set-Content -LiteralPath $Path -Value $text -NoNewline -Encoding utf8
