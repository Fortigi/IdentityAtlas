<#
.SYNOPSIS
    Dot-source every file the SQL Database crawler is made of, in dependency
    order — the one place that list lives.

.DESCRIPTION
    Dot-sourcing does not create a scope, so `. SqlCrawler.Load.ps1` from a
    caller puts every function below into the CALLER's scope, exactly as
    listing them one by one did.

    The list used to be repeated in the entry point, the integration test and
    each unit-test file, which meant adding one file to the crawler was an edit
    in seven places — and forgetting one showed up as "The term
    'New-SqlSystemCatalog' is not recognized", far from its cause.

    Order matters: Transform defines the column contract the rest read, Ownership
    the owner resolver Contexts and Phases share, Systems and Contexts the
    catalogues Phases fills, and Verify reads the run state Phases creates.

    A caller that wants only part of the crawler (the transform tests shape rows
    with no ingest at all) still dot-sources what it needs directly — this is
    the whole-crawler list, not a rule that everything must load everything.
#>

$script:SqlCrawlerDir = $PSScriptRoot
$script:SqlSharedDir  = Join-Path (Split-Path $PSScriptRoot -Parent) 'shared'

foreach ($f in @(
    (Join-Path $script:SqlSharedDir 'Invoke-CrawlerIngest.ps1')
    (Join-Path $script:SqlSharedDir 'Invoke-CrawlerIngestStream.ps1')
    (Join-Path $script:SqlSharedDir 'Get-CrawlerSystemName.ps1')
    (Join-Path $script:SqlCrawlerDir 'SqlCrawler.Functions.ps1')
    (Join-Path $script:SqlCrawlerDir 'SqlCrawler.Transform.ps1')
    (Join-Path $script:SqlCrawlerDir 'SqlCrawler.Ownership.ps1')
    (Join-Path $script:SqlCrawlerDir 'SqlCrawler.Systems.ps1')
    (Join-Path $script:SqlCrawlerDir 'SqlCrawler.Contexts.ps1')
    (Join-Path $script:SqlCrawlerDir 'SqlCrawler.Phases.ps1')
    (Join-Path $script:SqlCrawlerDir 'SqlCrawler.Verify.ps1')
)) { . $f }
