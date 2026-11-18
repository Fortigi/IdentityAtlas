#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The Azure part of the release test only ever touches ia-reltest-* resource groups.

.DESCRIPTION
    The IIDemos subscription also holds groups that are not the test's to touch
    (HRSystem among them, which is locked on purpose — the others are not). Three
    layers are checked:

      1. the name gate itself, against names chosen to slip past a sloppy match;
      2. every function that creates, deploys into or deletes a group refuses a
         foreign name BEFORE it calls az (az is mocked and must not be called);
      3. statically, that no az call in the release-test scripts that names a
         group can be reached without the gate.

.USAGE
    Invoke-Pester -Path test/unit/ReleaseTestAzure.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Azure.ps1')
    $script:AzureFile = Join-Path $script:Root 'tools/release/ReleaseTest.Azure.ps1'
    $script:EntryFile = Join-Path $script:Root 'tools/release/Invoke-AzureReleaseTest.ps1'
    $script:FlowFile = Join-Path $script:Root 'tools/release/ReleaseTest.AzureFlow.ps1'
}

Describe 'Test-ReleaseTestGroupName' {
    It 'accepts the names the test creates: <_>' -ForEach @('ia-reltest-43944752579-1-main', 'ia-reltest-1-2-auth-upgrade', 'ia-reltest-x') {
        Test-ReleaseTestGroupName $_ | Should -BeTrue
    }
    It 'rejects <_>' -ForEach @(
        'HRSystem', 'hrsystem', 'IA-RELTEST-1-main', 'Ia-reltest-1', 'ia-reltest-', 'ia-reltest', 'ia-reltest--x',
        'xia-reltest-1', ' ia-reltest-1', 'ia-reltest-1 ', 'ia_reltest-1', 'ia-reltest-ABC', 'ia-reltest-1;rm',
        'ia-reltest-1/../HRSystem', "ia-reltest-1`nHRSystem", 'ia-reltest-1*', 'rg-ia-reltest-1', ''
    ) {
        Test-ReleaseTestGroupName $_ | Should -BeFalse
    }
    It 'rejects $null' { Test-ReleaseTestGroupName $null | Should -BeFalse }
    It 'rejects a name longer than Azure allows (90)' { Test-ReleaseTestGroupName ('ia-reltest-' + ('a' * 80)) | Should -BeFalse }
    It 'accepts the longest name Azure allows' { Test-ReleaseTestGroupName ('ia-reltest-' + ('a' * 79)) | Should -BeTrue }
}

Describe 'New-ReleaseTestGroupName' {
    It 'is prefix, run id, attempt and variant' { New-ReleaseTestGroupName -RunId 43944752579 -Attempt 2 -Variant auth-rg | Should -Be 'ia-reltest-43944752579-2-auth-rg' }
    It 'differs per attempt, so a re-run never reuses a group (and its soft-deleted Key Vault name)' {
        New-ReleaseTestGroupName -RunId 1 -Attempt 1 -Variant main | Should -Not -Be (New-ReleaseTestGroupName -RunId 1 -Attempt 2 -Variant main)
    }
    It 'refuses a variant that would leave the allowed characters' { { New-ReleaseTestGroupName -RunId 1 -Attempt 1 -Variant 'Main' } | Should -Throw '*Refusing*' }
}

Describe 'Every group-touching function refuses a foreign name before calling az' {
    BeforeEach { Mock Invoke-Az { throw 'az must not be called' } }

    It '<Name> refuses HRSystem' -ForEach @(
        @{ Name = 'New-ReleaseTestGroup'; Call = { New-ReleaseTestGroup -Name 'HRSystem' } }
        @{ Name = 'Remove-ReleaseTestGroup'; Call = { Remove-ReleaseTestGroup -Name 'HRSystem' } }
        @{ Name = 'Invoke-ReleaseTestDeployment'; Call = { Invoke-ReleaseTestDeployment -Group 'HRSystem' -TemplateFile x -ParametersJson '{}' -Name n } }
        @{ Name = 'Assert-ReleaseTestGroupName'; Call = { Assert-ReleaseTestGroupName 'HRSystem' } }
    ) {
        { & $Call } | Should -Throw '*Refusing to touch resource group*'
        Should -Invoke Invoke-Az -Times 0 -Exactly
    }
}

