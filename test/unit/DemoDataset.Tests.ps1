#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the Fortigi Demo Corp synthetic dataset generator.

.DESCRIPTION
    Regenerates the dataset from Generate-DemoDataset.ps1 (demo-company.json is a
    gitignored build artifact, so the test never relies on a stale copy) and
    validates the ContextMembers section: referential integrity, member shape,
    de-duplication, and that each department resolves — via the context tree — to
    a non-empty set of members. Without ContextMembers the synced Department/Team
    contexts are empty and the access matrix cannot be scoped by department, which
    is the product's headline view; these tests guard that regression.

.USAGE
    Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
    Invoke-Pester -Path test/unit/DemoDataset.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:genScript   = Join-Path $script:repoRoot 'test' 'demo-dataset' 'Generate-DemoDataset.ps1'
    $script:datasetPath = Join-Path $script:repoRoot 'test' 'demo-dataset' 'demo-company.json'

    # Regenerate deterministically so the assertions never depend on a stale artifact.
    & $script:genScript | Out-Null
    $script:data = Get-Content $script:datasetPath -Raw | ConvertFrom-Json

    # Lookups
    $script:ctxById      = @{}
    $script:ctxIdByName  = @{}
    foreach ($c in $script:data.contexts) {
        $script:ctxById[$c.id]         = $c
        $script:ctxIdByName[$c.displayName] = $c.id
    }
    $script:principalIds = @{}
    foreach ($p in $script:data.principals) { $script:principalIds[$p.id] = $true }

    # Parent -> children map, for walking a department down to its descendants.
    $script:childrenOf = @{}
    foreach ($c in $script:data.contexts) {
        if ($c.parentContextId) {
            if (-not $script:childrenOf.ContainsKey($c.parentContextId)) { $script:childrenOf[$c.parentContextId] = @() }
            $script:childrenOf[$c.parentContextId] += $c.id
        }
    }
    # Direct members per context.
    $script:membersByCtx = @{}
    foreach ($m in $script:data.contextMembers) {
        if (-not $script:membersByCtx.ContainsKey($m.contextId)) { $script:membersByCtx[$m.contextId] = @() }
        $script:membersByCtx[$m.contextId] += $m.memberId
    }

    # Resolve all distinct members of a context including every descendant context
    # (mirrors how the matrix resolves a department scope via the context tree).
    function Get-CtxMembersDeep {
        param([string]$CtxId)
        $acc   = @{}
        $stack = [System.Collections.Generic.Stack[string]]::new()
        $stack.Push($CtxId)
        while ($stack.Count -gt 0) {
            $id = $stack.Pop()
            foreach ($mid in $script:membersByCtx[$id]) { $acc[$mid] = $true }
            foreach ($ch  in $script:childrenOf[$id])   { $stack.Push($ch) }
        }
        return @($acc.Keys)
    }

    # Pre-compute validation collections + department counts for the It blocks.
    $script:badCtxRefs   = @($script:data.contextMembers | Where-Object { -not $script:ctxById.ContainsKey($_.contextId) })
    $script:badPrincRefs = @($script:data.contextMembers | Where-Object { -not $script:principalIds.ContainsKey($_.memberId) })
    $script:badShape     = @($script:data.contextMembers | Where-Object { $_.memberType -ne 'Principal' -or $_.addedBy -ne 'sync' })
    $script:pairs        = @($script:data.contextMembers | ForEach-Object { "$($_.contextId)|$($_.memberId)" })
    $script:deepCount    = @{}
    foreach ($name in @('Engineering', 'Finance', 'Sales', 'Operations')) {
        $script:deepCount[$name] = @(Get-CtxMembersDeep -CtxId $script:ctxIdByName[$name]).Count
    }
    $script:platformCount = @(Get-CtxMembersDeep -CtxId $script:ctxIdByName['Platform Team']).Count
}

Describe 'Demo dataset — context membership' {

    It 'includes a non-empty contextMembers section' {
        @($script:data.contextMembers).Count | Should -BeGreaterThan 0
    }

    It 'every context member references an existing context' {
        $script:badCtxRefs.Count | Should -Be 0
    }

    It 'every context member references an existing principal' {
        $script:badPrincRefs.Count | Should -Be 0
    }

    It 'every context member is a sync-added Principal member' {
        $script:badShape.Count | Should -Be 0
    }

    It 'has no duplicate (context, member) pairs' {
        ($script:pairs | Sort-Object -Unique).Count | Should -Be $script:pairs.Count
    }

    It 'resolves the Sales department to its 5 members' {
        $script:deepCount['Sales'] | Should -Be 5
    }

    It 'resolves the Engineering department to include its team members' {
        # Engineering direct members plus Platform/Security team members via the tree.
        $script:deepCount['Engineering'] | Should -BeGreaterOrEqual 9
        $script:platformCount | Should -BeGreaterThan 0
    }

    It 'gives every department at least one member' {
        foreach ($name in @('Engineering', 'Finance', 'Sales', 'Operations')) {
            $script:deepCount[$name] | Should -BeGreaterThan 0
        }
    }
}

Describe 'Demo dataset — zero-assignment edge case (#717)' {

    BeforeAll {
        # Zara Intern (E0031) is the deliberate "employee with no assignments" edge
        # case documented in docs/architecture/demo-dataset.md — a new hire not yet
        # provisioned. She must exist and be in the org, but hold zero access.
        $script:intern = $script:data.principals | Where-Object { $_.employeeId -eq 'E0031' }
        $script:internAssignments = @($script:data.resourceAssignments | Where-Object { $_.principalId -eq $script:intern.id })
        $script:internContexts    = @($script:data.contextMembers    | Where-Object { $_.memberId   -eq $script:intern.id })
    }

    It 'includes Zara Intern (E0031) as a principal' {
        $script:intern | Should -Not -BeNullOrEmpty
        $script:intern.displayName | Should -Be 'Zara Intern'
    }

    It 'gives the intern zero resource assignments (the documented edge case)' {
        $script:internAssignments.Count | Should -Be 0
    }

    It 'still places the intern in her department context (present in the org, just unprovisioned)' {
        $script:internContexts.Count | Should -BeGreaterThan 0
    }

    It 'keeps other engineers provisioned — the exclusion is scoped to the intern' {
        $eng = $script:data.principals | Where-Object { $_.employeeId -eq 'E0010' }
        @($script:data.resourceAssignments | Where-Object { $_.principalId -eq $eng.id }).Count | Should -BeGreaterThan 0
    }
}
