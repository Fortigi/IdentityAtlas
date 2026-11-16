#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The pure helpers behind the release test (tools/release/ReleaseTest.*.ps1).

.DESCRIPTION
    No Docker here: these are the decisions the release test makes — which
    release to upgrade from, which image tag a candidate has, when a row count
    is a regression, what the quickstart says to run. The Docker steps
    themselves are exercised by release-test.yml, which runs on every PR that
    changes these files.

.USAGE
    Invoke-Pester -Path test/unit/ReleaseTestFunctions.Tests.ps1 -Output Detailed
#>

BeforeDiscovery {
    . (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) tools/release/ReleaseTest.Docker.ps1)
}

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Docker.ps1')

    # Mixed on purpose: v6.10.0 sorts below v6.2.0 as text and above it as a
    # version; v6.1.2-beta.1 sits next to the stable it precedes.
    $script:Tags = @('v5.9.2', 'v6.0.3', 'v6.1.0', 'v6.1.1', 'v6.1.2-beta.1', 'v6.2.0-beta.1', 'v6.10.0', 'v6.0.0-rc.1')
}

Describe 'ConvertTo-ImageTag' {
    It 'adds .0 to a release, as docker-publish does' { ConvertTo-ImageTag 'v6.1.1' | Should -Be '6.1.1.0' }
    It 'keeps a pre-release version as it is' { ConvertTo-ImageTag 'v6.2.0-beta.1' | Should -Be '6.2.0-beta.1' }
    It 'passes edge through' { ConvertTo-ImageTag 'edge' | Should -Be 'edge' }
    It 'refuses <_>' -ForEach @('latest', 'beta', '6.1.1', 'v6.1', 'v6.1.1.0', 'v6.1.1-preview.1', 'main') {
        { ConvertTo-ImageTag $_ } | Should -Throw '*is not*'
    }
}

Describe 'Get-PreviousStableTag' {
    It 'is the stable release just below a hotfix beta' {
        Get-PreviousStableTag -Candidate 'v6.1.2-beta.1' -Tags $script:Tags | Should -Be 'v6.1.1'
    }
    It 'is the stable release just below a hotfix' {
        Get-PreviousStableTag -Candidate 'v6.1.2' -Tags $script:Tags | Should -Be 'v6.1.1'
    }
    It 'compares versions numerically, not as text' {
        Get-PreviousStableTag -Candidate 'v6.2.0-beta.1' -Tags $script:Tags | Should -Be 'v6.1.1'
        Get-PreviousStableTag -Candidate 'v6.11.0' -Tags $script:Tags | Should -Be 'v6.10.0'
    }
    It 'never picks a pre-release as the starting point' {
        Get-PreviousStableTag -Candidate 'v6.3.0' -Tags @('v6.1.1', 'v6.2.0-beta.1') | Should -Be 'v6.1.1'
    }
    It 'excludes the stable release of the same version as a pre-release' {
        Get-PreviousStableTag -Candidate 'v6.10.0-beta.2' -Tags $script:Tags | Should -Be 'v6.1.1'
    }
    It 'is the newest stable release for edge' {
        Get-PreviousStableTag -Candidate 'edge' -Tags $script:Tags | Should -Be 'v6.10.0'
    }
    It 'throws when there is nothing to upgrade from' {
        { Get-PreviousStableTag -Candidate 'v5.9.2' -Tags $script:Tags } | Should -Throw '*No stable release tag below*'
    }
}

Describe 'Get-ComposeRef / Get-ComposeUrl' {
    It 'takes the compose file of the tag itself' { Get-ComposeRef 'v6.1.2-beta.1' | Should -Be 'v6.1.2-beta.1' }
    It 'takes main for edge' { Get-ComposeRef 'edge' | Should -Be 'main' }
    It 'builds the raw URL the quickstart uses' {
        Get-ComposeUrl -Ref 'v6.1.1' | Should -Be 'https://raw.githubusercontent.com/Fortigi/IdentityAtlas/v6.1.1/docker-compose.prod.yml'
    }
}

