<#
.SYNOPSIS
    The steps of one Azure variant of the release test, in the order an
    operator takes them. Dot-source after ReleaseTest.Functions.ps1,
    ReleaseTest.Docker.ps1, ReleaseTest.SignIn.ps1, ReleaseTest.CuratedData.ps1
    and ReleaseTest.Azure.ps1.

.DESCRIPTION
    An Azure install is never open. main.json (Step 1) switches sign-in on
    from the first deploy, with no tenant or client yet
    (azure/modules/app-service.bicep): until main-auth.json (Step 2) fills
    those in, /auth-config says enabled and not configured, the SPA shows
    "set up Entra" and every data endpoint answers 401. That is the product
    working, so:

      main, main-rg, main-upgrade   Step 1 only. The locked state is what is
                                    checked, fresh and across the upgrade.
      auth, auth-rg, auth-upgrade   Step 1 (locked), then Step 2, the sign-in
                                    checks, and the demo data loaded and read
                                    by the Admin caller: loading needs Admin,
                                    and nobody gets in without signing in.

    main-auth.json changes app settings only. The image stays the same, so
    after it the old container keeps answering with the same version and
    schemaReady until the platform restarts it, and the app reads AUTH_* at
    startup (app/api/src/config/authConfig.js). Wait-SignIn waits for
    /auth-config to name the SSO client, which only the restarted container
    does.

    Everything takes the run's context (New-AzureRunContext) instead of
    script variables, so test/unit/ReleaseTestAzureFlow.Tests.ps1 can run a
    whole variant with Invoke-Az and HTTP mocked.
#>

Set-StrictMode -Version Latest

# Answer without sign-in on purpose: the SPA reads them before anyone signs in.
$script:PublicEndpoints = @('/version', '/features', '/auth-config', '/openapi.json')

# Parameter -> the azure-release-test environment variable it comes from.
$script:SignInSetting = [ordered]@{
    TenantId       = 'AZURE_TENANT_ID'
    SsoClientId    = 'RELEASE_TEST_SSO_CLIENT_ID'
    RoleCallerId   = 'AZURE_CLIENT_ID'
    NoRoleCallerId = 'RELEASE_TEST_NOROLE_CLIENT_ID'
    AdminCallerId  = 'RELEASE_TEST_ADMIN_CLIENT_ID'
}

function New-AzureRunContext {
    <#
    .SYNOPSIS
        The run's parameters in one hashtable. Throws before anything is
        deployed when a sign-in variant lacks one of its IDs.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string] $Variant,
        [Parameter(Mandatory)][string] $Candidate,
        [Parameter(Mandatory)][string] $PreviousStable,
        [Parameter(Mandatory)][string] $Group,
        [string] $TenantId = '',
        [string] $SsoClientId = '',
        [string] $RoleCallerId = '',
        [string] $NoRoleCallerId = '',
        [string] $AdminCallerId = '',
        [string] $WorkDir = '',
        [string] $RepoAzure = ''
    )
    Assert-ReleaseTestGroupName $Group
    $v = Get-AzureVariant $Variant
    if ($v.SignIn) {
        $missing = @($script:SignInSetting.Keys | Where-Object { -not $PSBoundParameters[$_] } | ForEach-Object { "-$_ ($($script:SignInSetting[$_]))" })
        if ($missing.Count -gt 0) {
            throw "Variant $Variant needs $($missing -join ', '). Set the variable(s) on the azure-release-test environment: docs/contributing/release-process.md, One-time setup, sections 3 and 4."
        }
    }
    @{
        Variant = $Variant; V = $v; Candidate = $Candidate; PreviousStable = $PreviousStable; Group = $Group
        TenantId = $TenantId; SsoClientId = $SsoClientId; RoleCallerId = $RoleCallerId
        NoRoleCallerId = $NoRoleCallerId; AdminCallerId = $AdminCallerId
        WorkDir = $WorkDir; RepoAzure = $RepoAzure; TemplateDirs = @{}
    }
}

