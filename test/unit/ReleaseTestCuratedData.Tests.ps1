#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Person-made data check of the release test (tools/release/ReleaseTest.CuratedData.ps1).

.DESCRIPTION
    The check is only worth something if a changed record fails it. The last
    block runs the whole make -> read -> compare flow against an in-memory
    stand-in for the API that stores each body as JSON (as the real API does
    in jsonb), and then breaks one stored value at a time: every break must
    produce exactly one problem, naming that record, while an untouched store
    must produce none. The real API itself is exercised by release-test.yml,
    which runs on every PR that changes these files.

.USAGE
    Invoke-Pester -Path test/unit/ReleaseTestCuratedData.Tests.ps1 -Output Detailed
#>

BeforeDiscovery {
    . (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) tools/release/ReleaseTest.CuratedData.ps1)
}

BeforeAll {
    $script:Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:Root 'tools/release/ReleaseTest.Functions.ps1')
    . (Join-Path $script:Root 'tools/release/ReleaseTest.CuratedData.ps1')

    # A body as the API gets it back from postgres: through JSON, key order not kept.
    function ConvertTo-Stored($Body) { ConvertTo-Json -InputObject $Body -Depth 10 | ConvertFrom-Json -NoEnumerate }

    function New-FakeStore {
        @{
            Users    = @('AAAAAAAA-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000003')
            Tags     = [System.Collections.Generic.List[object]]::new()
            Contexts = @{}
            Members  = @{}
            Crawlers = @{}
            Category = [System.Collections.Generic.List[object]]::new()
            Linking  = [pscustomobject]@{ rules = [pscustomobject]@{ linkThreshold = 50; onlyLinkTypes = @('Admin') }; schedules = $null }
            Roles    = [pscustomobject]@{ Admin = @('*'); Servicedesk = @('data.read') }
            Features = [pscustomobject]@{ matrixSharing = $false; accountLinking = $true }
            Matrices = [System.Collections.Generic.List[object]]::new()
            Keys     = [System.Collections.Generic.List[object]]::new()
            # The first identity has no linked account, so the helper has to look past it.
            Identities = @(
                @{ id = 'ffffffff-0000-0000-0000-000000000006'; members = @() }
                @{ id = 'dddddddd-0000-0000-0000-000000000004'; members = @([pscustomobject]@{ principalId = 'eeeeeeee-0000-0000-0000-000000000005'; analystOverride = $null }) }
            )
        }
    }

    # The replies of the routes the helper calls, shaped as app/api/src/routes answers them.
    function Invoke-FakeApi([string] $Method, [string] $Path, $Body) {
        $s = $script:Store
        switch -Regex ("$Method $Path") {
            '^Get /users\?limit=2$' { return [pscustomobject]@{ data = @($s.Users[0..1] | ForEach-Object { [pscustomobject]@{ id = $_ } }); total = 3 } }
            '^Post /tags$' {
                $t = ConvertTo-Stored $Body; $t | Add-Member id ([guid]::NewGuid().Guid); $s.Tags.Add($t); return $t
            }
            '^Post /tags/([^/]+)/assign$' { $s.Members[$Matches[1]] = @($Body.entityIds | ForEach-Object { "$_".ToLowerInvariant() }); return @{ ok = $true } }
            '^Get /tags$' { return @($s.Tags) }
            '^Post /contexts$' {
                $c = ConvertTo-Stored $Body; $c | Add-Member id ([guid]::NewGuid().Guid); $c | Add-Member variant 'manual'
                $s.Contexts[$c.id] = $c; $s.Members[$c.id] = @(); return $c
            }
            '^Post /contexts/([^/]+)/members$' { $s.Members[$Matches[1]] = @($s.Members[$Matches[1]]) + $Body.memberId; return @{} }
            '^Get /contexts/([^/?]+)/members\?limit=500$' { return [pscustomobject]@{ data = @($s.Members[$Matches[1]] | ForEach-Object { [pscustomobject]@{ id = $_ } }) } }
            '^Get /contexts/([^/?]+)$' { return [pscustomobject]@{ attributes = $s.Contexts[$Matches[1]]; members = @() } }
            '^Post /admin/crawler-configs$' { $c = ConvertTo-Stored $Body; $c | Add-Member id 7; $s.Crawlers['7'] = $c; return $c }
            '^Get /admin/crawler-configs/(\d+)$' { return $s.Crawlers[$Matches[1]] }
            '^Post /categories$' { $c = ConvertTo-Stored $Body; $c | Add-Member id 3; $s.Category.Add($c); return $c }
            '^Get /categories$' { return @($s.Category) }
            '^Get /account-linking/config$' { return ConvertTo-Stored $s.Linking }
            '^Put /account-linking/config$' { $s.Linking = ConvertTo-Stored $Body; return $s.Linking }
            '^Get /admin/roles$' { return [pscustomobject]@{ mapping = ConvertTo-Stored $s.Roles; isCustom = $false } }
            '^Put /admin/roles$' { $s.Roles = ConvertTo-Stored $Body.mapping; return @{ ok = $true } }
            '^Get /features$' { return ConvertTo-Stored $s.Features }
            '^Post /admin/features/toggle$' { $s.Features.($Body.feature) = $Body.enabled; return $Body }
            '^Post /matrix/saved-filters$' { $m = ConvertTo-Stored $Body; $m | Add-Member id ([guid]::NewGuid().Guid); $s.Matrices.Add($m); return $m }
            '^Get /matrix/saved-filters$' { return @($s.Matrices) }
            '^Post /admin/read-tokens$' {
                $row = [pscustomobject]@{ id = 5; name = $Body.name; tokenPrefix = 'fgr_abcdefgh'; revoked = $false }
                $s.Keys.Add($row); return [pscustomobject]@{ token = 'fgr_abcdefghijklmnopqrstuvwxyz'; row = $row }
            }
            '^Get /admin/read-tokens$' { return @($s.Keys) }
            '^Get /identities\?limit=25$' { return [pscustomobject]@{ data = @($s.Identities | ForEach-Object { [pscustomobject]@{ id = $_.id } }) } }
            '^Get /identities/([^/?]+)$' { return [pscustomobject]@{ identity = @{}; members = @(($s.Identities | Where-Object id -EQ $Matches[1]).members) } }
            '^Put /identities/[^/]+/members/([^/]+)/override$' {
                ($s.Identities.members | Where-Object principalId -EQ $Matches[1]).analystOverride = $Body.action; return @{}
            }
            '^Get /auth-config$' { return [pscustomobject]@{ enabled = $false } }
            default { throw "The fake API has no route for $Method $Path" }
        }
    }
}

