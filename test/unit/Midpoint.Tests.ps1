#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the midPoint crawler client helpers and file structure.

.DESCRIPTION
    Tests the pure helper functions from Invoke-MidpointApi.ps1 (no network calls)
    and asserts the crawler folder structure / manifest. API connectivity is out of scope.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/Midpoint.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:midpointDir = Join-Path $script:repoRoot 'tools\crawlers\midpoint'
    . (Join-Path $script:midpointDir 'Invoke-MidpointApi.ps1')
    . (Join-Path $script:midpointDir 'Seed-MidpointTestData.ps1')
}

# ─── Get-MidpointRestRoot ─────────────────────────────────────────────────────
Describe 'Get-MidpointRestRoot' {
    It 'appends /midpoint/ws/rest to a bare host' {
        Get-MidpointRestRoot -BaseUrl 'http://mp:8080' | Should -Be 'http://mp:8080/midpoint/ws/rest'
    }
    It 'appends /ws/rest to a /midpoint URL' {
        Get-MidpointRestRoot -BaseUrl 'https://h/midpoint' | Should -Be 'https://h/midpoint/ws/rest'
    }
    It 'leaves a full /midpoint/ws/rest URL unchanged' {
        Get-MidpointRestRoot -BaseUrl 'https://h/midpoint/ws/rest/' | Should -Be 'https://h/midpoint/ws/rest'
    }
}

# ─── Get-MidpointString ───────────────────────────────────────────────────────
Describe 'Get-MidpointString' {
    It 'returns a plain string unchanged' {
        Get-MidpointString -Value 'hello' | Should -Be 'hello'
    }
    It 'returns the fallback for null' {
        Get-MidpointString -Value $null -Fallback 'fb' | Should -Be 'fb'
    }
    It 'accepts a null fallback without throwing (untyped param)' {
        { Get-MidpointString -Value $null -Fallback $null } | Should -Not -Throw
    }
    It 'extracts .orig from a PolyString object' {
        Get-MidpointString -Value ([pscustomobject]@{ orig = 'Wim'; norm = 'wim' }) | Should -Be 'Wim'
    }
    It 'takes the first value of a multi-valued (array) field' {
        Get-MidpointString -Value @('first@x.com','second@x.com') | Should -Be 'first@x.com'
    }
    It 'skips leading nulls in a multi-valued field' {
        Get-MidpointString -Value @($null, 'real@x.com') | Should -Be 'real@x.com'
    }
}

# ─── Get-MidpointRefOid / Type ────────────────────────────────────────────────
Describe 'Get-MidpointRefOid' {
    It 'extracts .oid from a reference object' {
        Get-MidpointRefOid -Ref ([pscustomobject]@{ oid = 'abc'; type = 'c:RoleType' }) | Should -Be 'abc'
    }
    It 'returns the first ref oid when given an array' {
        Get-MidpointRefOid -Ref @([pscustomobject]@{ oid = 'a' }, [pscustomobject]@{ oid = 'b' }) | Should -Be 'a'
    }
    It 'accepts a null fallback without throwing' {
        { Get-MidpointRefOid -Ref $null -Fallback $null } | Should -Not -Throw
    }
    It 'resolves a midPoint 4.9 reference-attribute entry ({oid, relation, type})' {
        # AD group memberships in 4.9 arrive as referenceAttributes.group[] — a bare ref
        # with no shadowRef wrapper. Get-MidpointRefOid must read .oid straight off it.
        Get-MidpointRefOid -Ref ([pscustomobject]@{ oid = 'grp-1'; relation = 'org:default'; type = 'c:ShadowType' }) | Should -Be 'grp-1'
    }
}

