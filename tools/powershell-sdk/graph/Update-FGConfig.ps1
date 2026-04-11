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

    # ── Compare top-level sections ────────────────────────────────────────────

    # Sections to skip — either auto-generated or internal
    $skipTopLevel = @('_INFO', '_NOTE', '_USAGE', '_LLM_NOTE', '_RISKSCORING_NOTE',
                      '_ACCOUNTCORRELATION_NOTE', '_UI_NOTE', 'Azure', 'Graph', 'UI', 'Sync')

    $missingSections  = [System.Collections.Generic.List[string]]::new()
    $missingSyncKeys  = [System.Collections.Generic.List[string]]::new()
    $internalSyncKeys = @('ScheduleTimeZone', 'ParallelExecution', 'Views')

    foreach ($key in $template.PSObject.Properties.Name) {
        if ($skipTopLevel -contains $key) { continue }
        if (-not $config.PSObject.Properties[$key]) {
            $missingSections.Add($key)
        }
    }

    # ── Compare Sync sub-keys ─────────────────────────────────────────────────

    if ($template.Sync -and $config.Sync) {
        foreach ($key in $template.Sync.PSObject.Properties.Name) {
            if ($internalSyncKeys -contains $key) { continue }
            if ($key.StartsWith('_')) { continue }   # skip _Comment / _V3_NOTE etc.
            if (-not $config.Sync.PSObject.Properties[$key]) {
                $missingSyncKeys.Add($key)
            }
        }
    }

    # ── Report ────────────────────────────────────────────────────────────────

    $totalMissing = $missingSections.Count + $missingSyncKeys.Count

    if ($totalMissing -eq 0) {
        Write-Host "[Update-FGConfig] Config is up to date — no missing sections." -ForegroundColor Green
        return @{ Missing = @(); Added = @() }
    }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host " Config file has $totalMissing missing section(s)" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "  Config: $ConfigFile" -ForegroundColor Gray

    if ($missingSections.Count -gt 0) {
        Write-Host ""
        Write-Host "  Missing top-level sections:" -ForegroundColor Yellow
        foreach ($s in $missingSections) {
            Write-Host "    - $s" -ForegroundColor Gray
        }
    }

    if ($missingSyncKeys.Count -gt 0) {
        Write-Host ""
        Write-Host "  Missing Sync entries:" -ForegroundColor Yellow
        foreach ($s in $missingSyncKeys) {
            Write-Host "    - Sync.$s" -ForegroundColor Gray
        }
    }

    if ($Silent) {
        Write-Host ""
        Write-Host "  Run Update-FGConfig -ConfigFile '$ConfigFile' to add them interactively." -ForegroundColor Cyan
        return @{
            Missing = ($missingSections + $missingSyncKeys)
            Added   = @()
        }
    }

    # ── Interactive prompts ───────────────────────────────────────────────────

    $added   = [System.Collections.Generic.List[string]]::new()
    $changed = $false

    # Top-level sections
    foreach ($key in $missingSections) {
        Write-Host ""
        $templateValue = $template.$key
        $preview = ($templateValue | ConvertTo-Json -Depth 3 -Compress)
        if ($preview.Length -gt 120) { $preview = $preview.Substring(0, 117) + "..." }
        Write-Host "  Missing section: $key" -ForegroundColor Yellow
        Write-Host "  Default: $preview" -ForegroundColor Gray
        $answer = Read-Host "  Add '$key' with defaults? (Y/N)"
        if ($answer -match '^[Yy]') {
            $config | Add-Member -NotePropertyName $key -NotePropertyValue $templateValue -Force
            $added.Add($key)
            $changed = $true
            Write-Host "  Added: $key" -ForegroundColor Green
        }
    }

    # Sync sub-keys
    foreach ($key in $missingSyncKeys) {
        Write-Host ""
        $templateValue = $template.Sync.$key
        $preview = ($templateValue | ConvertTo-Json -Depth 3 -Compress)
        if ($preview.Length -gt 120) { $preview = $preview.Substring(0, 117) + "..." }
        Write-Host "  Missing sync entry: Sync.$key" -ForegroundColor Yellow
        Write-Host "  Default: $preview" -ForegroundColor Gray
        $answer = Read-Host "  Add 'Sync.$key' with defaults? (Y/N)"
        if ($answer -match '^[Yy]') {
            $config.Sync | Add-Member -NotePropertyName $key -NotePropertyValue $templateValue -Force
            $added.Add("Sync.$key")
            $changed = $true
            Write-Host "  Added: Sync.$key" -ForegroundColor Green
        }
    }

    # ── Save ──────────────────────────────────────────────────────────────────

    if ($changed) {
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
