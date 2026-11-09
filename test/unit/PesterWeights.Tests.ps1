# Tests for tools/pester/PesterWeights.ps1: the post-merge refresh of the Pester
# shard weights (.ci/pester-weights.json).
#
# What must hold: the weights are rewritten when, and only when, the shards they
# produce are measurably unbalanced on real times. Rewriting on every run would
# commit timing jitter after every merge. Never rewriting is how the hand-kept
# weights went stale.

BeforeAll {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
    . (Join-Path $script:RepoRoot 'tools' 'pester' 'PesterShards.ps1')
    . (Join-Path $script:RepoRoot 'tools' 'pester' 'PesterWeights.ps1')

    function script:New-Container([string]$Type, [string]$Path, [double]$Seconds) {
        [pscustomobject]@{ Type = $Type; Item = $Path; Duration = [timespan]::FromSeconds($Seconds) }
    }
    # Four 10 s files. Weights that call `a` huge put a alone on shard 1 and the
    # other three (30 s) on shard 2: slowest 30 / mean 20 = 1.5.
    $script:Even = @{ 'a.Tests.ps1' = 10.0; 'b.Tests.ps1' = 10.0; 'c.Tests.ps1' = 10.0; 'd.Tests.ps1' = 10.0 }
    $script:Skewed = @{ 'a.Tests.ps1' = 100; 'b.Tests.ps1' = 0.1; 'c.Tests.ps1' = 0.1; 'd.Tests.ps1' = 0.1 }
    function script:Write-Weights([string]$Path, [hashtable]$W) {
        Set-Content -Path $Path -Value (@{ _comment = @('x'); weights = $W } | ConvertTo-Json -Depth 4) -Encoding utf8NoBOM
    }
}

Describe 'Get-PesterFileDuration' {
    It 'keys file containers by leaf name at 0.1 s and ignores other container types' {
        $result = [pscustomobject]@{ Containers = @(
                (New-Container 'File' (Join-Path 'test' 'unit' 'A.Tests.ps1') 1.26),
                (New-Container 'File' (Join-Path 'test' 'unit' 'B.Tests.ps1') 0.04),
                (New-Container 'ScriptBlock' '<scriptblock>' 9)
            )
        }
        $d = Get-PesterFileDuration -Result $result
        $d.Keys | Sort-Object | Should -Be @('A.Tests.ps1', 'B.Tests.ps1')
        $d['A.Tests.ps1'] | Should -Be 1.3
        $d['B.Tests.ps1'] | Should -Be 0.0
    }
}

Describe 'Get-PesterShardImbalance' {
    It 'is 1.0 when the weights split the real times evenly' {
        Get-PesterShardImbalance -Duration $Even -Weight $Even -Count 2 | Should -Be 1.0
    }

    It 'measures the shards the CURRENT weights produce, on the real times' {
        Get-PesterShardImbalance -Duration $Even -Weight $Skewed -Count 2 | Should -Be 1.5
    }

    It 'is 1.0 for a run that measured nothing' {
        Get-PesterShardImbalance -Duration @{} -Weight $Skewed -Count 2 | Should -Be 1.0
    }
}

Describe 'Update-PesterWeightFile' {
    # TestDrive is shared by the whole Describe: give each case its own file, or
    # one case's write becomes the next case's "existing" weights.
    BeforeEach { $script:Path = Join-Path $TestDrive ('pester-weights-{0}.json' -f [guid]::NewGuid()) }

    It 'leaves balanced weights byte-for-byte alone and says so' {
        Write-Weights $Path $Even
        $before = Get-Content $Path -Raw
        Update-PesterWeightFile -Path $Path -Duration $Even -Count 2 | Should -BeFalse
        Get-Content $Path -Raw | Should -BeExactly $before
    }

    It 'rewrites stale weights from the measured times, sorted, naming the source' {
        Write-Weights $Path $Skewed
        Update-PesterWeightFile -Path $Path -Duration $Even -Count 2 -Source 'run 42' | Should -BeTrue
        $json = Get-Content $Path -Raw | ConvertFrom-Json -AsHashtable
        @($json.weights.Keys) | Should -Be @('a.Tests.ps1', 'b.Tests.ps1', 'c.Tests.ps1', 'd.Tests.ps1')
        $json.weights['c.Tests.ps1'] | Should -Be 10
        $json._comment[0] | Should -Match 'run 42'
    }

    It 'keeps weights whose imbalance is within the threshold' {
        Write-Weights $Path $Skewed
        Update-PesterWeightFile -Path $Path -Duration $Even -Count 2 -Threshold 1.5 | Should -BeFalse
        Update-PesterWeightFile -Path $Path -Duration $Even -Count 2 -Threshold 1.49 | Should -BeTrue
    }

    It 'writes the file when there is none yet and the default split is unbalanced' {
        # No file: every file weighs the default, so ties split by name: a,c / b,d.
        $times = @{ 'a.Tests.ps1' = 30.0; 'b.Tests.ps1' = 1.0; 'c.Tests.ps1' = 30.0; 'd.Tests.ps1' = 1.0 }
        Update-PesterWeightFile -Path $Path -Duration $times -Count 2 | Should -BeTrue
        (Get-Content $Path -Raw | ConvertFrom-Json -AsHashtable).weights['a.Tests.ps1'] | Should -Be 30
    }

    It 'never writes from a run that measured nothing' {
        Update-PesterWeightFile -Path $Path -Duration @{} -Count 2 | Should -BeFalse
        Test-Path $Path | Should -BeFalse
    }
}

Describe 'The refresh is wired to the shards PR Checks actually runs' {
    It 'coverage.yml balances for the same shard count as pr.yml' {
        $pr = Get-Content (Join-Path $RepoRoot '.github' 'workflows' 'pr.yml') -Raw
        $cov = Get-Content (Join-Path $RepoRoot '.github' 'workflows' 'coverage.yml') -Raw
        # -match (not Should -Match), so $Matches is populated in this scope.
        $pr -match '(?m)^\s+SHARDS:\s*(\d+)\s*$' | Should -BeTrue
        $shards = $Matches[1]
        $cov -match 'Update-PesterWeightFile[^\r\n]*-Count\s+(\d+)' | Should -BeTrue
        $Matches[1] | Should -Be $shards
        # and the matrix really has that many shards
        $pr -match '(?m)^\s+shard:\s*\[([\d,\s]+)\]' | Should -BeTrue
        @($Matches[1] -split ',' | Where-Object { $_.Trim() }).Count | Should -Be ([int]$shards)
    }
}