function Get-AzureLockedEndpoint {
    <# The smoke endpoints that hold data: every one but the public bootstrap ones. #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()
    @(Get-SmokeEndpoint | Where-Object { $_ -notin $script:PublicEndpoints })
}

function Get-LockedDownProblem {
    <#
    .SYNOPSIS
        What is wrong with a deployment that should be locked (Step 1 only):
        sign-in must be on and not configured, and every data endpoint 401.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([AllowNull()] $AuthConfig, [Parameter(Mandatory)][System.Collections.IDictionary] $Status)
    $problems = @(
        if ((Get-Prop $AuthConfig 'enabled') -ne $true) { "sign-in is not on: $($AuthConfig | ConvertTo-Json -Compress)" }
        if ([bool](Get-Prop $AuthConfig 'configured')) { "sign-in is already configured (client '$(Get-Prop $AuthConfig 'clientId')') before Step 2" }
        foreach ($path in $Status.Keys) {
            if ($Status[$path] -ne 401) { "$path answered $($Status[$path]) without a token, expected 401" }
        }
    )
    $problems
}

function Assert-LockedDown {
    <# Throws unless the app at $BaseUrl is in the locked Step-1 state. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][string] $Label)
    $config = Invoke-Api -BaseUrl $BaseUrl -Path '/auth-config'
    $status = [ordered]@{}
    foreach ($ep in Get-AzureLockedEndpoint) { $status[$ep] = Get-HttpStatus -Url "$BaseUrl$ep" }
    $problems = @(Get-LockedDownProblem -AuthConfig $config -Status $status)
    if ($problems.Count -gt 0) { throw "${Label}: the app is not locked: $($problems -join '; ')" }
    Write-Step "${Label}: locked (sign-in on, not configured, $($status.Count) data endpoints answer 401)"
}

function Wait-SignIn {
    <#
    .SYNOPSIS
        After main-auth.json: waits until the app says sign-in is configured
        for the SSO client, then for schemaReady. See the file header for why
        the version is no use here.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][string] $SsoClientId, [int] $TimeoutSec = 900)
    Wait-Until -Description "$BaseUrl to restart configured for client $SsoClientId" -TimeoutSec $TimeoutSec -IntervalSec 15 -Condition {
        Assert-AuthConfig -BaseUrl $BaseUrl -SsoClientId $SsoClientId; $true
    } | Out-Null
    Wait-SchemaReady -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
}

function Wait-Release {
    <#
    .SYNOPSIS
        After main.json: waits for the redeployed container, then schemaReady.
    .DESCRIPTION
        Until the restart the old container still answers, so the version
        comes first and a schemaReady from the old one does not count. A
        channel tag (edge) names no version, so on an upgrade it waits for the
        version to differ from the release it replaces instead.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][string] $Ref, [string] $Replacing = '', [int] $TimeoutSec = 1200)
    $tag = ConvertTo-ImageTag $Ref
    $old = if ($Replacing) { ConvertTo-ImageTag $Replacing } else { '' }
    Wait-Until -Description "$BaseUrl to run $tag" -TimeoutSec $TimeoutSec -IntervalSec 15 -Condition {
        Assert-RunningVersion -BaseUrl $BaseUrl -ImageTag $tag
        (-not $old) -or ((Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Path '/version') 'version') -ne $old)
    } | Out-Null
    Wait-SchemaReady -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
}