Describe 'referenceAttributes membership parsing' {
    It 'collects entitlement oids from referenceAttributes, skipping @ns' {
        # Mirrors the crawler's account-shadow loop: every referenceAttributes property
        # except @ns is an array of refs pointing at entitlement shadows.
        $refAttrs = [pscustomobject]@{
            '@ns' = 'http://midpoint.evolveum.com/xml/ns/public/resource/instance-3'
            group = @(
                [pscustomobject]@{ oid = 'ent-a'; relation = 'org:default'; type = 'c:ShadowType' },
                [pscustomobject]@{ oid = 'ent-b'; relation = 'org:default'; type = 'c:ShadowType' }
            )
        }
        $oids = foreach ($p in $refAttrs.PSObject.Properties) {
            if ($p.Name -eq '@ns' -or $null -eq $p.Value) { continue }
            foreach ($r in @($p.Value)) { Get-MidpointRefOid $r $null }
        }
        @($oids) | Should -Be @('ent-a', 'ent-b')
    }
}

Describe 'Get-MidpointRefType' {
    It 'strips the namespace prefix from the type' {
        Get-MidpointRefType -Ref ([pscustomobject]@{ oid = 'x'; type = 'c:RoleType' }) | Should -Be 'RoleType'
    }
    It 'returns OrgType for an org reference' {
        Get-MidpointRefType -Ref ([pscustomobject]@{ oid = 'x'; type = 'OrgType' }) | Should -Be 'OrgType'
    }
}

# ─── Test-MidpointEnabled ─────────────────────────────────────────────────────
Describe 'Test-MidpointEnabled' {
    It 'returns true when activation.effectiveStatus is enabled' {
        Test-MidpointEnabled -Object ([pscustomobject]@{ activation = [pscustomobject]@{ effectiveStatus = 'enabled' } }) | Should -BeTrue
    }
    It 'returns false when effectiveStatus is disabled' {
        Test-MidpointEnabled -Object ([pscustomobject]@{ activation = [pscustomobject]@{ effectiveStatus = 'disabled' } }) | Should -BeFalse
    }
    It 'defaults to enabled when activation is absent' {
        Test-MidpointEnabled -Object ([pscustomobject]@{ name = 'x' }) | Should -BeTrue
    }
}

# ─── ConvertTo-MidpointObjectArray ────────────────────────────────────────────
Describe 'ConvertTo-MidpointObjectArray' {
    It 'returns the array for a multi-result search envelope' {
        $resp = [pscustomobject]@{ object = [pscustomobject]@{ object = @([pscustomobject]@{ oid = '1' }, [pscustomobject]@{ oid = '2' }) } }
        (ConvertTo-MidpointObjectArray -SearchResponse $resp).Count | Should -Be 2
    }
    It 'wraps a single-result envelope into a one-element array' {
        $resp = [pscustomobject]@{ object = [pscustomobject]@{ object = [pscustomobject]@{ oid = '1' } } }
        @(ConvertTo-MidpointObjectArray -SearchResponse $resp).Count | Should -Be 1
    }
    It 'returns empty for an empty envelope' {
        $resp = [pscustomobject]@{ object = [pscustomobject]@{ } }
        @(ConvertTo-MidpointObjectArray -SearchResponse $resp).Count | Should -Be 0
    }
}

# ─── Connect-MidpointAPI (no HTTP) ────────────────────────────────────────────
Describe 'Connect-MidpointAPI' {
    It 'builds a Basic auth header without any HTTP call' {
        { Connect-MidpointAPI -BaseUrl 'http://mp:8080/midpoint' -AuthMethod 'BasicAuth' -Username 'administrator' -Password 'pw' } | Should -Not -Throw
    }
    It 'throws when BasicAuth is missing credentials' {
        { Connect-MidpointAPI -BaseUrl 'http://mp:8080/midpoint' -AuthMethod 'BasicAuth' -Username 'administrator' } | Should -Throw
    }
    It 'accepts a static ApiToken without an HTTP call' {
        { Connect-MidpointAPI -BaseUrl 'http://mp:8080/midpoint' -AuthMethod 'ApiToken' -ApiToken 'tok' } | Should -Not -Throw
    }
}

