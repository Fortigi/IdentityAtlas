# Tests for tools/pester/PesterShards.ps1 — how PR Checks splits the Pester suite over
# parallel runners and merges their coverage back into one figure for the 90% floor.
#
# What must hold: every test file runs in exactly one shard, every runner computes
# the same split, and the merged coverage equals what one run over everything would
# report (a command is covered when ANY shard executed it), refusing to merge shards
# that measured different code.

BeforeAll {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
    . (Join-Path $script:RepoRoot 'tools' 'pester' 'PesterShards.ps1')

    function script:New-Cmd([string]$File, [int]$Line, [int]$Col) {
        [pscustomobject]@{ File = $File; StartLine = $Line; StartColumn = $Col; EndLine = $Line; EndColumn = $Col + 4 }
    }
}

Describe 'Dot-sourcing PesterShards.ps1' {
    It 'leaves strict mode off in the scope that then runs the suite' {
        # The shard job dot-sources this file and runs every test in that scope. A
        # top-level Set-StrictMode once made dozens of unrelated tests fail on
        # reading a property their fixture object did not have.
        $file = Join-Path $RepoRoot 'tools' 'pester' 'PesterShards.ps1'
        $probe = "Set-StrictMode -Off; . '$file'; `$o = [pscustomobject]@{}; try { `$null = `$o.Missing; 'off' } catch { 'strict' }"
        pwsh -NoProfile -Command $probe | Should -Be 'off'
    }
}

Describe 'Get-PesterShardFile' {
    BeforeAll {
        $script:W = @{ 'a.Tests.ps1' = 10; 'b.Tests.ps1' = 6; 'c.Tests.ps1' = 5; 'd.Tests.ps1' = 4 }
        $script:Files = 'x/d.Tests.ps1', 'x/c.Tests.ps1', 'x/b.Tests.ps1', 'x/a.Tests.ps1'
    }

    It 'assigns heaviest-first to the lightest shard' {
        # a(10)→1, b(6)→2, c(5)→2 (6<10), d(4)→1 (10<11).
        Get-PesterShardFile -TestFile $Files -Weight $W -Count 2 -Index 1 | Should -Be @('x/a.Tests.ps1', 'x/d.Tests.ps1')
        Get-PesterShardFile -TestFile $Files -Weight $W -Count 2 -Index 2 | Should -Be @('x/b.Tests.ps1', 'x/c.Tests.ps1')
    }

    It 'does not depend on the order files are listed in' {
        $reversed = $Files[($Files.Count - 1)..0]
        Get-PesterShardFile -TestFile $reversed -Weight $W -Count 2 -Index 1 | Should -Be @('x/a.Tests.ps1', 'x/d.Tests.ps1')
    }

    It 'breaks equal weights by name, so every runner agrees' {
        $eq = @{ 'q.Tests.ps1' = 1; 'p.Tests.ps1' = 1 }
        Get-PesterShardFile -TestFile 'q.Tests.ps1', 'p.Tests.ps1' -Weight $eq -Count 2 -Index 1 | Should -Be @('p.Tests.ps1')
        Get-PesterShardFile -TestFile 'q.Tests.ps1', 'p.Tests.ps1' -Weight $eq -Count 2 -Index 2 | Should -Be @('q.Tests.ps1')
    }

    It 'gives an unlisted file the default weight instead of dropping it' {
        # At weight 11 the unlisted file is the heaviest and opens shard 1 alone; at the
        # 0.3 default it is the lightest and lands last, beside b.
        $files = 'a.Tests.ps1', 'b.Tests.ps1', 'new.Tests.ps1'
        Get-PesterShardFile -TestFile $files -Weight $W -Count 2 -Index 1 -DefaultWeight 11 | Should -Be @('new.Tests.ps1')
        Get-PesterShardFile -TestFile $files -Weight $W -Count 2 -Index 2 | Should -Be @('b.Tests.ps1', 'new.Tests.ps1')
    }

    It 'puts every file in exactly one shard' {
        $files = 1..23 | ForEach-Object { "f$_.Tests.ps1" }
        $weights = @{}; 1..23 | ForEach-Object { $weights["f$_.Tests.ps1"] = ($_ * 7) % 11 }
        $all = 1..4 | ForEach-Object { Get-PesterShardFile -TestFile $files -Weight $weights -Count 4 -Index $_ }
        @($all).Count | Should -Be 23
        @($all | Sort-Object -Unique).Count | Should -Be 23
    }

    It 'yields nothing for a shard with no files' {
        @(Get-PesterShardFile -TestFile 'a.Tests.ps1' -Weight $W -Count 3 -Index 3).Count | Should -Be 0
        @(Get-PesterShardFile -TestFile 'a.Tests.ps1' -Weight $W -Count 3 -Index 1) | Should -Be @('a.Tests.ps1')
    }

    It 'rejects an index outside 1..Count' {
        { Get-PesterShardFile -TestFile $Files -Weight $W -Count 2 -Index 3 } | Should -Throw '*outside 1..2*'
        { Get-PesterShardFile -TestFile $Files -Weight $W -Count 2 -Index 0 } | Should -Throw '*outside 1..2*'
    }

    It 'lists only weights for test files that exist (a renamed file must not keep a stale entry)' {
        $json = Get-Content (Join-Path $RepoRoot '.ci' 'pester-weights.json') -Raw | ConvertFrom-Json -AsHashtable
        $existing = Get-ChildItem (Join-Path $RepoRoot 'test' 'unit') -Filter '*.Tests.ps1' -File | ForEach-Object Name
        $json.weights.Keys | Where-Object { $_ -notin $existing } | Should -BeNullOrEmpty
    }
}