Describe 'ConvertTo-CanonicalJson' {
    It 'gives a hashtable and the object JSON brings back, keys reordered, the same text' {
        $sent = [ordered]@{ zeta = 1; alpha = [ordered]@{ y = 'b'; x = 'a' } }
        $back = '{"alpha":{"x":"a","y":"b"},"zeta":1}' | ConvertFrom-Json
        ConvertTo-CanonicalJson $back | Should -Be (ConvertTo-CanonicalJson $sent)
        ConvertTo-CanonicalJson $sent | Should -Be '{"alpha":{"x":"a","y":"b"},"zeta":1}'
    }
    It 'keeps array order: a reordered list is a different value' {
        ConvertTo-CanonicalJson @('a', 'b') | Should -Not -Be (ConvertTo-CanonicalJson @('b', 'a'))
    }
    It 'tells a number from a string and a boolean from its word' {
        ConvertTo-CanonicalJson @{ v = 3 } | Should -Not -Be (ConvertTo-CanonicalJson @{ v = '3' })
        ConvertTo-CanonicalJson @{ v = $false } | Should -Not -Be (ConvertTo-CanonicalJson @{ v = 'false' })
    }
    It 'writes null, and an array of one object as an array' {
        ConvertTo-CanonicalJson $null | Should -Be 'null'
        ConvertTo-CanonicalJson ('{"s":[{"a":1}]}' | ConvertFrom-Json).s | Should -Be '[{"a":1}]'
    }
    It 'sorts keys ordinally, so the result does not depend on the culture' {
        ConvertTo-CanonicalJson @{ b = 1; C = 2; a = 3 } | Should -Be '{"C":2,"a":3,"b":1}'
    }
    It 'survives the JSON round trip for every structured seed value' {
        $seed = Get-CuratedSeed
        ConvertTo-CanonicalJson (ConvertTo-Stored $seed.MatrixFilter) | Should -Be (ConvertTo-CanonicalJson $seed.MatrixFilter)
        $schedules = @($seed.CrawlerSchedule)
        ConvertTo-CanonicalJson (ConvertTo-Stored $schedules) | Should -Be (ConvertTo-CanonicalJson $schedules)
    }
}

