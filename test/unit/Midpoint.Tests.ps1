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
    . (Join-Path $script:midpointDir 'dev' 'Seed-MidpointLoadData.ps1')
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

# ─── Get-MidpointStringList ───────────────────────────────────────────────────
Describe 'Get-MidpointStringList' {
    It 'returns an empty array for null' {
        ,(Get-MidpointStringList $null) | Should -BeOfType [System.Array]
        (Get-MidpointStringList $null).Count | Should -Be 0
    }
    It 'returns all values of a multi-valued field (PolyString + string), dropping nulls' {
        $r = Get-MidpointStringList @(([pscustomobject]@{ orig = 'A' }), 'B', $null)
        $r | Should -Be @('A', 'B')
    }
    It 'wraps a single scalar as a one-element array' {
        (Get-MidpointStringList 'solo') | Should -Be @('solo')
    }
}

# ─── ConvertTo-MapRows ────────────────────────────────────────────────────────
Describe 'ConvertTo-MapRows' {
    It 'returns an empty array for null input' {
        (ConvertTo-MapRows $null @('a')).Count | Should -Be 0
    }
    It 'normalises and trims declared keys, blanking missing ones' {
        $rows = ConvertTo-MapRows @(@{ archetype = '  App  '; resourceType = 'Application' }) @('archetype', 'subtype', 'resourceType')
        $rows[0].archetype    | Should -Be 'App'
        $rows[0].subtype      | Should -Be ''
        $rows[0].resourceType | Should -Be 'Application'
    }
}

# ─── Resolve-MappedResourceType (role/service classification) ─────────────────
Describe 'Resolve-MappedResourceType' {
    BeforeAll {
        $script:defaultRows = ConvertTo-MapRows @(@{ archetype = ''; subtype = ''; resourceType = 'BusinessRole' }) @('archetype', 'subtype', 'resourceType')
        $script:archRows = ConvertTo-MapRows @(
            @{ archetype = 'Application Role'; subtype = ''; resourceType = 'Application' },
            @{ archetype = ''; subtype = 'it'; resourceType = 'Resource' },
            @{ archetype = ''; subtype = ''; resourceType = 'BusinessRole' }
        ) @('archetype', 'subtype', 'resourceType')
    }
    It 'falls back to the per-phase default when no rows match (empty rule set)' {
        Resolve-MappedResourceType -Rows @() -ArchetypeNames @('X') -Subtypes @() -Default 'Service' | Should -Be 'Service'
    }
    It 'returns the catch-all resourceType for a default single-row config' {
        Resolve-MappedResourceType -Rows $script:defaultRows -ArchetypeNames @('Whatever') -Subtypes @('any') -Default 'BusinessRole' | Should -Be 'BusinessRole'
    }
    It 'matches on archetype before subtype' {
        Resolve-MappedResourceType -Rows $script:archRows -ArchetypeNames @('Application Role') -Subtypes @('it') -Default 'BusinessRole' | Should -Be 'Application'
    }
    It 'falls back to subtype when no archetype matches' {
        Resolve-MappedResourceType -Rows $script:archRows -ArchetypeNames @('Business Role') -Subtypes @('it') -Default 'BusinessRole' | Should -Be 'Resource'
    }
    It 'uses the catch-all when neither archetype nor subtype matches' {
        Resolve-MappedResourceType -Rows $script:archRows -ArchetypeNames @('Business Role') -Subtypes @('other') -Default 'X' | Should -Be 'BusinessRole'
    }
    It 'matches archetype case-insensitively' {
        Resolve-MappedResourceType -Rows $script:archRows -ArchetypeNames @('application role') -Subtypes @() -Default 'BusinessRole' | Should -Be 'Application'
    }
}