function Get-AzureTemplateDir {
    <# azure/ of this checkout for edge (no package), else the release's own package. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable] $Ctx, [Parameter(Mandatory)][string] $Ref)
    if ($Ref -eq 'edge') { return $Ctx.RepoAzure }
    if (-not $Ctx.TemplateDirs.ContainsKey($Ref)) {
        $dir = Join-Path $Ctx.WorkDir $Ref
        & gh release download $Ref --pattern 'IdentityAtlas-azure-*.zip' --dir $dir --clobber
        if ($LASTEXITCODE -ne 0) { throw "Release $Ref has no Azure template package." }
        Expand-Archive -Path (Get-ChildItem $dir -Filter '*.zip' | Select-Object -First 1).FullName -DestinationPath $dir -Force
        $Ctx.TemplateDirs[$Ref] = Join-Path $dir 'azure'
    }
    $Ctx.TemplateDirs[$Ref]
}

function Invoke-MainDeployment {
    <# Step 1: main.json of $Ref. Returns the API URL. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable] $Ctx, [Parameter(Mandatory)][string] $Ref, [Parameter(Mandatory)][string] $Step)
    $params = Get-DeploymentParameter -ImageTag (ConvertTo-ImageTag $Ref) -ReportGenerator:$Ctx.V.ReportGenerator
    Write-Step "$Step`: main.json of $Ref"
    $outputs = Invoke-ReleaseTestDeployment -Group $Ctx.Group -TemplateFile (Join-Path (Get-AzureTemplateDir $Ctx $Ref) 'main.json') -ParametersJson $params -Name "$Step-main"
    Get-AppApiUrl $outputs
}

function Invoke-SignInDeployment {
    <# Step 2: main-auth.json of $Ref with the SSO app. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable] $Ctx, [Parameter(Mandatory)][string] $Ref, [Parameter(Mandatory)][string] $Step)
    Write-Step "$Step`: main-auth.json of $Ref"
    $auth = @{ parameters = @{ entraTenantId = @{ value = $Ctx.TenantId }; entraClientId = @{ value = $Ctx.SsoClientId } } } | ConvertTo-Json -Depth 4
    Invoke-ReleaseTestDeployment -Group $Ctx.Group -TemplateFile (Join-Path (Get-AzureTemplateDir $Ctx $Ref) 'main-auth.json') -ParametersJson $auth -Name "$Step-auth" | Out-Null
}

function Install-AzureRelease {
    <#
    .SYNOPSIS
        Step 1, checked locked, and for a sign-in variant Step 2 and the wait
        for it. Returns the API URL.
    .DESCRIPTION
        main.json replaces the app settings, so every main.json, an upgrade's
        too, leaves the app locked until main-auth.json runs again
        (azure/main-auth.bicep, header). The lock is checked every time: an
        upgrade must never leave the app open.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable] $Ctx, [Parameter(Mandatory)][string] $Ref, [Parameter(Mandatory)][string] $Step, [string] $Replacing = '')
    $api = Invoke-MainDeployment -Ctx $Ctx -Ref $Ref -Step $Step
    Wait-Release -BaseUrl $api -Ref $Ref -Replacing $Replacing
    Assert-LockedDown -BaseUrl $api -Label "$Step, after main.json"
    if ($Ctx.V.SignIn) {
        Invoke-SignInDeployment -Ctx $Ctx -Ref $Ref -Step $Step
        Wait-SignIn -BaseUrl $api -SsoClientId $Ctx.SsoClientId
    }
    $api
}

function Get-AzureToken {
    <# Fresh tokens for every caller, the Admin one included (each lasts about an hour). #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][hashtable] $Ctx)
    Get-SignInToken -TenantId $Ctx.TenantId -SsoClientId $Ctx.SsoClientId -RoleCallerId $Ctx.RoleCallerId -NoRoleCallerId $Ctx.NoRoleCallerId -AdminCallerId $Ctx.AdminCallerId
}

function Assert-AzureSignIn {
    <# The sign-in checks against a configured deployment. Returns the tokens. #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][hashtable] $Ctx, [Parameter(Mandatory)][string] $BaseUrl)
    Assert-AuthConfig -BaseUrl $BaseUrl -SsoClientId $Ctx.SsoClientId
    $tokens = Get-AzureToken $Ctx
    $problems = @(Invoke-SignInCheck -BaseUrl $BaseUrl -Tokens $tokens)
    if ($problems.Count -gt 0) { throw "Sign-in checks failed: $($problems -join '; ')" }
    $tokens
}