# ─── Convert-MidpointOutcome ──────────────────────────────────────────────────
Describe 'Convert-MidpointOutcome' {
    It 'maps accept→Certify' { Convert-MidpointOutcome 'accept' | Should -Be 'Certify' }
    It 'maps revoke→Revoke' { Convert-MidpointOutcome 'revoke' | Should -Be 'Revoke' }
    It 'maps empty→NoDecision' { Convert-MidpointOutcome '' | Should -Be 'NoDecision' }
    It 'passes through an unknown outcome' { Convert-MidpointOutcome 'somethingElse' | Should -Be 'somethingElse' }
}

# ─── New-StableGuid ───────────────────────────────────────────────────────────
Describe 'New-StableGuid' {
    It 'is deterministic for the same seed' { (New-StableGuid 'camp|1') | Should -Be (New-StableGuid 'camp|1') }
    It 'differs for different seeds' { (New-StableGuid 'camp|1') | Should -Not -Be (New-StableGuid 'camp|2') }
    It 'produces a valid UUID' { (New-StableGuid 'x') | Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
}

# ─── Format-AccountLabel ──────────────────────────────────────────────────────
Describe 'Format-AccountLabel' {
    It 'extracts the CN from an LDAP DN' { Format-AccountLabel 'CN=Andrea Hill [ANDHIL@x.com],OU=Users,DC=x' | Should -Be 'Andrea Hill' }
    It 'leaves a plain string unchanged' { Format-AccountLabel 'JDOE' | Should -Be 'JDOE' }
}

# ─── Get-MidpointAttrValue ────────────────────────────────────────────────────
Describe 'Get-MidpointAttrValue' {
    It 'reads a ri:-prefixed typed-scalar attribute by unprefixed key' {
        $shadow = [pscustomobject]@{ attributes = [pscustomobject]@{ 'ri:fullName' = [pscustomobject]@{ '@value' = 'Jane Roe' } } }
        Get-MidpointAttrValue -Shadow $shadow -Keys @('fullName') | Should -Be 'Jane Roe'
    }
    It 'returns null when no key matches' {
        $shadow = [pscustomobject]@{ attributes = [pscustomobject]@{ 'ri:uid' = [pscustomobject]@{ '@value' = '314' } } }
        Get-MidpointAttrValue -Shadow $shadow -Keys @('fullName','cn') | Should -BeNullOrEmpty
    }
}

# ─── Fixture spec (seeder single source of truth) ─────────────────────────────
Describe 'Get-MidpointFixtureSpec' {
    It 'defines 3 orgs, 2 roles, 1 service, 3 users' {
        $s = Get-MidpointFixtureSpec
        $s.orgs.Count     | Should -Be 3
        $s.roles.Count    | Should -Be 2
        $s.services.Count | Should -Be 1
        $s.users.Count    | Should -Be 3
    }
    It 'uses valid-UUID fixed OIDs' {
        $uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        foreach ($u in (Get-MidpointFixtureSpec).users) { $u.oid | Should -Match $uuid }
    }
    It 'defines a certification campaign with 3 decided cases' {
        $c = (Get-MidpointFixtureSpec).campaign
        $c.oid | Should -Not -BeNullOrEmpty
        $c.cases.Count | Should -Be 3
        @($c.cases | Where-Object { $_.outcome -eq 'revoke' }).Count | Should -Be 1
    }
}

# ─── File structure ────────────────────────────────────────────────────────────
Describe 'midPoint file structure' {
    It 'crawler.json declares type midpoint and no OData dependency' {
        $m = Get-Content (Join-Path $script:midpointDir 'crawler.json') -Raw | ConvertFrom-Json
        $m.type | Should -Be 'midpoint'
        $m.entryPoint | Should -Be 'Start-MidpointCrawler.ps1'
        $m.dependsOn | Should -BeNullOrEmpty
    }
    It 'entry point exists and references Connect-MidpointAPI' {
        $p = Join-Path $script:midpointDir 'Start-MidpointCrawler.ps1'
        $p | Should -Exist
        (Get-Content $p -Raw) | Should -Match 'Connect-MidpointAPI'
    }
    It 'shadow search uses options=raw' {
        (Get-Content (Join-Path $script:midpointDir 'Start-MidpointCrawler.ps1') -Raw) | Should -Match "Options 'raw'"
    }
}
