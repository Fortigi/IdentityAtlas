<#
.SYNOPSIS
    The PowerShell Gallery modules CI depends on, pinned in one file.

.DESCRIPTION
    .ci/powershell-modules.json is the single place a version is written. Every
    workflow and script installs through Install-PinnedModule, so a bump is one edit
    and nothing can keep running an older copy by accident. (Before this file the same
    version was spelled out in pr.yml, coverage.yml, measure_ps.ps1 and the docs, and
    they drifted -- #1556.)

    Dependabot cannot read the PowerShell Gallery, so .github/workflows/ps-module-updates.yml
    does its job: weekly, it asks the gallery for each module's newest stable version and
    opens one pull request per module whose pin is behind. A version that is known to be
    wrong for this repository goes under that module's `skip`, with the reason; the
    updater passes over it, and drops the entry once the pin has moved past it.
#>

function Get-PinnedModuleManifestPath {
    param([string]$Root = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
    Join-Path $Root '.ci' 'powershell-modules.json'
}

function Read-PinnedModuleManifest {
    param([string]$Path = (Get-PinnedModuleManifestPath))
    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
}

function Get-PinnedModuleVersion {
    param(
        [Parameter(Mandatory)][string]$Name,
        [hashtable]$Manifest = (Read-PinnedModuleManifest)
    )
    $entry = $Manifest.modules[$Name]
    if (-not $entry) { throw "$Name is not pinned in .ci/powershell-modules.json" }
    $entry.version
}

# A skip entry names one version ("0.9.1") or every version below a bound ("<0.9.2"),
# for when a whole run of releases shares the fault.
function Test-PinnedModuleSkipped {
    param([Parameter(Mandatory)][string]$Version, [string[]]$Skip = @())
    foreach ($entry in $Skip) {
        if ($entry.StartsWith('<')) {
            if ([version]$Version -lt [version]$entry.Substring(1)) { return $true }
        }
        elseif ($Version -eq $entry) { return $true }
    }
    $false
}

# A skip entry is spent once the pin has moved to or past everything it names.
function Test-PinnedModuleSkipSpent {
    param([Parameter(Mandatory)][string]$Entry, [Parameter(Mandatory)][string]$Version)
    [version]$Entry.TrimStart('<') -le [version]$Version
}

# The newest version the updater should propose: stable, above the pin, not skipped.
# $null when the pin is already the newest such version.
function Select-PinnedModuleUpdate {
    param(
        [Parameter(Mandatory)][string]$Pinned,
        [string[]]$Available = @(),
        [string[]]$Skip = @()
    )
    $candidates = @($Available |
        Where-Object { $_ -notmatch '-' -and [version]$_ -gt [version]$Pinned -and -not (Test-PinnedModuleSkipped -Version $_ -Skip $Skip) } |
        Sort-Object { [version]$_ } -Descending)
    if ($candidates.Count) { $candidates[0] } else { $null }
}

# One record per module whose pin is behind the gallery: Name, From, To, and the
# skip reasons the move makes obsolete (the updater quotes them in its pull request,
# so the reviewer sees why the version was held back and can check it no longer is).
function Get-PinnedModuleUpdate {
    param([hashtable]$Manifest = (Read-PinnedModuleManifest))
    foreach ($name in $Manifest.modules.Keys) {
        $entry = $Manifest.modules[$name]
        $skip = if ($entry.skip) { $entry.skip } else { @{} }
        $available = @(Find-Module $name -AllVersions -Repository PSGallery | ForEach-Object { "$($_.Version)" })
        $to = Select-PinnedModuleUpdate -Pinned $entry.version -Available $available -Skip @($skip.Keys)
        if ($to) {
            [pscustomobject]@{
                Name  = $name
                From  = $entry.version
                To    = $to
                Spent = @($skip.Keys | Where-Object { Test-PinnedModuleSkipSpent -Entry $_ -Version $to } | ForEach-Object { "$_ -- $($skip[$_])" })
            }
        }
    }
}

# Move one module's pin. Skip entries at or below the new version are spent -- the
# pin can never return to them -- so they leave with the move rather than lingering
# as reasons nobody needs to read again.
function Set-PinnedModuleVersion {
    param(
        [Parameter(Mandatory)][hashtable]$Manifest,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Version
    )
    $entry = $Manifest.modules[$Name]
    if (-not $entry) { throw "$Name is not pinned in .ci/powershell-modules.json" }
    $entry.version = $Version
    if ($entry.skip) {
        foreach ($spent in @($entry.skip.Keys | Where-Object { Test-PinnedModuleSkipSpent -Entry $_ -Version $Version })) {
            $entry.skip.Remove($spent)
        }
        if (-not $entry.skip.Count) { $entry.Remove('skip') }
    }
    $Manifest
}

# Serialised with LF endings and a trailing newline, so a bump written on Windows
# and one written by the Linux updater produce the same bytes.
function ConvertTo-PinnedModuleJson {
    param([Parameter(Mandatory)][hashtable]$Manifest)
    (($Manifest | ConvertTo-Json -Depth 5) -replace "`r`n", "`n") + "`n"
}

function Install-PinnedModule {
    param(
        [Parameter(Mandatory)][string]$Name,
        [hashtable]$Manifest = (Read-PinnedModuleManifest)
    )
    $version = Get-PinnedModuleVersion -Name $Name -Manifest $Manifest
    if (-not (Get-Module $Name -ListAvailable | Where-Object { $_.Version -eq [version]$version })) {
        Install-Module $Name -RequiredVersion $version -Repository PSGallery -Force -Scope CurrentUser
    }
    Import-Module $Name -RequiredVersion $version -Force -Global
}
