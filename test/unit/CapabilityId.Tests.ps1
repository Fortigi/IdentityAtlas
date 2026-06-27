#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit + cross-language conformance tests for Get-CapabilityId.

.DESCRIPTION
    Verifies tools/crawlers/shared/Get-CapabilityId.ps1 against a table of GOLDEN VECTORS.
    The same golden vectors are pinned in the JS test for app/api/src/lib/capabilityId.js;
    pinning both runtimes to one table is what guarantees that engine-synthesized ids and
    crawler-written ids are byte-identical (see docs/architecture/effective-access-engine.md §11).

    If you ever change the id algorithm, you must regenerate the goldens in BOTH test files
    together — a divergence here is a release blocker, not a flaky test.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/CapabilityId.Tests.ps1 -Output Detailed
#>

# Top-level (discovery-time) so -ForEach can see it. MUST match the JS test's golden table.
$goldens = @(
    @{ t = 'node-a'; c = 'cap-x'; expected = '70cf03d4-00b5-d607-b0fa-c28f37cc363f' }
    @{ t = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg1'
       c = 'b24988ac-6180-42a0-ab88-20f7382dd24c'; expected = 'fb4cd3b4-6fdd-8dbc-4cba-46376ef8bc65' }
    @{ t = 'C:\Finance'; c = 'Write'; expected = 'ded9f1e4-b426-7bf9-a4e9-68cb2e9758bd' }
    @{ t = 'a'; c = 'b'; expected = '0eab8a0a-3380-abf4-c7d1-fb0b43b66aaf' }
    @{ t = 'café'; c = 'rôle'; expected = '50c1f141-9d52-c66f-1ca8-04ebef754098' }  # UTF-8 multibyte
    @{ t = 'Привет'; c = 'роль';     expected = '5979aa3b-4757-56cd-eff2-98f32bf23c7a' }  # Cyrillic
    @{ t = '財務部';  c = '書き込み'; expected = '12cea6f4-05e5-f34f-9c58-8ea9fa5ccf82' }  # CJK
    @{ t = 'مرحبا';   c = 'مدير';     expected = 'e66813b8-93da-557d-cf32-d9cb0bc0c69e' }  # Arabic (RTL)
    @{ t = '🔐lock';  c = '✏️edit';   expected = 'cf0f8181-eb90-75bb-4655-071b608d1f1e' }  # emoji / surrogate pairs
)

BeforeAll {
    $repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $repoRoot 'tools' 'crawlers' 'shared' 'Get-CapabilityId.ps1')
}

Describe 'Get-CapabilityId' {

    It 'computes the golden id for "<t>" | "<c>"' -ForEach $goldens {
        Get-CapabilityId -TargetNodeId $t -CapabilityId $c | Should -Be $expected
    }

    It 'produces UUID-shaped output' {
        Get-CapabilityId -TargetNodeId 'x' -CapabilityId 'y' |
            Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    }

    It 'is deterministic (same input -> same id)' {
        $first  = Get-CapabilityId -TargetNodeId 'x' -CapabilityId 'y'
        $second = Get-CapabilityId -TargetNodeId 'x' -CapabilityId 'y'
        $first | Should -Be $second
    }

    It 'does not collide across the separator boundary' {
        # ("ab","c") and ("a","bc") would collide if the separator were dropped; they must not.
        $left  = Get-CapabilityId -TargetNodeId 'ab' -CapabilityId 'c'
        $right = Get-CapabilityId -TargetNodeId 'a'  -CapabilityId 'bc'
        $left | Should -Not -Be $right
    }

    It 'throws when TargetNodeId contains the reserved separator' {
        { Get-CapabilityId -TargetNodeId 'a|b' -CapabilityId 'c' } | Should -Throw
    }

    It 'throws when CapabilityId contains the reserved separator' {
        { Get-CapabilityId -TargetNodeId 'a' -CapabilityId 'b|c' } | Should -Throw
    }
}