Describe 'Get-PesterCoverageTarget' {
    It 'measures product code of the SDK, risk scoring, crawler folders and the shared layer only' {
        $root = Join-Path $TestDrive 'repo'
        $files = @(
            'tools/powershell-sdk/Get-Thing.ps1', 'tools/powershell-sdk/Get-Thing.Tests.ps1',
            'tools/riskscoring/Score.ps1',
            'tools/crawlers/foo/crawler.json', 'tools/crawlers/foo/Start-FooCrawler.ps1',
            'tools/crawlers/foo/Test-FooCrawler.ps1', 'tools/crawlers/foo/Seed-Foo.ps1',
            'tools/crawlers/foo/dev/Try.ps1',
            'tools/crawlers/bar/Orphan.ps1',                  # no crawler.json and not shared: not product
            # shared/ has no crawler.json but IS product: the library every crawler runs through
            'tools/crawlers/shared/Invoke-CrawlerIngest.ps1',
            'tools/crawlers/shared/Start-MockScimServer.ps1', # test scaffolding
            'tools/crawlers/shared/Test-Helpers.ps1',         # test scaffolding
            'tools/crawlers/shared/Shared.Tests.ps1'
        )
        foreach ($f in $files) { New-Item -ItemType File -Force -Path (Join-Path $root $f) | Out-Null }

        $got = Get-PesterCoverageTarget -Root $root | ForEach-Object { [System.IO.Path]::GetRelativePath($root, $_) -replace '\\', '/' }
        $got | Should -Be @(
            'tools/crawlers/foo/Start-FooCrawler.ps1', 'tools/crawlers/shared/Invoke-CrawlerIngest.ps1',
            'tools/powershell-sdk/Get-Thing.ps1', 'tools/riskscoring/Score.ps1'
        )
    }

    It 'is the definition both coverage workflows use, not an inline copy' {
        # pr.yml and coverage.yml used to enumerate the files inline and drifted apart.
        $root = Join-Path $PSScriptRoot '..' '..'
        foreach ($wf in 'pr.yml', 'coverage.yml') {
            $text = Get-Content (Join-Path $root '.github' 'workflows' $wf) -Raw
            $text | Should -Match 'CodeCoverage\.Path\s*=\s*Get-PesterCoverageTarget' -Because "$wf must call the shared definition"
            # The inline sweep both used to carry (the PSScriptAnalyzer step's own
            # Get-ChildItem of tools/powershell-sdk is a different list, for linting).
            $text | Should -Not -Match "Get-ChildItem\s+'tools/powershell-sdk'\s*,\s*'tools/riskscoring'" -Because "$wf must not enumerate the coverage files itself"
        }
    }
}