function Assert-ReportGeneratorDeployed {
    <#
    .SYNOPSIS
        The report-generator Container App exists and provisioned.
    .DESCRIPTION
        Only its presence and state: asking the model a question needs a role
        with data.read.reports, and a cold start of the scale-to-zero app is
        not what is tested here.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable] $Ctx)
    Assert-ReleaseTestGroupName $Ctx.Group
    $apps = @(Invoke-Az containerapp list --resource-group $Ctx.Group)
    $rg = $apps | Where-Object { (Get-Prop $_ 'name') -like '*-report-generator' }
    if (-not $rg) { throw 'deployReportGenerator=true, but no report-generator Container App was deployed.' }
    $state = Get-Prop (Get-Prop $rg 'properties') 'provisioningState'
    if ($state -ne 'Succeeded') { throw "The report-generator Container App is '$state'." }
}

function Invoke-AzureFresh {
    <# A fresh deploy of the candidate; with sign-in, demo data loaded and read as the Admin caller. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable] $Ctx)
    $api = Install-AzureRelease -Ctx $Ctx -Ref $Ctx.Candidate -Step 'fresh'
    if ($Ctx.V.SignIn) {
        $admin = (Assert-AzureSignIn -Ctx $Ctx -BaseUrl $api)['admin']
        Invoke-DemoLoad -BaseUrl $api -Token $admin -TimeoutSec 900
        $failed = @(Invoke-SmokeTest -BaseUrl $api -Token $admin)
        if ($failed.Count -gt 0) { throw "Read endpoints failed for the Admin caller: $($failed -join '; ')" }
        if (-not (Get-ApiTotal -BaseUrl $api -Token $admin).Users) { throw 'No users after the demo load.' }
    }
    if ($Ctx.V.ReportGenerator) { Assert-ReportGeneratorDeployed $Ctx }
}

function Invoke-AzureUpgrade {
    <#
    .SYNOPSIS
        The previous stable release, then the candidate's templates over it.
    .DESCRIPTION
        Without sign-in nothing can be loaded (see the file header), so the
        check is that the upgrade migrates and stays locked. With sign-in:
        demo data and person-made data go in as the Admin caller, the
        candidate's Step 1 + Step 2 run over it, and totals and records must
        read back the same.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable] $Ctx)
    $api = Install-AzureRelease -Ctx $Ctx -Ref $Ctx.PreviousStable -Step 'previous'
    if (-not $Ctx.V.SignIn) {
        Install-AzureRelease -Ctx $Ctx -Ref $Ctx.Candidate -Step 'candidate' -Replacing $Ctx.PreviousStable | Out-Null
        return
    }
    $admin = (Get-AzureToken $Ctx)['admin']
    Invoke-DemoLoad -BaseUrl $api -Token $admin -TimeoutSec 900
    $before = Get-ApiTotal -BaseUrl $api -Token $admin
    if (-not $before.Users) { throw 'The previous release shows no users after the demo load.' }
    $curated = New-CuratedData -BaseUrl $api -Token $admin

    $api = Install-AzureRelease -Ctx $Ctx -Ref $Ctx.Candidate -Step 'candidate' -Replacing $Ctx.PreviousStable
    $admin = (Assert-AzureSignIn -Ctx $Ctx -BaseUrl $api)['admin']
    $problems = @(Compare-RowCount -Before $before -After (Get-ApiTotal -BaseUrl $api -Token $admin))
    if ($problems.Count -gt 0) { throw "After the upgrade: $($problems -join '; ')" }
    Assert-CuratedData -BaseUrl $api -Manifest $curated -Label 'After the upgrade' -Token $admin
}