Describe 'Remove-ReleaseTestGroup' {
    It 'deletes an existing test group without waiting' {
        Mock Invoke-Az { $true } -ParameterFilter { $Arguments[1] -eq 'exists' }
        Mock Invoke-Az { $null } -ParameterFilter { $Arguments[1] -eq 'delete' }
        Remove-ReleaseTestGroup -Name 'ia-reltest-1-1-main'
        Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq 'group delete --name ia-reltest-1-1-main --yes --no-wait' }
    }
    It 'does nothing when the group is already gone' {
        Mock Invoke-Az { $false } -ParameterFilter { $Arguments[1] -eq 'exists' }
        Mock Invoke-Az { throw 'no delete expected' } -ParameterFilter { $Arguments[1] -eq 'delete' }
        { Remove-ReleaseTestGroup -Name 'ia-reltest-1-1-main' } | Should -Not -Throw
    }
}

Describe 'Select-StaleReleaseTestGroup / Get-StaleReleaseTestGroup' {
    BeforeAll {
        $script:Now = [datetime]::Parse('2026-11-17T02:07:00Z').ToUniversalTime()
        function New-TestGroup([string] $Name, $CreatedAt) {
            $tags = if ($null -eq $CreatedAt) { [pscustomobject]@{ purpose = 'ia-release-test' } } else { [pscustomobject]@{ purpose = 'ia-release-test'; createdAt = $CreatedAt } }
            [pscustomobject]@{ name = $Name; tags = $tags }
        }
        $script:Groups = @(
            New-TestGroup 'ia-reltest-1-1-main' '2026-11-15T02:00:00Z'      # 2 days: stale
            New-TestGroup 'ia-reltest-2-1-main' '2026-11-16T03:00:00Z'      # 23 h: not yet
            New-TestGroup 'ia-reltest-3-1-main' '2026-11-16T02:00:00Z'      # 24 h 7 min: stale
            New-TestGroup 'ia-reltest-4-1-main' $null                       # no createdAt: left alone
            New-TestGroup 'ia-reltest-5-1-main' 'yesterday'                 # unreadable: left alone
            New-TestGroup 'HRSystem' '2020-01-01T00:00:00Z'                 # old and wrongly tagged: never ours
            New-TestGroup 'IA-RELTEST-6-1-main' '2020-01-01T00:00:00Z'      # wrong case: never ours
        )
    }
    It 'picks only test groups whose createdAt is more than a day old' {
        Select-StaleReleaseTestGroup -Groups $script:Groups -Now $script:Now | Should -Be @('ia-reltest-1-1-main', 'ia-reltest-3-1-main')
    }
    It 'never returns HRSystem, whatever its tags say' {
        Select-StaleReleaseTestGroup -Groups $script:Groups -Now $script:Now -MaxAgeHours 0 | Should -Not -Contain 'HRSystem'
    }
    It 'honours a shorter limit' {
        Select-StaleReleaseTestGroup -Groups $script:Groups -Now $script:Now -MaxAgeHours 1 | Should -Contain 'ia-reltest-2-1-main'
    }
    It 'asks Azure for tagged groups only, and filters the answer by name again' {
        Mock Invoke-Az { $script:Groups } -ParameterFilter { ($Arguments -join ' ') -eq 'group list --tag purpose=ia-release-test' }
        $stale = Get-StaleReleaseTestGroup -MaxAgeHours 0
        $stale | Should -Not -Contain 'HRSystem'
        $stale | Should -Not -Contain 'IA-RELTEST-6-1-main'
        Should -Invoke Invoke-Az -Times 1 -Exactly
    }
}

