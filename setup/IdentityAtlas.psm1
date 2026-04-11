# Identity Atlas Module Loader (v5)
#
# Dot-sources PowerShell functions from the repository structure. In v5 we no
# longer load the `app/db` SQL helpers — the worker container has no database
# driver and all persistence flows through the REST API.

$repoRoot = Split-Path $PSScriptRoot -Parent

# Tools — PowerShell SDK (Graph API wrappers, idempotent helpers)
$graph   = @( Get-ChildItem -Path (Join-Path $repoRoot 'tools\powershell-sdk\graph')   -Include *.ps1 -Recurse -ErrorAction SilentlyContinue )
$helpers = @( Get-ChildItem -Path (Join-Path $repoRoot 'tools\powershell-sdk\helpers') -Include *.ps1 -Recurse -ErrorAction SilentlyContinue )

# Tools — Risk scoring and account correlation
$riskScoring = @( Get-ChildItem -Path (Join-Path $repoRoot 'tools\riskscoring') -Include *.ps1 -Recurse -ErrorAction SilentlyContinue )
$correlation = @( Get-ChildItem -Path (Join-Path $repoRoot 'tools\correlation') -Include *.ps1 -Recurse -ErrorAction SilentlyContinue )

# Dot source all function files
foreach ($import in @($graph + $helpers + $riskScoring + $correlation)) {
    try {
        . $import.fullname
    }
    catch {
        Write-Error -Message "Failed to import function $($import.fullname): $_"
    }
}
