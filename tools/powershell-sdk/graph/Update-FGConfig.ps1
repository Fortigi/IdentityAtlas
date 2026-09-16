# ── Helpers ───────────────────────────────────────────────────────────────────

function Get-FGConfigDefaultPreview {
    # Compact-JSON preview of a template default, truncated for prompt display.
    param($Value)

    $preview = ($Value | ConvertTo-Json -Depth 3 -Compress)
    if ($preview.Length -gt 120) { $preview = $preview.Substring(0, 117) + "..." }
    return $preview
}

function Get-FGMissingTopLevelSections {
    # Top-level template keys that are absent from the config (skip list excluded).
    param($Template, $Config, $SkipTopLevel)

    $missing = [System.Collections.Generic.List[string]]::new()
    foreach ($key in $Template.PSObject.Properties.Name) {
        if ($SkipTopLevel -contains $key) { continue }
        if (-not $Config.PSObject.Properties[$key]) {
            $missing.Add($key)
        }
    }
    return ,$missing
}

function Get-FGMissingSyncKeys {
    # Sync sub-keys present in the template but missing from the config.
    param($Template, $Config, $InternalSyncKeys)

    $missing = [System.Collections.Generic.List[string]]::new()
    if ($Template.Sync -and $Config.Sync) {
        foreach ($key in $Template.Sync.PSObject.Properties.Name) {
            if ($InternalSyncKeys -contains $key) { continue }
            if ($key.StartsWith('_')) { continue }   # skip _Comment / _V3_NOTE etc.
            if (-not $Config.Sync.PSObject.Properties[$key]) {
                $missing.Add($key)
            }
        }
    }
    return ,$missing
}

function Write-FGMissingSectionsReport {
    # Prints the missing-section summary header and lists.
    param($ConfigFile, $TotalMissing, $MissingSections, $MissingSyncKeys)

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host " Config file has $TotalMissing missing section(s)" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "  Config: $ConfigFile" -ForegroundColor Gray

    if ($MissingSections.Count -gt 0) {
        Write-Host ""
        Write-Host "  Missing top-level sections:" -ForegroundColor Yellow
        foreach ($s in $MissingSections) {
            Write-Host "    - $s" -ForegroundColor Gray
        }
    }

    if ($MissingSyncKeys.Count -gt 0) {
        Write-Host ""
        Write-Host "  Missing Sync entries:" -ForegroundColor Yellow
        foreach ($s in $MissingSyncKeys) {
            Write-Host "    - Sync.$s" -ForegroundColor Gray
        }
    }
}

function Add-FGMissingConfigMembers {
    # Prompts for each missing key and adds confirmed defaults to $TargetObject,
    # recording each added label (prefixed with $KeyPrefix) in $AddedList.
    param($TargetObject, $TemplateSource, $Keys, $KeyPrefix, $MissingLabel, $AddedList)

    foreach ($key in $Keys) {
        Write-Host ""
        $templateValue = $TemplateSource.$key
        $preview = Get-FGConfigDefaultPreview $templateValue
        Write-Host "  $MissingLabel`: $KeyPrefix$key" -ForegroundColor Yellow
        Write-Host "  Default: $preview" -ForegroundColor Gray
        $answer = Read-Host "  Add '$KeyPrefix$key' with defaults? (Y/N)"
        if ($answer -match '^[Yy]') {
            $TargetObject | Add-Member -NotePropertyName $key -NotePropertyValue $templateValue -Force
            $AddedList.Add("$KeyPrefix$key")
            Write-Host "  Added: $KeyPrefix$key" -ForegroundColor Green
        }
    }
}

# ── Public function ─────────────────────────────────────────────────────────────