Describe 'No az call that names a resource group bypasses the gate (static)' {
    BeforeAll {
        function Get-Function([string] $Path) {
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$null)
            $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
        }
        # An Invoke-Az call whose first two words act on a group or inside one.
        function Test-TouchesGroup([string] $Text) {
            $Text -match 'Invoke-Az\s+(group\s+(create|delete|exists|update)|deployment\s+group|containerapp|resource\s)'
        }
    }
    It 'every function in ReleaseTest.Azure.ps1 and ReleaseTest.AzureFlow.ps1 that touches a group calls Assert-ReleaseTestGroupName first' {
        $functions = @(Get-Function $script:AzureFile) + @(Get-Function $script:FlowFile)
        @($functions | Where-Object Name -eq 'Assert-ReportGeneratorDeployed').Count | Should -Be 1   # the scan reaches the flow file
        $offenders = foreach ($f in $functions) {
            $body = $f.Body.Extent.Text
            if (-not (Test-TouchesGroup $body)) { continue }
            $gate = $body.IndexOf('Assert-ReleaseTestGroupName')
            $call = [regex]::Match($body, 'Invoke-Az\s+(group|deployment|containerapp|resource)').Index
            if ($gate -lt 0 -or $gate -gt $call) { $f.Name }
        }
        @($offenders) | Should -BeNullOrEmpty
    }
    It 'the only group listing filters by the release-test tag' {
        $lists = [regex]::Matches((Get-Content $script:AzureFile -Raw), 'Invoke-Az\s+group\s+list[^\r\n]*')
        $lists.Count | Should -Be 1
        $lists[0].Value | Should -BeLike '*--tag $script:GroupTag*'
    }
    It 'the entry script gates its -Group before handing it on, and calls az only through the gated functions' {
        $text = Get-Content $script:EntryFile -Raw
        $text.IndexOf('Assert-ReleaseTestGroupName $Group') | Should -BeGreaterThan 0
        $text.IndexOf('Assert-ReleaseTestGroupName $Group') | Should -BeLessThan $text.IndexOf('New-AzureRunContext')
        $text | Should -Not -Match 'Invoke-Az\s'
    }
    It 'no release-test script calls az directly, only through Invoke-Az' {
        $direct = Get-ChildItem (Join-Path $script:Root 'tools/release') -Filter '*.ps1' | ForEach-Object {
            Select-String -Path $_.FullName -Pattern '(^|[\s;(&])az\s+(group|deployment|resource|lock)\b' | Where-Object { $_.Line -notmatch '^\s*#' }
        }
        @($direct) | Should -BeNullOrEmpty
    }
    It 'nothing in the release test removes or edits a lock' {
        Get-ChildItem (Join-Path $script:Root 'tools/release'), (Join-Path $script:Root '.github/workflows') -Include '*.ps1', '*.yml' -Recurse |
            Select-String -Pattern 'az\s+lock|Microsoft\.Authorization/locks' | Should -BeNullOrEmpty
    }
}

Describe 'Get-DeploymentParameter' {
    BeforeAll { $script:MainParams = (Get-Content (Join-Path $script:Root 'azure/main.json') -Raw | ConvertFrom-Json).parameters.PSObject.Properties.Name }

    It 'pins a release to its image version and sets no channel' {
        $p = (Get-DeploymentParameter -ImageTag '6.1.2-beta.1' | ConvertFrom-Json).parameters
        $p.imageTag.value | Should -Be '6.1.2-beta.1'
        $p.PSObject.Properties.Name | Should -Not -Contain 'imageChannel'
    }
    It 'follows the edge channel for edge and sets no image tag' {
        $p = (Get-DeploymentParameter -ImageTag 'edge' | ConvertFrom-Json).parameters
        $p.imageChannel.value | Should -Be 'edge'
        $p.PSObject.Properties.Name | Should -Not -Contain 'imageTag'
    }
    It 'deploys the cheapest profile' { (Get-DeploymentParameter -ImageTag edge | ConvertFrom-Json).parameters.sizeProfile.value | Should -Be 'xs' }
    It 'passes deployReportGenerator as a boolean: <_>' -ForEach @($true, $false) {
        (Get-DeploymentParameter -ImageTag edge -ReportGenerator:$_ | ConvertFrom-Json).parameters.deployReportGenerator.value | Should -BeExactly $_
    }
    It 'only uses parameters main.json declares' {
        foreach ($tag in 'edge', '6.1.1.0') {
            (Get-DeploymentParameter -ImageTag $tag -ReportGenerator | ConvertFrom-Json).parameters.PSObject.Properties.Name |
                ForEach-Object { $script:MainParams | Should -Contain $_ }
        }
    }
    It 'xs is a size profile main.json allows' {
        (Get-Content (Join-Path $script:Root 'azure/main.json') -Raw | ConvertFrom-Json).parameters.sizeProfile.allowedValues | Should -Contain 'xs'
    }
    It 'main-auth.json still takes the two values the sign-in step passes' {
        $auth = (Get-Content (Join-Path $script:Root 'azure/main-auth.json') -Raw | ConvertFrom-Json).parameters.PSObject.Properties.Name
        $auth | Should -Contain 'entraTenantId'
        $auth | Should -Contain 'entraClientId'
    }
}

