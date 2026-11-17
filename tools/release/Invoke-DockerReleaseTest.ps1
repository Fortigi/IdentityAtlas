<#
.SYNOPSIS
    One Docker scenario of the release test.

.DESCRIPTION
    -Scenario Upgrade
        Starts the previous stable release with its own docker-compose.prod.yml,
        loads the demo data and pushes one record of each kind through the
        ingest API, backs up as the docs describe, switches to the candidate,
        and checks that the migrations finish, the read endpoints answer and the
        core row counts are unchanged. Then restores that backup onto an empty
        host running the candidate and checks the same again.

    -Scenario Fresh
        Follows docs/quickstart.md line for line with the candidate's tag and
        checks the result the way the quickstart's "Verifying the deployment"
        section does, then loads the demo data.

    -Scenario SignIn
        The fresh install again, with sign-in switched on in .env as
        docs/admin/authentication.md describes, then the F-01 checks from
        ReleaseTest.SignIn.ps1 with real Entra ID tokens: a caller with a role
        gets in, a caller without one is refused. Needs the GitHub OIDC token
        (id-token: write) and the -SsoTenantId/-SsoClientId/-*CallerId values.

    -ReportGenerator adds the report-generator profile (the local model) to
    the Upgrade or Fresh scenario and asks it one question at the end.

    Deviation from the docs: `docker compose exec` gets -T, because a CI runner
    has no terminal. Nothing else is changed.

.EXAMPLE
    pwsh tools/release/Invoke-DockerReleaseTest.ps1 -Scenario Upgrade -Candidate v6.2.0-beta.1 -PreviousStable v6.1.1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Upgrade', 'Fresh', 'SignIn')][string] $Scenario,
    [Parameter(Mandatory)][string] $Candidate,
    [string] $PreviousStable = '',
    [switch] $ReportGenerator,
    [string] $WorkDir = (Join-Path ([IO.Path]::GetTempPath()) "ia-reltest-$PID"),
    [string] $BaseUrl = 'http://localhost:3001/api',
    [string] $SsoTenantId = '',
    [string] $SsoClientId = '',
    [string] $RoleCallerId = '',
    [string] $NoRoleCallerId = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseTest.Functions.ps1')
. (Join-Path $PSScriptRoot 'ReleaseTest.Docker.ps1')
. (Join-Path $PSScriptRoot 'ReleaseTest.SignIn.ps1')

$imageTag = ConvertTo-ImageTag $Candidate
# Resolved here, in the checkout: the scenario itself runs in $WorkDir, which is no git repository.
$from = if ($Scenario -eq 'Upgrade' -and -not $PreviousStable) { Get-PreviousStableTag -Candidate $Candidate -Tags @(git tag --list 'v*') } else { $PreviousStable }
$expected = @('postgres', 'web', 'worker') + @(if ($ReportGenerator) { 'report-generator' })

function Assert-Healthy([string] $Label) {
    Wait-SchemaReady -BaseUrl $BaseUrl -TimeoutSec 900
    $missing = @(Get-MissingService -Services (Get-ComposeService) -Expected $expected)
    if ($missing.Count -gt 0) { throw "${Label}: not running: $($missing -join ', ')" }
    $failed = @(Invoke-SmokeTest -BaseUrl $BaseUrl)
    if ($failed.Count -gt 0) { throw "${Label}: read endpoints failed: $($failed -join '; ')" }
}

function Assert-SameRows([hashtable] $Before, [string] $Label) {
    $after = Get-DbRowCount
    Write-Step "$Label row counts: $(($after.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' ')"
    $problems = @(Compare-RowCount -Before $Before -After $after)
    if ($problems.Count -gt 0) { throw "${Label}: $($problems -join '; ')" }
}