Describe 'Compare-RowCount' {
    BeforeAll {
        $script:Before = @{ Principals = 120; ResourceAssignments = 900; Contexts = 14; ContextMembers = 300 }
    }
    It 'finds nothing when every count is the same' {
        Compare-RowCount -Before $script:Before -After $script:Before.Clone() | Should -BeNullOrEmpty
    }
    It 'reports a synced table that lost one row' {
        $after = $script:Before.Clone(); $after.ResourceAssignments = 899
        Compare-RowCount -Before $script:Before -After $after | Should -Be @('ResourceAssignments changed from 900 to 899 rows')
    }
    It 'reports a synced table that GAINED one row (a duplicating migration)' {
        $after = $script:Before.Clone(); $after.Principals = 121
        Compare-RowCount -Before $script:Before -After $after | Should -Be @('Principals changed from 120 to 121 rows')
    }
    It 'lets generated contexts grow' {
        $after = $script:Before.Clone(); $after.Contexts = 20; $after.ContextMembers = 450
        Compare-RowCount -Before $script:Before -After $after | Should -BeNullOrEmpty
    }
    It 'reports generated contexts that shrank' {
        $after = $script:Before.Clone(); $after.ContextMembers = 299
        Compare-RowCount -Before $script:Before -After $after | Should -Be @('ContextMembers shrank from 300 to 299 rows')
    }
    It 'reports a table that disappeared' {
        $after = $script:Before.Clone(); $after.Remove('Contexts')
        Compare-RowCount -Before $script:Before -After $after | Should -Be @('Contexts is gone (had 14 rows)')
    }
    It 'ignores a table that is new in the candidate' {
        $after = $script:Before.Clone(); $after.Identities = 5
        Compare-RowCount -Before $script:Before -After $after | Should -BeNullOrEmpty
    }
    It 'reports every problem, not just the first' {
        $after = @{ Principals = 1; ResourceAssignments = 900; ContextMembers = 300 }
        (Compare-RowCount -Before $script:Before -After $after).Count | Should -Be 2
    }
    It 'refuses to compare against nothing' {
        Compare-RowCount -Before @{} -After @{ Principals = 1 } | Should -Be @('no row counts were taken before the change')
    }
}

Describe 'Assert-DataLoaded' {
    It 'passes with principals, resources and assignments' {
        { Assert-DataLoaded @{ Principals = 1; Resources = 1; ResourceAssignments = 1; Systems = 0 } } | Should -Not -Throw
    }
    It 'names the empty table' {
        { Assert-DataLoaded @{ Principals = 3; Resources = 0; ResourceAssignments = 2 } } | Should -Throw '*Resources*'
    }
    It 'treats a missing table as empty' {
        { Assert-DataLoaded @{ Principals = 3; Resources = 2 } } | Should -Throw '*ResourceAssignments*'
    }
}

Describe 'Wait-Until' {
    It 'returns the first truthy value' {
        $script:n = 0
        Wait-Until -Description 'x' -TimeoutSec 5 -IntervalSec 0 -Condition { $script:n++; if ($script:n -ge 3) { "done-$script:n" } } |
            Should -Be 'done-3'
    }
    It 'treats an exception as not yet' {
        $script:n = 0
        Wait-Until -Description 'x' -TimeoutSec 5 -IntervalSec 0 -Condition { $script:n++; if ($script:n -lt 2) { throw 'refused' }; 'up' } |
            Should -Be 'up'
    }
    It 'throws with the description when time runs out' {
        { Wait-Until -Description 'the thing' -TimeoutSec 1 -IntervalSec 0 -Condition { $false } } | Should -Throw '*waiting for the thing*'
    }
}