Describe 'ConvertTo-PesterShardRecord' {
    It 'keys commands by repo-relative position and keeps test counts' {
        $root = Join-Path $TestDrive 'r'
        $f = Join-Path $root 'tools' 'x.ps1'
        $result = [pscustomobject]@{
            TotalCount   = 5; FailedCount = 1
            CodeCoverage = [pscustomobject]@{
                CommandsExecuted = @(New-Cmd $f 3 1)
                CommandsMissed   = @((New-Cmd $f 9 5), (New-Cmd $f 1 2))
            }
        }
        $rec = ConvertTo-PesterShardRecord -Result $result -Root $root
        $rec.TotalCount | Should -Be 5
        $rec.FailedCount | Should -Be 1
        $rec.Executed | Should -Be @('tools/x.ps1:3:1-3:5')
        $rec.Analyzed | Should -Be @('tools/x.ps1:1:2-1:6', 'tools/x.ps1:3:1-3:5', 'tools/x.ps1:9:5-9:9')
    }

    It 'handles a shard that executed nothing' {
        $result = [pscustomobject]@{
            TotalCount = 0; FailedCount = 0
            CodeCoverage = [pscustomobject]@{ CommandsExecuted = @(); CommandsMissed = @(New-Cmd (Join-Path $TestDrive 'y.ps1') 1 1) }
        }
        $rec = ConvertTo-PesterShardRecord -Result $result -Root $TestDrive
        $rec.Executed.Count | Should -Be 0
        $rec.Analyzed | Should -Be @('y.ps1:1:1-1:5')
    }
}

Describe 'Merge-PesterShardRecord' {
    BeforeAll {
        $script:All = 'f:1', 'f:2', 'f:3', 'f:4', 'f:5'
        function script:Rec([string[]]$Executed, [int]$Total = 10, [int]$Failed = 0) {
            [pscustomobject]@{ TotalCount = $Total; FailedCount = $Failed; Analyzed = $All; Executed = $Executed }
        }
    }

    It 'counts a command covered when any shard executed it' {
        # Shard 1 hits 1,2; shard 2 hits 2,4 → union {1,2,4} = 3 of 5. Summing per-shard
        # hits would claim 4/5; taking the best shard would claim 2/5.
        $m = Merge-PesterShardRecord -Record @((Rec 'f:1', 'f:2'), (Rec 'f:2', 'f:4'))
        $m.Covered | Should -Be 3
        $m.Analyzed | Should -Be 5
        $m.Percent | Should -Be 60
    }

    It 'sums tests and failures across shards' {
        $m = Merge-PesterShardRecord -Record @((Rec @() 7 0), (Rec @() 4 2), (Rec @() 1 1))
        $m.Shards | Should -Be 3
        $m.Tests | Should -Be 12
        $m.Failed | Should -Be 3
    }

    It 'refuses shards that analyzed different commands' {
        $odd = [pscustomobject]@{ TotalCount = 1; FailedCount = 0; Analyzed = @('f:1', 'f:2'); Executed = @('f:1') }
        { Merge-PesterShardRecord -Record @((Rec 'f:1'), $odd) } | Should -Throw '*different command sets*'
    }

    It 'reports 0% rather than dividing by zero when nothing was analyzed' {
        $empty = [pscustomobject]@{ TotalCount = 0; FailedCount = 0; Analyzed = @(); Executed = @() }
        (Merge-PesterShardRecord -Record @($empty)).Percent | Should -Be 0
    }
}
