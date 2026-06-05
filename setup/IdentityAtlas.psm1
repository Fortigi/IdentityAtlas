# Identity Atlas Module Loader (v5)
#
# Dot-sources PowerShell functions from the repository structure. In v5 we no
# longer load the `app/db` SQL helpers — the worker container has no database
# driver and all persistence flows through the REST API.

$repoRoot = Split-Path $PSScriptRoot -Parent

# Tools — Shared PowerShell SDKs (auto-discovers all subdirectories)
$sdkFiles = @( Get-ChildItem -Path (Join-Path $repoRoot 'tools\powershell-sdk') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem -Path $_.FullName -Include *.ps1 -Recurse -ErrorAction SilentlyContinue } )

# Tools — Risk scoring and account correlation
$riskScoring = @( Get-ChildItem -Path (Join-Path $repoRoot 'tools\riskscoring') -Include *.ps1 -Recurse -ErrorAction SilentlyContinue )
$correlation = @( Get-ChildItem -Path (Join-Path $repoRoot 'tools\correlation') -Include *.ps1 -Recurse -ErrorAction SilentlyContinue )

# Crawler registry — scanned once at module load; worker is single-threaded so no invalidation needed.
# Restart the worker container to pick up newly added crawlers (Docker model: always rebuild anyway).
$script:_CrawlerRegistry = $null
function global:Get-CrawlerRegistry {
    if ($script:_CrawlerRegistry) { return $script:_CrawlerRegistry }
    $reg = @{}
    Get-ChildItem -Path (Join-Path $repoRoot 'tools\crawlers') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            $mPath = Join-Path $_.FullName 'crawler.json'
            if (Test-Path $mPath) {
                try {
                    $m = Get-Content $mPath -Raw | ConvertFrom-Json -AsHashtable
                    $reg[$m['type']] = @{ Manifest = $m; Dir = $_.FullName }
                } catch {
                    Write-Warning "Skipping malformed crawler.json at $mPath`: $_"
                }
            }
        }
    $script:_CrawlerRegistry = $reg
    return $reg
}

# Dot source all function files
foreach ($import in @($sdkFiles + $riskScoring + $correlation)) {
    try {
        . $import.fullname
    }
    catch {
        Write-Error -Message "Failed to import function $($import.fullname): $_"
    }
}