Describe 'Invoke-DemoLoad' {
    It 'waits for the job to complete' {
        $script:polls = 0
        Mock Invoke-Api { [pscustomobject]@{ id = 42 } } -ParameterFilter { $Method -eq 'Post' }
        Mock Invoke-Api { $script:polls++; [pscustomobject]@{ status = $(if ($script:polls -lt 2) { 'running' } else { 'completed' }) } } -ParameterFilter { $Path -eq '/admin/crawler-jobs/42' }
        Mock Start-Sleep {}
        { Invoke-DemoLoad -BaseUrl 'http://x/api' -TimeoutSec 30 } | Should -Not -Throw
        $script:polls | Should -Be 2
        Should -Invoke Invoke-Api -ParameterFilter { $Method -eq 'Post' -and $Body.jobType -eq 'demo' } -Times 1 -Exactly
    }
    It 'throws when the job fails' {
        Mock Invoke-Api { [pscustomobject]@{ id = 7 } } -ParameterFilter { $Method -eq 'Post' }
        Mock Invoke-Api { [pscustomobject]@{ status = 'failed' } } -ParameterFilter { $Path -eq '/admin/crawler-jobs/7' }
        { Invoke-DemoLoad -BaseUrl 'http://x/api' -TimeoutSec 30 } | Should -Throw "*ended 'failed'*"
    }
    It 'throws when no job was queued' {
        Mock Invoke-Api { [pscustomobject]@{ error = 'nope' } } -ParameterFilter { $Method -eq 'Post' }
        { Invoke-DemoLoad -BaseUrl 'http://x/api' } | Should -Throw '*not queued*'
    }
}

Describe 'Invoke-SmokeTest' {
    It 'returns only the endpoints that did not answer 200' {
        Mock Get-HttpStatus { if ($Url -like '*/tags') { 500 } elseif ($Url -like '*/sync-log') { 0 } else { 200 } }
        Invoke-SmokeTest -BaseUrl 'http://x/api' | Should -Be @('/sync-log -> 0', '/tags -> 500')
    }
    It 'passes the token to every request' {
        Mock Get-HttpStatus { 200 }
        Invoke-SmokeTest -BaseUrl 'http://x/api' -Token 'abc' | Should -BeNullOrEmpty
        Should -Invoke Get-HttpStatus -ParameterFilter { $Token -ne 'abc' } -Times 0 -Exactly
    }
}

Describe 'Get-IngestProbe' {
    BeforeAll { $script:Calls = Get-IngestProbe -SystemId 'sys-1' }
    It 'creates principal and resource before the assignment that links them' {
        $script:Calls.Path | Should -Be @('/ingest/principals', '/ingest/resources', '/ingest/resource-assignments')
    }
    It 'links the assignment to the principal and resource it just created' {
        $a = $script:Calls[2].Body.records[0]
        $a.principalExternalId | Should -Be $script:Calls[0].Body.records[0].externalId
        $a.resourceExternalId | Should -Be $script:Calls[1].Body.records[0].externalId
        $a.assignmentType | Should -Be 'Direct'
    }
    It 'sends every call to the same system, as a delta' {
        $script:Calls.Body | ForEach-Object { $_.systemId | Should -Be 'sys-1'; $_.syncMode | Should -Be 'delta' }
    }
}

Describe 'Test-ReportGeneratorAnswer' {
    It 'accepts <_>' -ForEach @('report', 'clarify', 'confirm') { Test-ReportGeneratorAnswer ([pscustomobject]@{ kind = $_ }) | Should -BeTrue }
    It 'rejects <_>' -ForEach @('error', 'decline', '') { Test-ReportGeneratorAnswer ([pscustomobject]@{ kind = $_ }) | Should -BeFalse }
    It 'rejects no reply' { Test-ReportGeneratorAnswer $null | Should -BeFalse }
}