function Update-FGConfig {
    <#
    .SYNOPSIS
        Compares a config file against the template and offers to add any missing sections.

    .DESCRIPTION
        Reads the installed module template (tenantname.json.template) and compares it to
        an existing config file. For each top-level section and Sync sub-key that is present
        in the template but missing from the config, the user is prompted to add it with the
        template defaults. The config file is saved after all additions.

        Useful after upgrading the module — new sync types (e.g. v3.0 Principals,
        EntraDirectoryRoles) and new feature sections (LLM, RiskScoring, AccountCorrelation)
        will be detected and offered automatically.

    .PARAMETER ConfigFile
        Path to the existing config file to update.

    .PARAMETER Silent
        If specified, does not prompt — only reports missing sections and returns them.
        Use this to check programmatically without interactive prompts.

    .EXAMPLE
        Update-FGConfig -ConfigFile .\Config\mycompany.json

        Interactively offers to add any missing sections from the template.

    .EXAMPLE
        Update-FGConfig -ConfigFile .\Config\mycompany.json -Silent

        Reports missing sections without prompting or modifying the file.
    #>
    [alias("Update-Config")]
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigFile,

        [Parameter(Mandatory = $false)]
        [switch]$Silent
    )

    # ── Load config ───────────────────────────────────────────────────────────

    if (-not (Test-Path $ConfigFile)) {
        throw "Config file not found: $ConfigFile"
    }

    $config = Get-Content -Path $ConfigFile -Raw | ConvertFrom-Json
    if (-not $config) {
        throw "Failed to parse config file: $ConfigFile"
    }

    # ── Load template ─────────────────────────────────────────────────────────

    $templatePath = Join-Path $PSScriptRoot "..\..\Config\tenantname.json.template"
    if (-not (Test-Path $templatePath)) {
        Write-Warning "Template file not found at: $templatePath"
        return
    }

    $template = Get-Content -Path $templatePath -Raw | ConvertFrom-Json
    if (-not $template) {
        Write-Warning "Failed to parse template file."
        return
    }

    # ── Compare template against config ───────────────────────────────────────

    # Sections to skip — either auto-generated or internal
    $skipTopLevel = @('_INFO', '_NOTE', '_USAGE', '_LLM_NOTE', '_RISKSCORING_NOTE',
                      '_ACCOUNTCORRELATION_NOTE', '_UI_NOTE', 'Azure', 'Graph', 'UI', 'Sync')
    $internalSyncKeys = @('ScheduleTimeZone', 'ParallelExecution', 'Views')

    $missingSections = Get-FGMissingTopLevelSections -Template $template -Config $config -SkipTopLevel $skipTopLevel
    $missingSyncKeys = Get-FGMissingSyncKeys -Template $template -Config $config -InternalSyncKeys $internalSyncKeys

    # ── Report ────────────────────────────────────────────────────────────────

    $totalMissing = $missingSections.Count + $missingSyncKeys.Count

    if ($totalMissing -eq 0) {
        Write-Host "[Update-FGConfig] Config is up to date — no missing sections." -ForegroundColor Green
        return @{ Missing = @(); Added = @() }
    }

    Write-FGMissingSectionsReport -ConfigFile $ConfigFile -TotalMissing $totalMissing `
        -MissingSections $missingSections -MissingSyncKeys $missingSyncKeys

    if ($Silent) {
        Write-Host ""
        Write-Host "  Run Update-FGConfig -ConfigFile '$ConfigFile' to add them interactively." -ForegroundColor Cyan
        return @{
            Missing = ($missingSections + $missingSyncKeys)
            Added   = @()
        }
    }

    # ── Interactive prompts ───────────────────────────────────────────────────

    $added = [System.Collections.Generic.List[string]]::new()
    Add-FGMissingConfigMembers -TargetObject $config -TemplateSource $template `
        -Keys $missingSections -KeyPrefix '' -MissingLabel 'Missing section' -AddedList $added
    Add-FGMissingConfigMembers -TargetObject $config.Sync -TemplateSource $template.Sync `
        -Keys $missingSyncKeys -KeyPrefix 'Sync.' -MissingLabel 'Missing sync entry' -AddedList $added

    # ── Save ──────────────────────────────────────────────────────────────────

    if ($added.Count -gt 0) {
        try {
            $config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigFile -Encoding UTF8
            Write-Host ""
            Write-Host "  Config file updated: $($added.Count) section(s) added." -ForegroundColor Green
            Write-Host "  File: $ConfigFile" -ForegroundColor Gray
        }
        catch {
            Write-Warning "Failed to save config file: $_"
        }
    }
    else {
        Write-Host ""
        Write-Host "  No changes made." -ForegroundColor Gray
    }

    return @{
        Missing = ($missingSections + $missingSyncKeys)
        Added   = $added
    }
}
