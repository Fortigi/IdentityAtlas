<#
.SYNOPSIS
    Unit tests for Get-NestedGroupUserSet (tools/crawlers/shared/).

.DESCRIPTION
    The closure walk behind every crawler's Indirect-assignment materialisation.
    It used to exist twice — once in the Entra transform, once in the SCIM one —
    so it is now shared, and shared means it needs tests of its own rather than
    only being exercised sideways through two crawlers' transform tests.

    Inputs are chosen to DISCRIMINATE, per docs/contributing/writing-tests-that-assert.md:
    a walk that stopped at depth 1, one that ignored the visited set, and one
    that returned direct members only would each fail a different case below.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Get-NestedGroupUserSet.ps1')
}

Describe 'Get-NestedGroupUserSet' {

    It 'returns the users of the seed group itself' {
        $result = Get-NestedGroupUserSet -SeedGroups @('g1') `
            -ChildGroups @{} -DirectUsers @{ 'g1' = @('u1', 'u2') }
        @($result | Sort-Object) | Should -Be @('u1', 'u2')
    }

    It 'reaches users three levels down, not just the first child' {
        # A walk that only looked one level deep would return u1,u2 and miss u3.
        $children = @{ 'g1' = @('g2'); 'g2' = @('g3') }
        $users    = @{ 'g1' = @('u1'); 'g2' = @('u2'); 'g3' = @('u3') }
        $result = Get-NestedGroupUserSet -SeedGroups @('g1') -ChildGroups $children -DirectUsers $users
        @($result | Sort-Object) | Should -Be @('u1', 'u2', 'u3')
    }

    It 'de-duplicates a user reachable by two different paths' {
        # g1 → g2 → g4 and g1 → g3 → g4, with u-shared in g4.
        $children = @{ 'g1' = @('g2', 'g3'); 'g2' = @('g4'); 'g3' = @('g4') }
        $users    = @{ 'g4' = @('u-shared') }
        $result = Get-NestedGroupUserSet -SeedGroups @('g1') -ChildGroups $children -DirectUsers $users
        @($result) | Should -Be @('u-shared')
        $result.Count | Should -Be 1
    }

    It 'terminates on a membership cycle instead of looping forever' {
        # A → B → A is a shape real directories contain; without the visited set
        # this test would hang rather than fail.
        $children = @{ 'gA' = @('gB'); 'gB' = @('gA') }
        $users    = @{ 'gA' = @('uA'); 'gB' = @('uB') }
        $result = Get-NestedGroupUserSet -SeedGroups @('gA') -ChildGroups $children -DirectUsers $users
        @($result | Sort-Object) | Should -Be @('uA', 'uB')
    }

    It 'returns nothing for a group with no members and no children' {
        $result = Get-NestedGroupUserSet -SeedGroups @('empty') -ChildGroups @{} -DirectUsers @{}
        $result.Count | Should -Be 0
    }

    It 'walks every seed group, not only the first' {
        $users = @{ 'g1' = @('u1'); 'g2' = @('u2') }
        $result = Get-NestedGroupUserSet -SeedGroups @('g1', 'g2') -ChildGroups @{} -DirectUsers $users
        @($result | Sort-Object) | Should -Be @('u1', 'u2')
    }

    It 'skips a child group that has no entry in DirectUsers without failing' {
        $children = @{ 'g1' = @('g2') }
        $result = Get-NestedGroupUserSet -SeedGroups @('g1') -ChildGroups $children -DirectUsers @{ 'g1' = @('u1') }
        @($result) | Should -Be @('u1')
    }
}