Describe 'The fresh-install script follows the quickstart' {
    BeforeAll { $script:Quickstart = Get-Content (Join-Path $script:Root 'docs/quickstart.md') -Raw }

    It 'quickstart still contains "<_>"' -ForEach @(Get-QuickstartLine) {
        $script:Quickstart | Should -BeLike "*$_*"
    }
    It 'quickstart still documents the IMAGE_TAG= prefix as the way to pick a channel' {
        $script:Quickstart | Should -BeLike '*IMAGE_TAG=beta docker compose -f docker-compose.prod.yml up -d --pull always*'
    }
    It 'fetches the compose file of the candidate, not of main' {
        $s = Get-QuickstartScript -Ref 'v6.1.2-beta.1' -ImageTag '6.1.2-beta.1'
        $s | Should -BeLike '*IdentityAtlas/v6.1.2-beta.1/docker-compose.prod.yml*'
        $s | Should -Not -BeLike '*/main/*'
    }
    It 'starts the candidate image with the documented IMAGE_TAG prefix' {
        (Get-QuickstartScript -Ref main -ImageTag edge) -split "`n" | Should -Contain 'IMAGE_TAG=edge docker compose -f docker-compose.prod.yml up -d --pull always'
    }
    It 'adds the report-generator lines after .env exists and before the start' {
        $lines = (Get-QuickstartScript -Ref main -ImageTag edge -ReportGenerator) -split "`n"
        $env = [array]::IndexOf($lines, (Get-QuickstartLine)[1])
        $up = [array]::FindIndex($lines, [Predicate[string]] { param($l) $l -like 'IMAGE_TAG=*' })
        $rg = [array]::IndexOf($lines, 'echo "COMPOSE_PROFILES=report-generator" >> .env')
        $env | Should -BeLessThan $rg
        $rg | Should -BeLessThan $up
        $lines | Should -Contain 'echo "FEATURE_CUSTOM_REPORTS=true" >> .env'
    }
    It 'adds no report-generator lines without -ReportGenerator' {
        Get-QuickstartScript -Ref main -ImageTag edge | Should -Not -BeLike '*COMPOSE_PROFILES*'
    }
    It 'uses the settings the report-generator page documents' {
        $doc = Get-Content (Join-Path $script:Root 'docs/reference/report-generator.md') -Raw
        $doc | Should -BeLike '*COMPOSE_PROFILES=report-generator*'
        $doc | Should -BeLike '*FEATURE_CUSTOM_REPORTS=true*'
    }
}

Describe 'Set-EnvValue / Get-EnvValue' {
    BeforeEach {
        $script:Env = Join-Path $TestDrive '.env'
        Set-Content $script:Env @('POSTGRES_PASSWORD=abc', 'IMAGE_TAG=6.1.1.0', 'IMAGE_TAG_X=keep') -Encoding ascii
    }
    It 'replaces an existing value' {
        Set-EnvValue -Path $script:Env -Name IMAGE_TAG -Value edge
        Get-EnvValue -Path $script:Env -Name IMAGE_TAG | Should -Be 'edge'
        @(Get-Content $script:Env | Where-Object { $_ -like 'IMAGE_TAG=*' }).Count | Should -Be 1
    }
    It 'leaves a variable with a longer name alone' {
        Set-EnvValue -Path $script:Env -Name IMAGE_TAG -Value edge
        Get-EnvValue -Path $script:Env -Name IMAGE_TAG_X | Should -Be 'keep'
    }
    It 'appends a new value and keeps the rest' {
        Set-EnvValue -Path $script:Env -Name IDENTITY_ATLAS_MASTER_KEY -Value 'k=='
        Get-EnvValue -Path $script:Env -Name IDENTITY_ATLAS_MASTER_KEY | Should -Be 'k=='
        Get-EnvValue -Path $script:Env -Name POSTGRES_PASSWORD | Should -Be 'abc'
    }
    It 'creates the file when there is none' {
        $new = Join-Path $TestDrive 'new.env'
        Set-EnvValue -Path $new -Name A -Value 1
        Get-Content $new | Should -Be @('A=1')
    }
    It 'returns $null for an unset name' { Get-EnvValue -Path $script:Env -Name NOPE | Should -BeNullOrEmpty }
}