function Invoke-UpgradeScenario {
    Write-Step "Upgrade $from -> $Candidate (image $imageTag)$(if ($ReportGenerator) { ' with the report generator' })"

    Get-ComposeFile -Ref $from
    New-EnvFile -ImageTag (ConvertTo-ImageTag $from) -ReportGenerator:$ReportGenerator
    Invoke-Compose up -d --pull always | Out-Null
    Wait-SchemaReady -BaseUrl $BaseUrl
    Write-Step "$from is up; loading the demo data"
    Invoke-DemoLoad -BaseUrl $BaseUrl
    Write-Step 'Demo data loaded; pushing records through the ingest API'
    Invoke-IngestProbe -BaseUrl $BaseUrl -ApiKey (Get-WorkerKey)
    $before = Get-DbRowCount
    Assert-DataLoaded $before
    Write-Step "Before row counts: $(($before.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' ')"

    $masterKey = Backup-Deployment -BackupDir (Join-Path $WorkDir 'backup')

    Write-Step "Switching to $Candidate"
    Get-ComposeFile -Ref (Get-ComposeRef $Candidate)
    Set-EnvValue -Path .env -Name IMAGE_TAG -Value $imageTag
    Invoke-Compose up -d --pull always | Out-Null
    Assert-Healthy 'After the upgrade'
    Assert-RunningVersion -BaseUrl $BaseUrl -ImageTag $imageTag
    Assert-SameRows $before 'After the upgrade'
    if ($ReportGenerator) { Assert-ReportGenerator -BaseUrl $BaseUrl }

    Write-Step 'Restoring the pre-upgrade backup onto an empty host'
    Restore-Deployment -MasterKey $masterKey
    Assert-Healthy 'After the restore'
    Assert-SameRows $before 'After the restore'
    Assert-NoMissingKeyLog
}

function Invoke-FreshScenario {
    Write-Step "Fresh install of $Candidate (image $imageTag)$(if ($ReportGenerator) { ' with the report generator' })"
    $script = Get-QuickstartScript -Ref (Get-ComposeRef $Candidate) -ImageTag $imageTag -ReportGenerator:$ReportGenerator
    Write-Host $script
    $script | bash
    if ($LASTEXITCODE -ne 0) { throw 'The quickstart commands failed.' }
    Assert-Healthy 'After the fresh install'
    Assert-RunningVersion -BaseUrl $BaseUrl -ImageTag $imageTag
    $status = Invoke-Api -BaseUrl $BaseUrl -Path '/admin/status'
    if (Get-Prop $status 'hasData') { throw 'A fresh install reports data before any was loaded.' }
    if ((Get-HttpStatus -Url ($BaseUrl -replace '/api$', '/')) -ne 200) { throw 'The UI does not answer on /.' }
    Invoke-DemoLoad -BaseUrl $BaseUrl
    Assert-DataLoaded (Get-DbRowCount)
    if ($ReportGenerator) { Assert-ReportGenerator -BaseUrl $BaseUrl }
}

function Invoke-SignInScenario {
    foreach ($name in 'SsoTenantId', 'SsoClientId', 'RoleCallerId', 'NoRoleCallerId') {
        if (-not (Get-Variable $name -ValueOnly)) { throw "-$name is required for the SignIn scenario." }
    }
    Write-Step "Fresh install of $Candidate with sign-in on"
    $auth = [ordered]@{ AUTH_ENABLED = 'true'; AUTH_TENANT_ID = $SsoTenantId; AUTH_CLIENT_ID = $SsoClientId }
    $script = Get-QuickstartScript -Ref (Get-ComposeRef $Candidate) -ImageTag $imageTag -ExtraEnv $auth
    $script | bash
    if ($LASTEXITCODE -ne 0) { throw 'The quickstart commands failed.' }
    Wait-SchemaReady -BaseUrl $BaseUrl -TimeoutSec 900
    Assert-RunningVersion -BaseUrl $BaseUrl -ImageTag $imageTag
    Assert-AuthConfig -BaseUrl $BaseUrl -SsoClientId $SsoClientId
    $tokens = Get-SignInToken -TenantId $SsoTenantId -SsoClientId $SsoClientId -RoleCallerId $RoleCallerId -NoRoleCallerId $NoRoleCallerId
    $problems = @(Invoke-SignInCheck -BaseUrl $BaseUrl -Tokens $tokens)
    if ($problems.Count -gt 0) { throw "Sign-in checks failed: $($problems -join '; ')" }
    Write-Step "All $(@(Get-SignInExpectation).Count) sign-in checks passed"
}

New-Item -ItemType Directory -Force $WorkDir | Out-Null
Push-Location $WorkDir
try {
    switch ($Scenario) {
        'Upgrade' { Invoke-UpgradeScenario }
        'Fresh' { Invoke-FreshScenario }
        'SignIn' { Invoke-SignInScenario }
    }
    Write-Step "$Scenario passed for $Candidate"
} catch {
    Write-Host "::error::$Scenario failed for ${Candidate}: $_"
    Write-Diagnostic
    exit 1
} finally {
    Pop-Location
}