# ─── Resolve-MappedValue (org→contextType, user→principalType) ────────────────
Describe 'Resolve-MappedValue' {
    BeforeAll {
        $script:orgRows = ConvertTo-MapRows @(
            @{ orgSubtype = 'dept'; contextType = 'Department' },
            @{ orgSubtype = ''; contextType = 'OrgUnit' }
        ) @('orgSubtype', 'contextType')
    }
    It 'returns the value of the matching row' {
        Resolve-MappedValue -Values @('dept') -Rows $script:orgRows -KeyName 'orgSubtype' -ValName 'contextType' -Default 'OrgUnit' | Should -Be 'Department'
    }
    It 'returns the catch-all (blank key) when no value matches' {
        Resolve-MappedValue -Values @('zzz') -Rows $script:orgRows -KeyName 'orgSubtype' -ValName 'contextType' -Default 'OrgUnit' | Should -Be 'OrgUnit'
    }
    It 'returns the default when there is no catch-all and nothing matches' {
        $rows = ConvertTo-MapRows @(@{ orgSubtype = 'dept'; contextType = 'Department' }) @('orgSubtype', 'contextType')
        Resolve-MappedValue -Values @('zzz') -Rows $rows -KeyName 'orgSubtype' -ValName 'contextType' -Default 'OrgUnit' | Should -Be 'OrgUnit'
    }
}