Describe 'Variants and outputs' {
    It 'covers both templates with and without the report generator, fresh' {
        $fresh = Get-AzureVariantName | ForEach-Object { $v = Get-AzureVariant $_; if (-not $v.Upgrade) { "$($v.SignIn)/$($v.ReportGenerator)" } }
        $fresh | Sort-Object | Should -Be @('False/False', 'False/True', 'True/False', 'True/True')
    }
    It 'upgrades both default variants (no report generator), with and without sign-in' {
        $up = Get-AzureVariantName | ForEach-Object { $v = Get-AzureVariant $_; if ($v.Upgrade) { "$($v.SignIn)/$($v.ReportGenerator)" } }
        $up | Sort-Object | Should -Be @('False/False', 'True/False')
    }
    It 'refuses an unknown variant' { { Get-AzureVariant 'prod' } | Should -Throw '*Unknown Azure variant*' }
    It 'every variant name makes a valid group name' {
        Get-AzureVariantName | ForEach-Object { Test-ReleaseTestGroupName (New-ReleaseTestGroupName -RunId 1 -Attempt 1 -Variant $_) | Should -BeTrue }
    }
    It 'reads the API URL from the appHostname output' {
        Get-AppApiUrl ([pscustomobject]@{ appHostname = [pscustomobject]@{ value = 'idatlas-abc-web.azurewebsites.net' } }) | Should -Be 'https://idatlas-abc-web.azurewebsites.net/api'
    }
    It 'fails without an appHostname output' { { Get-AppApiUrl ([pscustomobject]@{}) } | Should -Throw '*no appHostname*' }
    It 'main.json still has the appHostname output the test reads' {
        (Get-Content (Join-Path $script:Root 'azure/main.json') -Raw | ConvertFrom-Json).outputs.PSObject.Properties.Name | Should -Contain 'appHostname'
    }
}

