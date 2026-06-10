#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Verifies that every $appRoot-relative path reference in node-launcher
    PowerShell scripts resolves to a file that exists in the repository.

.DESCRIPTION
    The node-launcher sets IA_APP_ROOT to the bundled-scripts directory, which
    mirrors the repo layout. Scripts that reference $appRoot/... paths break at
    runtime if those files are missing (moved, renamed, or never created).

    Parses all PS1 files under setup/docker/ and tools/crawlers/ for two patterns:
      1. "$appRoot/path/to/file"       -- string interpolation
      2. Join-Path $appRoot 'seg' ...  -- literal-segment Join-Path

    Each resolved path is asserted to exist relative to the repo root.
    Catches: moved files, renamed scripts, dead references.
    Does not catch: paths built from runtime variables (checked at runtime only).

.USAGE
    Invoke-Pester -Path test/unit/NodeLauncher.Tests.ps1 -Output Detailed
#>

BeforeDiscovery {
    $root  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $pat1  = '"\$[Aa]pp[Rr]oot[/\\]([^"]+)"'
    $pat2  = "Join-Path\s+\`$[Aa]pp[Rr]oot\s+((?:'[^']+'\s*)+)"

    $refs = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($dir in @(
        (Join-Path $root 'setup' 'docker'),
        (Join-Path $root 'tools' 'crawlers')
    )) {
        Get-ChildItem -Path $dir -Recurse -Filter '*.ps1' -ErrorAction SilentlyContinue | ForEach-Object {
            $content = Get-Content $_.FullName -Raw
            $label   = $_.FullName.Substring($root.Length).TrimStart([char]'/', [char]'\')

            # Pattern 1: "$appRoot/path/to/file" — scripts only; data files may be generated at runtime
            [regex]::Matches($content, $pat1) | ForEach-Object {
                $rel = $_.Groups[1].Value -replace '[/\\]', [System.IO.Path]::DirectorySeparatorChar
                if ($rel -match '\.(ps1|psd1|psm1)$') {
                    $refs.Add(@{ File = $label; Path = $rel; Root = $root })
                }
            }

            # Pattern 2: Join-Path $appRoot 'seg1' 'seg2' (literal segments only)
            [regex]::Matches($content, $pat2) | ForEach-Object {
                $segs = [regex]::Matches($_.Groups[1].Value, "'([^']+)'") |
                        ForEach-Object { $_.Groups[1].Value }
                $refs.Add(@{ File = $label; Path = ($segs -join [System.IO.Path]::DirectorySeparatorChar); Root = $root })
            }
        }
    }
}

Describe 'Node-launcher: $appRoot path references exist in repo' {
    It 'at least one $appRoot reference found (sanity)' -ForEach @(@{ N = $refs.Count }) {
        $N | Should -BeGreaterThan 0
    }

    It '<Path> exists (referenced in <File>)' -ForEach $refs {
        Join-Path $Root $Path | Should -Exist -Because "'$File' references `$appRoot/$Path"
    }
}
