<#
.SYNOPSIS
    Keeps the Pester shard weights (.ci/pester-weights.json) in step with measured
    test times, so the PR Checks shards stay balanced without anyone refreshing them.

.DESCRIPTION
    Dot-source this file after PesterShards.ps1; it defines functions only.

    coverage.yml runs the whole suite after every merge. It hands that run's result to
    Update-PesterWeightFile, which rewrites the weights only when they have gone
    stale enough to matter. "Matter" means the shards the CURRENT weights produce
    would, on the times just measured, leave the slowest shard more than
    -Threshold times the mean. Rewriting on every run would commit timing jitter
    on every merge. Stale weights can only make shards uneven, never skip a test,
    so the threshold just trades a little balance for a quiet history.

    The file lives in .ci/ rather than beside the tests because coverage.yml
    triggers on test/unit/**: committing it there would re-run the workflow.
#>

function Get-PesterFileDuration {
    <#
    .SYNOPSIS  Seconds per test file (leaf name → seconds, 0.1 s resolution) from an Invoke-Pester -PassThru result.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)] $Result)
    $out = @{}
    foreach ($c in @($Result.Containers)) {
        if ($c.Type -ne 'File') { continue }
        $leaf = Split-Path ([string]$c.Item) -Leaf
        $out[$leaf] = [math]::Round($c.Duration.TotalSeconds, 1)
    }
    $out
}

function Get-PesterShardImbalance {
    <#
    .SYNOPSIS  Slowest shard ÷ mean shard, in measured seconds, for the shards $Weight produces.
    .DESCRIPTION
        Shards are assigned exactly as PR Checks assigns them (Get-PesterShardFile with
        $Weight), then each shard's real cost is summed from $Duration. 1.0 is perfect.
    #>
    [CmdletBinding()]
    [OutputType([double])]
    param(
        [Parameter(Mandatory)] [hashtable] $Duration,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [hashtable] $Weight,
        [Parameter(Mandatory)] [ValidateRange(1, 64)] [int] $Count
    )
    $files = @($Duration.Keys | Sort-Object)
    if (-not $files.Count) { return 1.0 }
    $loads = foreach ($i in 1..$Count) {
        $mine = @(Get-PesterShardFile -TestFile $files -Weight $Weight -Count $Count -Index $i)
        ($mine | ForEach-Object { $Duration[$_] } | Measure-Object -Sum).Sum
    }
    $mean = ($loads | Measure-Object -Average).Average
    if ($mean -le 0) { return 1.0 }
    ($loads | Measure-Object -Maximum).Maximum / $mean
}

function Update-PesterWeightFile {
    <#
    .SYNOPSIS  Rewrites the weights file from $Duration when the current weights are too unbalanced. Returns $true when it wrote.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [hashtable] $Duration,
        [Parameter(Mandatory)] [int] $Count,
        [double] $Threshold = 1.15,
        [string] $Source = 'a coverage.yml run'
    )
    # A run that measured nothing reads as balanced (imbalance 1.0), so it never writes.
    $current = @{}
    if (Test-Path $Path) {
        $current = (Get-Content $Path -Raw | ConvertFrom-Json -AsHashtable).weights
    }
    $ratio = Get-PesterShardImbalance -Duration $Duration -Weight $current -Count $Count
    if ($ratio -le $Threshold) {
        Write-Host ("Pester weights kept: slowest shard is {0:N2}x the mean (limit {1:N2})" -f $ratio, $Threshold)
        return $false
    }
    $sorted = [ordered]@{}
    foreach ($k in ($Duration.Keys | Sort-Object)) { $sorted[$k] = $Duration[$k] }
    $doc = [ordered]@{
        _comment = @(
            "Seconds per Pester test file, measured by $Source.",
            'Used only to BALANCE the PR Checks shards (tools/pester/PesterShards.ps1); a file not listed weighs 0.3 s.',
            ("Rewritten automatically (tools/pester/PesterWeights.ps1) when the shards these weights produce run more than {0:N2}x the mean on measured times; stale numbers can only make the shards uneven, never skip a test." -f $Threshold)
        )
        weights  = $sorted
    }
    Set-Content -Path $Path -Value ($doc | ConvertTo-Json -Depth 4) -Encoding utf8NoBOM
    Write-Host ("Pester weights rewritten: slowest shard was {0:N2}x the mean (limit {1:N2})" -f $ratio, $Threshold)
    $true
}