Describe 'Format-CuratedRecord and Format-IdSet' {
    It 'keeps the field order and marks a missing value' {
        Format-CuratedRecord ([ordered]@{ name = 'n'; color = $null; type = 't' }) | Should -Be 'name=n; color=<missing>; type=t'
    }
    It 'ignores case and order of ids, not a missing one' {
        Format-IdSet @('B-2', 'a-1') | Should -Be 'a-1,b-2'
        Format-IdSet @('a-1', 'b-2') | Should -Be (Format-IdSet @('B-2', 'A-1'))
        Format-IdSet @('a-1') | Should -Not -Be (Format-IdSet @('a-1', 'b-2'))
    }
    It 'is empty for no ids' { Format-IdSet @() | Should -Be '' }
}

Describe 'Find-ById' {
    BeforeAll { $script:List = @([pscustomobject]@{ id = 3; name = 'three' }, [pscustomobject]@{ id = 'AB-1'; name = 'ab' }) }
    It 'finds a numeric id given as a number or as text' {
        (Find-ById $script:List 3).name | Should -Be 'three'
        (Find-ById $script:List '3').name | Should -Be 'three'
    }
    It 'finds a text id' { (Find-ById $script:List 'ab-1').name | Should -Be 'ab' }
    It 'is null when the id is absent or there is no list' {
        Find-ById $script:List 4 | Should -BeNullOrEmpty
        Find-ById $null 3 | Should -BeNullOrEmpty
    }
}

Describe 'Compare-CuratedData' {
    BeforeAll { $script:E = [ordered]@{ tag = 'name=t; color=#7a3e9d'; 'feature switch' = 'enabled=True' } }
    It 'finds nothing when every value came back' {
        Compare-CuratedData -Expected $script:E -Actual ([ordered]@{ tag = 'name=t; color=#7a3e9d'; 'feature switch' = 'enabled=True'; extra = 'x' }) | Should -BeNullOrEmpty
    }
    It 'names the record and both values when one changed' {
        $p = @(Compare-CuratedData -Expected $script:E -Actual ([ordered]@{ tag = 'name=t; color=#3b82f6'; 'feature switch' = 'enabled=True' }))
        $p.Count | Should -Be 1
        $p[0] | Should -Be "tag: expected 'name=t; color=#7a3e9d', found 'name=t; color=#3b82f6'"
    }
    It 'counts a change of case as a change' {
        @(Compare-CuratedData -Expected $script:E -Actual ([ordered]@{ tag = 'name=T; color=#7a3e9d'; 'feature switch' = 'enabled=True' })).Count | Should -Be 1
    }
    It 'reports a record that was not read back' {
        Compare-CuratedData -Expected $script:E -Actual ([ordered]@{ tag = 'name=t; color=#7a3e9d' }) | Should -Be @('feature switch: not read back')
    }
    It 'fails a comparison against nothing' {
        Compare-CuratedData -Expected ([ordered]@{}) -Actual ([ordered]@{ tag = 'x' }) | Should -Be @('no person-made records were made before the change')
    }
}