# ─── Get-MidpointArchetypeNames ───────────────────────────────────────────────
Describe 'Get-MidpointArchetypeNames' {
    It 'resolves archetypeRef oids to catalog labels' {
        $labels = @{ 'oid-1' = @('Business Role'); 'oid-2' = @('Application Role') }
        $obj = [pscustomobject]@{ archetypeRef = @([pscustomobject]@{ oid = 'oid-2'; type = 'ArchetypeType' }) }
        Get-MidpointArchetypeNames -Obj $obj -LabelsByOid $labels | Should -Be @('Application Role')
    }
    It 'returns an empty array when the object has no archetypeRef' {
        (Get-MidpointArchetypeNames -Obj ([pscustomobject]@{}) -LabelsByOid @{}).Count | Should -Be 0
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

# ─── Test-MidpointDefaultRelation ─────────────────────────────────────────────
Describe 'Test-MidpointDefaultRelation' {
    It 'treats an absent/empty relation as default (full membership)' {
        Test-MidpointDefaultRelation '' | Should -BeTrue
        Test-MidpointDefaultRelation $null | Should -BeTrue
    }
    It 'treats the bare token "default" as default' {
        Test-MidpointDefaultRelation 'default' | Should -BeTrue
    }
    It 'treats any QName ending in :default as default' {
        Test-MidpointDefaultRelation 'org:default' | Should -BeTrue
    }
    It 'rejects governance relations (manager/owner/approver/meta)' {
        Test-MidpointDefaultRelation 'org:manager'  | Should -BeFalse
        Test-MidpointDefaultRelation 'org:owner'    | Should -BeFalse
        Test-MidpointDefaultRelation 'org:approver' | Should -BeFalse
        Test-MidpointDefaultRelation 'org:meta'     | Should -BeFalse
    }
}

# ─── ConvertTo-MidpointDnKey ──────────────────────────────────────────────────
Describe 'ConvertTo-MidpointDnKey' {
    It 'lower-cases and trims a DN so case/whitespace differences still match' {
        ConvertTo-MidpointDnKey '  CN=DM - Read Documents,OU=Groups,DC=corporate,DC=com  ' |
            Should -Be 'cn=dm - read documents,ou=groups,dc=corporate,dc=com'
    }
    It 'returns empty for null/blank' {
        ConvertTo-MidpointDnKey $null | Should -Be ''
        ConvertTo-MidpointDnKey '   ' | Should -Be ''
    }
}

# ─── Get-MidpointConstructionTargets ──────────────────────────────────────────
Describe 'Get-MidpointConstructionTargets' {
    It 'extracts an associationTargetSearch DN filter as a normalised search key' {
        $con = [pscustomobject]@{ association = [pscustomobject]@{
            ref = 'ri:group'
            outbound = [pscustomobject]@{ expression = [pscustomobject]@{
                associationTargetSearch = [pscustomobject]@{ filter = [pscustomobject]@{
                    equal = [pscustomobject]@{ path = 'attributes/ri:dn'; value = 'CN=DM - Read Documents,OU=Groups,DC=corporate,DC=com' }
                } }
            } }
        } }
        $t = @(Get-MidpointConstructionTargets -Construction $con)
        $t.Count | Should -Be 1
        $t[0].shadowOid | Should -Be ''
        $t[0].searchKey | Should -Be 'cn=dm - read documents,ou=groups,dc=corporate,dc=com'
    }
    It 'extracts a literal shadowRef oid' {
        $con = [pscustomobject]@{ association = [pscustomobject]@{
            ref = 'ri:group'; shadowRef = [pscustomobject]@{ oid = 'ent-9'; type = 'c:ShadowType' }
        } }
        $t = @(Get-MidpointConstructionTargets -Construction $con)
        $t.Count | Should -Be 1
        $t[0].shadowOid | Should -Be 'ent-9'
        $t[0].searchKey | Should -Be ''
    }
    It 'handles multiple associations (array)' {
        $con = [pscustomobject]@{ association = @(
            [pscustomobject]@{ ref = 'ri:group'; shadowRef = [pscustomobject]@{ oid = 'ent-a' } }
            [pscustomobject]@{ ref = 'ri:group'; outbound = [pscustomobject]@{ expression = [pscustomobject]@{
                associationTargetSearch = [pscustomobject]@{ filter = [pscustomobject]@{ equal = [pscustomobject]@{ path = 'attributes/ri:dn'; value = 'CN=B,DC=x' } } } } } }
        ) }
        $t = @(Get-MidpointConstructionTargets -Construction $con)
        $t.Count | Should -Be 2
        $t[0].shadowOid | Should -Be 'ent-a'
        $t[1].searchKey | Should -Be 'cn=b,dc=x'
    }
    It 'returns an empty list for a null construction or one with no association' {
        (Get-MidpointConstructionTargets -Construction $null).Count | Should -Be 0
        (Get-MidpointConstructionTargets -Construction ([pscustomobject]@{ kind = 'account' })).Count | Should -Be 0
    }
}

# ─── Resolve-MidpointDepartment ───────────────────────────────────────────────
Describe 'Resolve-MidpointDepartment' {
    BeforeAll {
        $script:orgMap = @{
            'org-hr'    = 'HR'
            'org-it'    = 'IT'
            'org-board' = 'Board'
        }
    }
    It 'resolves a single org membership to its display name' {
        $u = [pscustomobject]@{ parentOrgRef = [pscustomobject]@{ oid = 'org-hr'; type = 'c:OrgType' } }
        Resolve-MidpointDepartment -User $u -OrgMap $script:orgMap | Should -Be 'HR'
    }
    It 'treats an absent relation as the default org' {
        $u = [pscustomobject]@{ parentOrgRef = [pscustomobject]@{ oid = 'org-it' } }
        Resolve-MidpointDepartment -User $u -OrgMap $script:orgMap | Should -Be 'IT'
    }
    It 'prefers the org:default ref over a manager/meta ref' {
        $u = [pscustomobject]@{ parentOrgRef = @(
            [pscustomobject]@{ oid = 'org-board'; relation = 'org:manager' },
            [pscustomobject]@{ oid = 'org-hr';    relation = 'org:default' }
        ) }
        Resolve-MidpointDepartment -User $u -OrgMap $script:orgMap | Should -Be 'HR'
    }
    It 'matches a bare "default" relation too' {
        $u = [pscustomobject]@{ parentOrgRef = [pscustomobject]@{ oid = 'org-it'; relation = 'default' } }
        Resolve-MidpointDepartment -User $u -OrgMap $script:orgMap | Should -Be 'IT'
    }
    It 'falls back to the first ref when no default-relation org is present' {
        $u = [pscustomobject]@{ parentOrgRef = @(
            [pscustomobject]@{ oid = 'org-it';    relation = 'org:manager' },
            [pscustomobject]@{ oid = 'org-board'; relation = 'org:meta' }
        ) }
        Resolve-MidpointDepartment -User $u -OrgMap $script:orgMap | Should -Be 'IT'
    }
    It 'returns empty when the user has no org membership' {
        $u = [pscustomobject]@{ name = 'lonely' }
        Resolve-MidpointDepartment -User $u -OrgMap $script:orgMap | Should -Be ''
    }
    It 'returns empty when the org was not synced (not in the map)' {
        $u = [pscustomobject]@{ parentOrgRef = [pscustomobject]@{ oid = 'org-unknown'; relation = 'org:default' } }
        Resolve-MidpointDepartment -User $u -OrgMap $script:orgMap | Should -Be ''
    }
    It 'returns empty for a null user without throwing' {
        { Resolve-MidpointDepartment -User $null -OrgMap $script:orgMap } | Should -Not -Throw
        Resolve-MidpointDepartment -User $null -OrgMap $script:orgMap | Should -Be ''
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


# ─── Load-test seeder: tiers & OID scheme ────────────────────────────────────
Describe 'Get-MidpointLoadSpec' {
    It 'defines the three ramp tiers with the expected scale' {
        (Get-MidpointLoadSpec -Tier T1).users       | Should -Be 250
        (Get-MidpointLoadSpec -Tier T2).groups      | Should -Be 5000
        (Get-MidpointLoadSpec -Tier T3).memberships | Should -Be 300000
    }
    It 'uses the 1b… OID block, disjoint from IA-Test (1a…)' {
        (Get-MidpointLoadSpec -Tier T3).resourceOid | Should -Match '^1b000000-'
    }
}

Describe 'Get-LoadOid' {
    It 'builds a valid UUID from a prefix + index' {
        Get-LoadOid -Prefix '0001' -Index 0 | Should -Be '1b000000-0000-4000-8000-000100000000'
        Get-LoadOid -Prefix '0003' -Index 42 | Should -Be '1b000000-0000-4000-8000-00030000002a'
        Get-LoadOid -Prefix '0001' -Index 5 | Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    }
}

# ─── Load-test distribution (pure, deterministic) ─────────────────────────────
Describe 'Get-LoadAssignmentPlan' {
    BeforeAll { $script:plan = Get-LoadAssignmentPlan -Users 40 -Groups 200 -Memberships 2000 -Seed 1337 }

    It 'produces exactly the requested number of memberships' {
        $script:plan.Total | Should -Be 2000
    }
    It 'is deterministic for the same seed' {
        $a = Get-LoadAssignmentPlan -Users 40 -Groups 200 -Memberships 2000 -Seed 1337
        $b = Get-LoadAssignmentPlan -Users 40 -Groups 200 -Memberships 2000 -Seed 1337
        $a.Total | Should -Be $b.Total
        (Compare-Object $a.UserGroups[3] $b.UserGroups[3]) | Should -BeNullOrEmpty
    }
    It 'never assigns a user more groups than exist (no over-clamping bug)' {
        $script:plan.MaxPerUser | Should -BeLessOrEqual 200
    }
    It 'never assigns a group more members than there are users' {
        $script:plan.MaxPerGroup | Should -BeLessOrEqual 40
    }
    It 'each user belongs to a DISTINCT set of groups (no duplicates)' {
        foreach ($g in $script:plan.UserGroups) {
            ($g | Select-Object -Unique).Count | Should -Be $g.Count
        }
    }
    It 'is realistically skewed — a few universal groups hold everyone' {
        $script:plan.UniversalGroups | Should -BeGreaterThan 0
        $script:plan.MaxPerGroup | Should -Be 40
    }
    It 'throws when memberships exceed Users*Groups capacity' {
        { Get-LoadAssignmentPlan -Users 10 -Groups 10 -Memberships 200 } | Should -Throw
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
        # The shadow streaming moved into the Sync-Midpoint* phases
        # (MidpointCrawler.Phases.ps1); read it too so the assertion tracks the code.
        ((Get-Content (Join-Path $script:midpointDir 'Start-MidpointCrawler.ps1') -Raw) +
         (Get-Content (Join-Path $script:midpointDir 'MidpointCrawler.Phases.ps1') -Raw)) | Should -Match "Options 'raw'"
    }
    It 'dev/ folder contains load seeder and README' {
        Join-Path $script:midpointDir 'dev' 'Seed-MidpointLoadData.ps1' | Should -Exist
        Join-Path $script:midpointDir 'dev' 'README.md'                  | Should -Exist
    }
}