Describe 'Invoke-Az gets only flags PowerShell passes on' {
    # Invoke-Az is an advanced function: a short flag that starts a common
    # parameter (-d = -Debug, -v = -Verbose, -o = -OutVariable …) would be taken
    # by PowerShell and never reach az. Invoke-Compose lost `-d` exactly that way.
    It 'no call passes a short flag that collides with a common parameter' {
        $hits = Get-ChildItem (Join-Path $script:Root 'tools/release') -Filter '*.ps1' |
            Select-String -Pattern 'Invoke-Az\b.*\s-(d|v|e|w|i|o|p)[a-z]*\b' -CaseSensitive:$false |
            Where-Object { $_.Line -notmatch '^\s*#' }
        @($hits | ForEach-Object { "$($_.Filename):$($_.LineNumber)" }) | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-GroupNamePart' {
    It 'turns a candidate into group-name characters: <in>' -ForEach @(
        @{ in = 'v6.1.2-beta.1'; out = 'v6-1-2-beta-1' }, @{ in = 'edge'; out = 'edge' }, @{ in = 'V6.10.0'; out = 'v6-10-0' }
    ) { ConvertTo-GroupNamePart $in | Should -Be $out }
    It 'keeps two candidates in one run apart' {
        $a = New-ReleaseTestGroupName -RunId 1 -Attempt 1 -Variant "$(ConvertTo-GroupNamePart 'v6.2.0-beta.1')-main"
        $b = New-ReleaseTestGroupName -RunId 1 -Attempt 1 -Variant "$(ConvertTo-GroupNamePart 'v6.1.2-beta.1')-main"
        $a | Should -Not -Be $b
    }
    It 'makes a valid name for the longest real case' {
        Test-ReleaseTestGroupName (New-ReleaseTestGroupName -RunId 99999999999 -Attempt 9 -Variant "$(ConvertTo-GroupNamePart 'v10.10.10-beta.10')-auth-upgrade") | Should -BeTrue
    }
}

Describe 'Region fallback on SkuNotAvailable' {
    BeforeAll {
        $script:Base = 'ia-reltest-44172793802-1-v6-2-0-beta-1-auth-upgrade'
        # The shape run 44172793802 got: the code four levels down in details,
        # as Invoke-Az throws it.
        $script:SkuError = 'az deployment group failed:' + "`n" + 'ERROR: {"status":"Failed","error":{"code":"DeploymentFailed","message":"At least one resource deployment operation failed.","details":[{"code":"ResourceDeploymentFailure","target":"/deployments/postgres","details":[{"code":"DeploymentFailed","details":[{"code":"ResourceDeploymentFailure","target":"/flexibleServers/idatlas-pg","details":[{"code":"SkuNotAvailable","message":"Specified SKU is not supported in this region. Please choose a different SKU."}]}]}]}]}}'
        $script:OtherError = 'az deployment group failed:' + "`n" + 'ERROR: {"status":"Failed","error":{"code":"DeploymentFailed","details":[{"code":"ResourceDeploymentFailure","details":[{"code":"InvalidTemplateDeployment","message":"The template deployment failed."}]}]}}'
    }

    Context 'Test-SkuNotAvailable' {
        It 'finds the code nested deep in details (the real failure)' { Test-SkuNotAvailable $script:SkuError | Should -BeTrue }
        It 'finds it at the top level too' { Test-SkuNotAvailable 'ERROR: {"error":{"code":"SkuNotAvailable"}}' | Should -BeTrue }
        It 'is false for another nested code' { Test-SkuNotAvailable $script:OtherError | Should -BeFalse }
        It 'is false when the word is only in a message, not a code' {
            Test-SkuNotAvailable 'ERROR: {"error":{"code":"QuotaExceeded","message":"not SkuNotAvailable, a quota"}}' | Should -BeFalse
        }
        It 'is false for <_>' -ForEach @('', 'Read endpoints failed: /systems -> 401', 'ERROR: {"error":{"code":"SkuNotAvailable"', 'ERROR: } SkuNotAvailable {') {
            Test-SkuNotAvailable $_ | Should -BeFalse
        }
        It 'is false for $null' { Test-SkuNotAvailable $null | Should -BeFalse }
    }

    Context 'Get-ReleaseTestRegionGroup' {
        It 'keeps the workflow''s name in the first region and suffixes the region after that' {
            $slots = Get-ReleaseTestRegionGroup -BaseName $script:Base
            @($slots.Region) | Should -Be @('westeurope', 'swedencentral', 'northeurope')
            @($slots.Group) | Should -Be @($script:Base, "$($script:Base)-swedencentral", "$($script:Base)-northeurope")
        }
        It 'every group of the longest real case passes the gate' {
            $base = New-ReleaseTestGroupName -RunId 99999999999 -Attempt 9 -Variant "$(ConvertTo-GroupNamePart 'v10.10.10-beta.10')-auth-upgrade"
            (Get-ReleaseTestRegionGroup -BaseName $base).Group | ForEach-Object { Test-ReleaseTestGroupName $_ | Should -BeTrue }
        }
        It 'refuses a region that would leave the allowed characters' {
            { Get-ReleaseTestRegionGroup -BaseName $script:Base -Regions 'westeurope', 'Sweden Central' } | Should -Throw '*Refusing*'
        }
        It 'refuses a foreign base name' { { Get-ReleaseTestRegionGroup -BaseName 'HRSystem' } | Should -Throw '*Refusing*' }
        It 'refuses an empty region list' { { Get-ReleaseTestRegionGroup -BaseName $script:Base -Regions @() } | Should -Throw '*No Azure regions*' }
    }

    Context 'Invoke-InRegionWithFallback' {
        BeforeEach {
            # $script:Outcomes: one entry per deployment, in order: 'ok', 'sku' or 'other'.
            $script:Deployments = [System.Collections.Generic.List[string]]::new()
            $script:Outcomes = [System.Collections.Generic.Queue[string]]::new()
            Mock Invoke-Az { $null } -ParameterFilter { $Arguments[0] -eq 'group' -and $Arguments[1] -eq 'create' }
            Mock Invoke-Az { $true } -ParameterFilter { $Arguments[0] -eq 'group' -and $Arguments[1] -eq 'exists' }
            Mock Invoke-Az { $null } -ParameterFilter { $Arguments[0] -eq 'group' -and $Arguments[1] -eq 'delete' }
            Mock Invoke-Az {
                $script:Deployments.Add("$($Arguments[6])@$($Arguments[4])")
                switch ($script:Outcomes.Dequeue()) { 'sku' { throw $script:SkuError } 'other' { throw $script:OtherError } }
            } -ParameterFilter { $Arguments[0] -eq 'deployment' }
            # An upgrade: the previous release, then the candidate, in one group.
            $script:Upgrade = {
                param([string] $Group)
                Invoke-Az deployment group create --resource-group $Group --name previous
                Invoke-Az deployment group create --resource-group $Group --name candidate
            }
        }

        It 'redoes the variant in the next region after SkuNotAvailable, in a new group' {
            'sku', 'ok', 'ok' | ForEach-Object { $script:Outcomes.Enqueue($_) }
            Invoke-InRegionWithFallback -BaseName $script:Base -Body $script:Upgrade | Should -Be 'swedencentral'
            Should -Invoke Invoke-Az -Times 2 -Exactly -ParameterFilter { $Arguments[0] -eq 'group' -and $Arguments[1] -eq 'create' }
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -like "group create --name $($script:Base) --location westeurope --tags *" }
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -like "group create --name $($script:Base)-swedencentral --location swedencentral --tags *" }
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq "group delete --name $($script:Base) --yes --no-wait" }
            Should -Invoke Invoke-Az -Times 0 -Exactly -ParameterFilter { ($Arguments -join ' ') -like "group delete --name $($script:Base)-swedencentral *" }
        }

        It 'restarts an upgrade from the previous release, not half-way' {
            'ok', 'sku', 'ok', 'ok' | ForEach-Object { $script:Outcomes.Enqueue($_) }
            Invoke-InRegionWithFallback -BaseName $script:Base -Body $script:Upgrade | Should -Be 'swedencentral'
            @($script:Deployments) | Should -Be @(
                "previous@$($script:Base)", "candidate@$($script:Base)",
                "previous@$($script:Base)-swedencentral", "candidate@$($script:Base)-swedencentral")
        }

        It 'fails at once on any other deployment error: no second region, no delete' {
            $script:Outcomes.Enqueue('other')
            { Invoke-InRegionWithFallback -BaseName $script:Base -Body $script:Upgrade } | Should -Throw '*InvalidTemplateDeployment*'
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { $Arguments[0] -eq 'group' -and $Arguments[1] -eq 'create' }
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -like "group create --name $($script:Base) --location westeurope *" }
            Should -Invoke Invoke-Az -Times 0 -Exactly -ParameterFilter { $Arguments[1] -eq 'delete' }
            @($script:Deployments) | Should -Be @("previous@$($script:Base)")
        }

        It 'fails on a non-az error in the body too, without a retry' {
            { Invoke-InRegionWithFallback -BaseName $script:Base -Body { throw 'Read endpoints failed: /systems -> 401' } } | Should -Throw '*401*'
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { $Arguments[0] -eq 'group' -and $Arguments[1] -eq 'create' }
        }

        It 'fails with a clear message when every region answers SkuNotAvailable' {
            'sku', 'sku', 'sku' | ForEach-Object { $script:Outcomes.Enqueue($_) }
            { Invoke-InRegionWithFallback -BaseName $script:Base -Body $script:Upgrade } |
                Should -Throw 'Azure answered SkuNotAvailable in every region tried (westeurope, swedencentral, northeurope); nothing deployed.'
            Should -Invoke Invoke-Az -Times 3 -Exactly -ParameterFilter { $Arguments[0] -eq 'group' -and $Arguments[1] -eq 'create' }
            Should -Invoke Invoke-Az -Times 3 -Exactly -ParameterFilter { $Arguments[1] -eq 'delete' }
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -like "group create --name $($script:Base)-northeurope --location northeurope *" }
            @($script:Deployments) | Should -Be @("previous@$($script:Base)", "previous@$($script:Base)-swedencentral", "previous@$($script:Base)-northeurope")
        }

        It 'takes its regions from -Regions' {
            'sku', 'ok', 'ok' | ForEach-Object { $script:Outcomes.Enqueue($_) }
            Invoke-InRegionWithFallback -BaseName $script:Base -Regions 'francecentral', 'germanywestcentral' -Body $script:Upgrade | Should -Be 'germanywestcentral'
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -like "group create --name $($script:Base) --location francecentral *" }
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -like "group create --name $($script:Base)-germanywestcentral --location germanywestcentral *" }
            Should -Invoke Invoke-Az -Times 0 -Exactly -ParameterFilter { ($Arguments -join ' ') -like '*westeurope*' }
        }

        It 'passes in the first region without touching another' {
            'ok', 'ok' | ForEach-Object { $script:Outcomes.Enqueue($_) }
            Invoke-InRegionWithFallback -BaseName $script:Base -Body $script:Upgrade | Should -Be 'westeurope'
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { $Arguments[0] -eq 'group' -and $Arguments[1] -eq 'create' }
            Should -Invoke Invoke-Az -Times 0 -Exactly -ParameterFilter { $Arguments[1] -eq 'delete' }
        }

        It 'refuses a foreign base name before calling az' {
            { Invoke-InRegionWithFallback -BaseName 'HRSystem' -Body { } } | Should -Throw '*Refusing*'
            Should -Invoke Invoke-Az -Times 0 -Exactly
        }
    }

    Context 'Remove-ReleaseTestRegionGroup' {
        It 'deletes the group of every region that exists, and only those' {
            Mock Invoke-Az { $true } -ParameterFilter { ($Arguments -join ' ') -eq "group exists --name $($script:Base)" }
            Mock Invoke-Az { $false } -ParameterFilter { ($Arguments -join ' ') -eq "group exists --name $($script:Base)-swedencentral" }
            Mock Invoke-Az { $true } -ParameterFilter { ($Arguments -join ' ') -eq "group exists --name $($script:Base)-northeurope" }
            Mock Invoke-Az { $null } -ParameterFilter { $Arguments[1] -eq 'delete' }
            Remove-ReleaseTestRegionGroup -BaseName $script:Base
            Should -Invoke Invoke-Az -Times 2 -Exactly -ParameterFilter { $Arguments[1] -eq 'delete' }
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq "group delete --name $($script:Base) --yes --no-wait" }
            Should -Invoke Invoke-Az -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq "group delete --name $($script:Base)-northeurope --yes --no-wait" }
        }
        It 'refuses a foreign name before calling az' {
            Mock Invoke-Az { throw 'az must not be called' }
            { Remove-ReleaseTestRegionGroup -BaseName 'HRSystem' } | Should -Throw '*Refusing*'
            Should -Invoke Invoke-Az -Times 0 -Exactly
        }
    }
}