Describe 'Row-count query and parsing' {
    It 'quotes every table name (they are mixed case)' {
        Get-RowCountQuery -Table 'Principals', 'Resources' |
            Should -Be "SELECT 'Principals', count(*) FROM `"Principals`" UNION ALL SELECT 'Resources', count(*) FROM `"Resources`""
    }
    It 'parses psql -tA output and skips anything else' {
        $c = ConvertFrom-PsqlCount -Rows @('Principals|120', '', 'NOTICE: x', 'Contexts|0')
        $c.Count | Should -Be 2
        $c.Principals | Should -Be 120
        $c.Contexts | Should -Be 0
    }
    It 'counts the synced and the generated tables' {
        Get-CoreTable | Should -Contain 'ResourceAssignments'
        Get-CoreTable | Should -Contain 'ContextMembers'
    }
}

Describe 'Get-MissingService' {
    BeforeAll {
        $script:Ok = @{ postgres = @{ State = 'running'; Health = 'healthy' }; web = @{ State = 'running'; Health = '' }; worker = @{ State = 'running'; Health = '' } }
    }
    It 'finds nothing when all run and postgres is healthy' {
        Get-MissingService -Services $script:Ok -Expected postgres, web, worker | Should -BeNullOrEmpty
    }
    It 'reports a service that is not there' {
        Get-MissingService -Services $script:Ok -Expected postgres, web, worker, report-generator | Should -Be @('report-generator (not running)')
    }
    It 'reports a postgres that runs but is not healthy' {
        $s = $script:Ok.Clone(); $s.postgres = @{ State = 'running'; Health = 'starting' }
        Get-MissingService -Services $s -Expected postgres, web | Should -Be @('postgres (starting)')
    }
    It 'reports an exited worker' {
        $s = $script:Ok.Clone(); $s.worker = @{ State = 'exited'; Health = '' }
        Get-MissingService -Services $s -Expected worker | Should -Be @('worker (not running)')
    }
}

Describe 'Assert-RunningVersion' {
    It 'passes when the app runs the candidate' {
        Mock Invoke-Api { [pscustomobject]@{ version = '6.1.2-beta.1'; composeFileOutdated = $false } }
        { Assert-RunningVersion -BaseUrl 'http://x/api' -ImageTag '6.1.2-beta.1' } | Should -Not -Throw
    }
    It 'fails when the old version is still running' {
        Mock Invoke-Api { [pscustomobject]@{ version = '6.1.1.0'; composeFileOutdated = $false } }
        { Assert-RunningVersion -BaseUrl 'http://x/api' -ImageTag '6.1.2-beta.1' } | Should -Throw '*reports ''6.1.1.0''*'
    }
    It 'skips the version for edge, which has no fixed number' {
        Mock Invoke-Api { [pscustomobject]@{ version = '6.91.20261116.1835'; composeFileOutdated = $false } }
        { Assert-RunningVersion -BaseUrl 'http://x/api' -ImageTag 'edge' } | Should -Not -Throw
    }
    It 'fails when the compose file is outdated' {
        Mock Invoke-Api { [pscustomobject]@{ version = 'edge'; composeFileOutdated = $true; composeFileVersion = 4 } }
        { Assert-RunningVersion -BaseUrl 'http://x/api' -ImageTag 'edge' } | Should -Throw '*outdated*'
    }
}

Describe 'Invoke-Compose' {
    It 'runs docker compose on the prod compose file under a hard timeout' {
        Get-ComposeCommand -Arguments 'up', '-d' -TimeoutSec 900 | Should -Be @('timeout', '900', 'docker', 'compose', '-f', 'docker-compose.prod.yml', 'up', '-d')
    }
    It 'uses a timeout by default, so a hung call cannot eat the job' {
        (Get-ComposeCommand -Arguments 'ps')[0..1] | Should -Be @('timeout', '900')
    }
}