Describe 'Get-ReadTokenHash' {
    It 'is the lower-case hex SHA-256 readTokens.js stores' {
        Get-ReadTokenHash 'abc' | Should -Be 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    }
    It 'looks up the hash among keys that are not revoked' {
        $q = Get-ReadTokenHashQuery 'abc'
        $q | Should -BeLike "*`"tokenHash`" = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'*"
        $q | Should -BeLike '*AND NOT revoked'
    }
}

Describe 'Get-CuratedSeed' {
    BeforeAll {
        $script:Seed = Get-CuratedSeed
        $script:Permissions = Get-Content (Join-Path $script:Root 'app/api/src/auth/permissions.js') -Raw
        $script:Flags = Get-Content (Join-Path $script:Root 'app/api/src/featureFlags.js') -Raw
    }
    It 'gives the crawler a schedule that never fires during the test' { $script:Seed.CrawlerSchedule.enabled | Should -BeExactly $false }
    It 'uses permissions the API knows (<_>)' -ForEach (Get-CuratedSeed).RolePermissions {
        $script:Permissions | Should -Match ("'" + [regex]::Escape($_) + "':")
    }
    It 'switches a feature the API has, and not one the report-generator scenario depends on' {
        $script:Flags | Should -Match ("\n  $($script:Seed.Feature): \{")
        $script:Seed.Feature | Should -Not -BeIn @('customReports', 'riskScoring', 'mcpServer')
    }
    It 'uses colours the tag and category routes accept' {
        $script:Seed.TagColor | Should -Match '^#[0-9a-fA-F]{6}$'
        $script:Seed.CategoryColor | Should -Match '^#[0-9a-fA-F]{6}$'
    }
    It 'sets a link threshold the shipped rules do not have' {
        Get-Content (Join-Path $script:Root 'app/api/src/accountlinking/defaultRules.js') -Raw |
            Should -Not -Match "linkThreshold: $($script:Seed.LinkThreshold),"
    }
}

Describe 'Make, read back and compare' {
    BeforeEach {
        $script:Store = New-FakeStore
        # A mock does not see parameter defaults: no -Method is a GET, as in Invoke-Api.
        Mock Invoke-Api { Invoke-FakeApi -Method $(if ($Method) { $Method } else { 'Get' }) -Path $Path -Body $Body }
        Mock Write-Step { }
        $script:Manifest = New-CuratedData -BaseUrl 'http://fake/api'
    }

    It 'records the decision on the identity that has a linked account' {
        $script:Manifest.Ids.Identity | Should -Be 'dddddddd-0000-0000-0000-000000000004'
        $script:Store.Identities[1].members[0].analystOverride | Should -Be 'confirmed'
    }
    It 'expects one record of each kind' {
        @($script:Manifest.Expected.Keys) | Should -Be @(
            'tag', 'tag members', 'manual context', 'manual context members', 'crawler configuration', 'category',
            'account-linking threshold', 'role mapping', 'feature switch', 'saved matrix', 'read API key', 'identity link decision')
    }
    It 'switches the feature away from what it was' { $script:Manifest.Expected['feature switch'] | Should -Be 'feature=matrixSharing; enabled=True' }
    It 'puts the same two users in the tag and in the context' {
        $script:Manifest.Expected['tag members'] | Should -Be 'aaaaaaaa-0000-0000-0000-000000000001,bbbbbbbb-0000-0000-0000-000000000002'
        $script:Manifest.Expected['manual context members'] | Should -Be $script:Manifest.Expected['tag members']
    }
    It 'keeps the other roles when it adds one' {
        @($script:Store.Roles.PSObject.Properties.Name) | Should -Be @('Admin', 'Servicedesk', 'ReleaseTest.KeptRole')
    }
    It 'finds nothing changed when nothing was' {
        Compare-CuratedData -Expected $script:Manifest.Expected -Actual (Read-CuratedData -BaseUrl 'http://fake/api' -Manifest $script:Manifest) | Should -BeNullOrEmpty
        { Assert-CuratedData -BaseUrl 'http://fake/api' -Manifest $script:Manifest -Label 'After' } | Should -Not -Throw
    }

    It 'catches <Label> changing' -ForEach @(
        @{ Label = 'tag'; Break = { $s.Tags[0].color = '#3b82f6' } }
        @{ Label = 'tag members'; Break = { $s.Members[$s.Tags[0].id] = @($s.Members[$s.Tags[0].id][0]) } }
        @{ Label = 'manual context'; Break = { ($s.Contexts.Values | Select-Object -First 1).description = $null } }
        @{ Label = 'manual context members'; Break = { $c = ($s.Contexts.Values | Select-Object -First 1).id; $s.Members[$c] = @($s.Members[$c]) + $s.Users[2] } }
        @{ Label = 'crawler configuration'; Break = { $s.Crawlers['7'].config.schedules[0].minute = 0 } }
        @{ Label = 'category'; Break = { $s.Category.Clear() } }
        @{ Label = 'account-linking threshold'; Break = { $s.Linking.rules.linkThreshold = 50 } }
        @{ Label = 'role mapping'; Break = { $s.Roles = [pscustomobject]@{ Admin = @('*') } } }
        @{ Label = 'feature switch'; Break = { $s.Features.matrixSharing = $false } }
        @{ Label = 'saved matrix'; Break = { $s.Matrices[0].filter.filters.department = 'Sales' } }
        @{ Label = 'read API key'; Break = { $s.Keys[0].revoked = $true } }
        @{ Label = 'identity link decision'; Break = { $s.Identities[1].members[0].analystOverride = $null } }
    ) {
        $s = $script:Store
        . $Break
        $problems = @(Compare-CuratedData -Expected $script:Manifest.Expected -Actual (Read-CuratedData -BaseUrl 'http://fake/api' -Manifest $script:Manifest))
        $problems.Count | Should -Be 1
        $problems[0] | Should -BeLike "${Label}: *"
        { Assert-CuratedData -BaseUrl 'http://fake/api' -Manifest $script:Manifest -Label 'After the restore' } | Should -Throw "After the restore: person-made data changed: ${Label}: *"
    }
}

Describe 'Make and read back without a linked identity' {
    It 'leaves the identity decision out, says so, and still checks the rest' {
        $script:Store = New-FakeStore
        $script:Store.Identities[1].members = @()
        Mock Invoke-Api { Invoke-FakeApi -Method $(if ($Method) { $Method } else { 'Get' }) -Path $Path -Body $Body }
        Mock Write-Step { }
        $m = New-CuratedData -BaseUrl 'http://fake/api' -WarningVariable warned -WarningAction SilentlyContinue
        "$warned" | Should -BeLike '*identity-link decision is not checked*'
        $m.Expected.Contains('identity link decision') | Should -BeFalse
        $m.Expected.Count | Should -Be 11
        Compare-CuratedData -Expected $m.Expected -Actual (Read-CuratedData -BaseUrl 'http://fake/api' -Manifest $m) | Should -BeNullOrEmpty
        $script:Store.Tags[0].color = '#3b82f6'
        @(Compare-CuratedData -Expected $m.Expected -Actual (Read-CuratedData -BaseUrl 'http://fake/api' -Manifest $m)).Count | Should -Be 1
    }
}

Describe 'Assert-ReadTokenSignIn' {
    It 'asks nothing more when sign-in is off' {
        Mock Invoke-Api { [pscustomobject]@{ enabled = $false } }
        Mock Get-HttpStatus { throw 'must not be called' }
        { Assert-ReadTokenSignIn -BaseUrl 'http://fake/api' -ReadToken 'fgr_x' } | Should -Not -Throw
    }
    Context 'with sign-in on' {
        BeforeEach { Mock Invoke-Api { [pscustomobject]@{ enabled = $true } } }
        It 'passes when the kept key gets in and a changed one does not' {
            Mock Get-HttpStatus { if ($Token -eq 'fgr_kept') { 200 } else { 401 } }
            { Assert-ReadTokenSignIn -BaseUrl 'http://fake/api' -ReadToken 'fgr_kept' } | Should -Not -Throw
            Should -Invoke Get-HttpStatus -Times 1 -Exactly -ParameterFilter { $Token -eq 'fgr_kepA' }
        }
        It 'fails when the kept key is refused' {
            Mock Get-HttpStatus { 401 }
            { Assert-ReadTokenSignIn -BaseUrl 'http://fake/api' -ReadToken 'fgr_kept' } | Should -Throw '*no longer signs in (401)*'
        }
        It 'fails when any key gets in' {
            Mock Get-HttpStatus { 200 }
            { Assert-ReadTokenSignIn -BaseUrl 'http://fake/api' -ReadToken 'fgr_keptA' } | Should -Throw '*changed read API key was not refused (200)*'
        }
    }
}
