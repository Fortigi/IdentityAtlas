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
    foreach ($name in @('Engineering', 'Finance', 'Sales', 'Operations', 'Marketing')) {
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

    It 'resolves the Sales department to its 7 members' {
        # 6 active (CTF flag 1's answer) + Alex Former, the disabled leaver who
        # is the deliberate distractor. See DemoSalesScenario.ps1.
        $script:deepCount['Sales'] | Should -Be 7
    }

    It 'resolves the Engineering department to include its team members' {
        # Engineering direct members plus Platform/Security team members via the tree.
        $script:deepCount['Engineering'] | Should -BeGreaterOrEqual 9
        $script:platformCount | Should -BeGreaterThan 0
    }

    It 'gives every department at least one member' {
        foreach ($name in @('Engineering', 'Finance', 'Sales', 'Operations', 'Marketing')) {
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

Describe 'Demo dataset — group ownership (#713)' {

    BeforeAll {
        # v5 ownership: a Direct assignment on a synthetic GroupOwnership resource
        # (named after the owned group), linked by a HasOwnership relationship —
        # never the retired 'Owner' assignmentType.
        $script:ownershipResources = @($script:data.resources             | Where-Object { $_.resourceType   -eq 'GroupOwnership' })
        $script:ownershipRels      = @($script:data.resourceRelationships  | Where-Object { $_.relationshipType -eq 'HasOwnership' })
        $script:ownerAssignments   = @($script:data.resourceAssignments    | Where-Object { $_.resourceType   -eq 'GroupOwnership' })
        $script:resById            = @{}
        foreach ($r in $script:data.resources)  { $script:resById[$r.id]  = $r }
        $script:principalIdSet     = @{}
        foreach ($p in $script:data.principals) { $script:principalIdSet[$p.id] = $true }
    }

    It 'emits a GroupOwnership resource per owned group, tagged with the owned group' {
        $script:ownershipResources.Count | Should -BeGreaterThan 0
        foreach ($o in $script:ownershipResources) {
            $o.extendedAttributes.ownedResourceId | Should -Not -BeNullOrEmpty
            $script:resById.ContainsKey($o.extendedAttributes.ownedResourceId) | Should -BeTrue
        }
    }

    It 'links each ownership resource to its group via a HasOwnership relationship' {
        $script:ownershipRels.Count | Should -Be $script:ownershipResources.Count
        foreach ($rel in $script:ownershipRels) {
            $script:resById.ContainsKey($rel.parentResourceId) | Should -BeTrue   # the owned group
            $script:resById[$rel.childResourceId].resourceType | Should -Be 'GroupOwnership'
        }
    }

    It 'models each owner as a Direct assignment on the GroupOwnership resource' {
        $script:ownerAssignments.Count | Should -BeGreaterThan 0
        foreach ($a in $script:ownerAssignments) {
            $a.assignmentType | Should -Be 'Direct'
            $script:principalIdSet.ContainsKey($a.principalId) | Should -BeTrue
        }
    }

    It 'never emits the retired Owner assignmentType' {
        @($script:data.resourceAssignments | Where-Object { $_.assignmentType -eq 'Owner' }).Count | Should -Be 0
    }
}

Describe 'Demo dataset — Capture-the-Flag scenarios (#705)' {

    BeforeAll {
        $script:resByName = @{}
        foreach ($r in $script:data.resources) { $script:resByName[$r.displayName] = $r }
        $script:princByName = @{}
        foreach ($p in $script:data.principals) { $script:princByName[$p.displayName] = $p }

        # principalId -> resourceId -> assignmentType
        $script:heldBy = @{}
        foreach ($a in $script:data.resourceAssignments) {
            if (-not $script:heldBy.ContainsKey($a.principalId)) { $script:heldBy[$a.principalId] = @{} }
            $script:heldBy[$a.principalId][$a.resourceId] = $a.assignmentType
        }

        # The six active Sales principals (flag 1's answer).
        $script:salesPrincipals = @(
            $script:data.principals |
                Where-Object { $_.department -eq 'Sales' -and $_.accountEnabled -and $_.principalType -eq 'User' } |
                ForEach-Object { $_.id }
        )

        # Resources every active Sales member holds (flag 2's answer).
        $script:sharedSet = $null
        foreach ($p in $script:salesPrincipals) {
            $set = @($script:heldBy[$p].Keys)
            if ($null -eq $script:sharedSet) { $script:sharedSet = $set }
            else { $script:sharedSet = @($script:sharedSet | Where-Object { $set -contains $_ }) }
        }
    }

    It 'gives Sales exactly 6 active members, with a disabled leaver as the distractor (flag 1)' {
        $script:salesPrincipals.Count | Should -Be 6
        $script:princByName['Alex Former'].accountEnabled | Should -BeFalse
        $script:princByName['Alex Former'].department | Should -Be 'Sales'
    }

    It 'shares exactly 5 resources across all of Sales (flag 2)' {
        $script:sharedSet.Count | Should -Be 5
    }

    It 'gives exactly two out-of-department users the whole shared set (flag 3)' {
        $outsiders = @()
        foreach ($p in $script:heldBy.Keys) {
            if ($script:salesPrincipals -contains $p) { continue }
            $set = @($script:heldBy[$p].Keys)
            $hasAll = $true
            foreach ($s in $script:sharedSet) { if ($set -notcontains $s) { $hasAll = $false; break } }
            if ($hasAll) { $outsiders += $p }
        }
        $outsiders.Count | Should -Be 2
        $names = @($script:data.principals | Where-Object { $outsiders -contains $_.id } | ForEach-Object { $_.displayName } | Sort-Object)
        $names | Should -Be @('Nadia Haddad', 'Tom Bakker')
    }

    It 'gives Piet his CRM access only through BR-Sales, never directly (flag 4)' {
        $piet = $script:princByName['Piet Jansen'].id
        $crm  = $script:resByName['SG-CRM-Users'].id
        $mine = @($script:data.resourceAssignments | Where-Object { $_.principalId -eq $piet -and $_.resourceId -eq $crm })
        $mine.Count | Should -Be 1
        $mine[0].assignmentType | Should -Be 'Indirect'

        # ...and the Contains edge that explains WHY must exist, otherwise the
        # matrix has no path to show and the flag has no answer.
        $brSales = $script:resByName['BR-Sales'].id
        @($script:data.resourceRelationships | Where-Object {
            $_.parentResourceId -eq $brSales -and $_.childResourceId -eq $crm -and $_.relationshipType -eq 'Contains'
        }).Count | Should -Be 1
    }

    It 'makes exactly the two role-granted resources the role-based part of the shared set (flag 5)' {
        $brSales  = $script:resByName['BR-Sales'].id
        $contains = @($script:data.resourceRelationships |
            Where-Object { $_.parentResourceId -eq $brSales -and $_.relationshipType -eq 'Contains' } |
            ForEach-Object { $_.childResourceId })
        $names = @($script:sharedSet | Where-Object { $contains -contains $_ } |
            ForEach-Object { $rid = $_; ($script:data.resources | Where-Object { $_.id -eq $rid }).displayName } | Sort-Object)
        $names | Should -Be @('SG-CRM-Users', 'SG-Sales')
    }

    It 'holds the role candidate directly, by most of Sales, and keeps it out of the role (flag 6)' {
        $sp = $script:resByName['SG-Sales-SharePoint'].id
        $holders = @($script:data.resourceAssignments |
            Where-Object { $_.resourceId -eq $sp -and $_.assignmentType -eq 'Direct' })
        # Most, but not all — otherwise it would be part of the flag-2 shared set
        # rather than a mining candidate.
        $holders.Count | Should -Be 5
        $script:sharedSet | Should -Not -Contain $sp

        $brSales = $script:resByName['BR-Sales'].id
        @($script:data.resourceRelationships | Where-Object {
            $_.parentResourceId -eq $brSales -and $_.childResourceId -eq $sp
        }).Count | Should -Be 0
    }

    It 'makes the trap look like the candidate but cross the department boundary (flag 7)' {
        $trap = $script:resByName['SG-Finance-Reports'].id
        $holders = @($script:data.resourceAssignments | Where-Object { $_.resourceId -eq $trap })
        $depts = @($holders | ForEach-Object { $pid2 = $_.principalId
            ($script:data.principals | Where-Object { $_.id -eq $pid2 }).department } | Sort-Object -Unique)
        # It spans Sales AND Finance — that is the tell that separates it from
        # flag 6's clean, Sales-only candidate.
        $depts | Should -Contain 'Sales'
        $depts | Should -Contain 'Finance'
        # Not in the role, so it genuinely looks mineable.
        $brSales = $script:resByName['BR-Sales'].id
        @($script:data.resourceRelationships | Where-Object {
            $_.parentResourceId -eq $brSales -and $_.childResourceId -eq $trap
        }).Count | Should -Be 0
    }

    It 'skews SAP accounts to Finance and gives them no department of their own (flag 8)' {
        $sapSysId = ([array]::IndexOf(@($script:data.metadata.systemKeys.key), 'sap')) + 1
        $sapPrincipals = @($script:data.principals | Where-Object { $_.systemId -eq $sapSysId })
        $sapPrincipals.Count | Should -Be 10

        # The whole point of the flag: no department on the account, so the
        # answer is only reachable through identity correlation.
        @($sapPrincipals | Where-Object { $_.PSObject.Properties.Name -contains 'department' }).Count | Should -Be 0

        $identOf = @{}
        foreach ($m in $script:data.identityMembers) { $identOf[$m.principalId] = $m.identityId }
        $byDept = @{}
        foreach ($sp in $sapPrincipals) {
            $dept = ($script:data.identities | Where-Object { $_.id -eq $identOf[$sp.id] }).department
            if (-not $byDept.ContainsKey($dept)) { $byDept[$dept] = 0 }
            $byDept[$dept]++
        }
        $byDept['Finance'] | Should -Be 4
        # Close enough that you have to count, not guess.
        $byDept['Sales'] | Should -Be 3
        $byDept['Finance'] | Should -BeGreaterThan $byDept['Sales']
    }

    It 'marks exactly five accounts as never-expiring (flag 9)' {
        $ne = @($script:data.principals |
            Where-Object { $_.extendedAttributes -and $_.extendedAttributes.passwordNeverExpires -eq $true })
        $ne.Count | Should -Be 5
        @($ne | ForEach-Object { $_.displayName }) | Should -Contain 'Piet Jansen'
    }

    It 'puts three principals in Azure US and keeps an EU distractor (flag 10)' {
        $east = @($script:data.resources | Where-Object {
            $_.resourceType -eq 'AzureRoleAssignment' -and $_.extendedAttributes.azureLocation -eq 'eastus' })
        $west = @($script:data.resources | Where-Object {
            $_.resourceType -eq 'AzureRoleAssignment' -and $_.extendedAttributes.azureLocation -eq 'westeurope' })
        $east.Count | Should -BeGreaterThan 0
        $west.Count | Should -BeGreaterThan 0

        $eastIds = @($east | ForEach-Object { $_.id })
        $users = @($script:data.resourceAssignments |
            Where-Object { $eastIds -contains $_.resourceId } |
            ForEach-Object { $_.principalId } | Sort-Object -Unique)
        $users.Count | Should -Be 3
    }

    It 'shapes the consent grants the way the risky-consent plugin reads them (flags 11-12)' {
        $grants = @($script:data.resources | Where-Object { $_.resourceType -eq 'DelegatedPermission' })
        $grants.Count | Should -Be 2

        foreach ($g in $grants) {
            # The plugin reads ext.scope and joins ext.clientSpId -> Principals.
            # Either being absent silently drops the grant (issue #719's shape).
            $g.extendedAttributes.scope | Should -Not -BeNullOrEmpty
            $g.extendedAttributes.clientSpId | Should -Not -BeNullOrEmpty
            @($script:data.principals | Where-Object { $_.id -eq $g.extendedAttributes.clientSpId }).Count | Should -Be 1
        }

        # Files.ReadWrite.All is in the plugin's curated HIGH_RISK set, which is
        # what makes FileSync Pro deterministically risky with no LLM involved.
        $risky = @($grants | Where-Object { $_.extendedAttributes.scope -eq 'Files.ReadWrite.All' })
        $risky.Count | Should -Be 1
    }

    It 'answers flag 11 with five consenters and flag 12 with two — the trap being wider' {
        $risky = ($script:data.resources | Where-Object {
            $_.resourceType -eq 'DelegatedPermission' -and $_.extendedAttributes.scope -eq 'Files.ReadWrite.All' })
        $consenterIds = @($script:data.resourceAssignments |
            Where-Object { $_.resourceId -eq $risky.id } | ForEach-Object { $_.principalId })
        $consenterIds.Count | Should -Be 5

        $consenters = @($script:data.principals | Where-Object { $consenterIds -contains $_.id })
        $flag12 = @($consenters | Where-Object { $_.extendedAttributes.passwordNeverExpires -eq $true })
        @($flag12 | ForEach-Object { $_.displayName } | Sort-Object) | Should -Be @('Piet Jansen', 'Wendy Xu')

        # Anyone who ignores the "risky" half gets a bigger, wrong set — that is
        # what makes flag 12 a Pro flag rather than a filter.
        $allGrantIds = @($script:data.resources |
            Where-Object { $_.resourceType -eq 'DelegatedPermission' } | ForEach-Object { $_.id })
        $anyConsenterIds = @($script:data.resourceAssignments |
            Where-Object { $allGrantIds -contains $_.resourceId } | ForEach-Object { $_.principalId } | Sort-Object -Unique)
        $trap = @($script:data.principals |
            Where-Object { $anyConsenterIds -contains $_.id -and $_.extendedAttributes.passwordNeverExpires -eq $true })
        $trap.Count | Should -BeGreaterThan $flag12.Count
    }
}

Describe 'Demo dataset — one resource, two business roles (#370)' {

    # Catalogues overlap: the same group or app role is granted by more than one
    # business role. The matrix has to resolve that (a shared row survives until
    # every granting role is folded), so the dataset has to contain it — one
    # group and one application role, both granted twice. See
    # parts/DemoSharedGrants.ps1 and docs/architecture/matrix.md.
    BeforeAll {
        $script:sharedResByName = @{}
        foreach ($r in $script:data.resources) { $script:sharedResByName[$r.displayName] = $r }
        $script:sharedPrincByName = @{}
        foreach ($p in $script:data.principals) { $script:sharedPrincByName[$p.displayName] = $p }

        # childResourceId -> the parents that Contain it. A resource with two
        # entries here is one granted by two business roles.
        $script:containsByChild = @{}
        foreach ($rel in $script:data.resourceRelationships) {
            if ($rel.relationshipType -ne 'Contains') { continue }
            if (-not $script:containsByChild.ContainsKey($rel.childResourceId)) {
                $script:containsByChild[$rel.childResourceId] = @()
            }
            $script:containsByChild[$rel.childResourceId] += $rel.parentResourceId
        }
    }

    It 'grants one GROUP from two different business roles' {
        $tools = $script:sharedResByName['SG-Servicedesk-Tools']
        $tools.resourceType | Should -Be 'Group'
        @($script:containsByChild[$tools.id]).Count | Should -Be 2
    }

    It 'grants one APPLICATION ROLE from two different business roles' {
        $ticketing = $script:sharedResByName['Ticketing-Agent']
        $ticketing.resourceType | Should -Be 'AppRole'
        @($script:containsByChild[$ticketing.id]).Count | Should -Be 2
    }

    It 'gives each of the two roles a resource of its own, so folding one still hides a row' {
        foreach ($name in @('SG-Monitoring-Tools', 'SG-Servicedesk-KB')) {
            @($script:containsByChild[$script:sharedResByName[$name].id]).Count | Should -Be 1
        }
    }

    It 'stores a membership covered by two roles once — the overlap is coverage, not access' {
        $tools = $script:sharedResByName['SG-Servicedesk-Tools'].id
        foreach ($who in @('Victor Wang', 'Wendy Xu')) {
            $pid = $script:sharedPrincByName[$who].id
            @($script:data.resourceAssignments |
                Where-Object { $_.resourceId -eq $tools -and $_.principalId -eq $pid }).Count | Should -Be 1
        }
    }

    It 'gives one holder only the new role, so the shared rows are not the service desk alone' {
        $only = $script:sharedPrincByName['Fatih Gunay'].id
        $held = @($script:data.resourceAssignments | Where-Object { $_.principalId -eq $only } |
            ForEach-Object { $_.resourceId })
        $held | Should -Contain $script:sharedResByName['BR-IT-Operations'].id
        $held | Should -Not -Contain $script:sharedResByName['BR-Service-Desk'].id
        # ...and he holds the resources that role shares with the service desk.
        $held | Should -Contain $script:sharedResByName['SG-Servicedesk-Tools'].id
        $held | Should -Contain $script:sharedResByName['Ticketing-Agent'].id
    }
}

Describe 'Demo dataset — access held outside the role that grants it (#370)' {

    # BR-Engineering-Tools grants SG-VPN-Access, and the demo has to show both
    # sides of that: the engineers who hold it *through* the role (so the row
    # carries no provisioning gap) and the two SysAdmins who hold it without the
    # role at all (the cells the matrix marks red). See parts/DemoGovernance.ps1.
    BeforeAll {
        $script:vpnResByName = @{}
        foreach ($r in $script:data.resources) { $script:vpnResByName[$r.displayName] = $r }
        $script:vpnId  = $script:vpnResByName['SG-VPN-Access'].id
        $script:brEngId = $script:vpnResByName['BR-Engineering-Tools'].id
        $script:vpnHolders = @($script:data.resourceAssignments | Where-Object { $_.resourceId -eq $script:vpnId })
        $script:brEngHolders = @($script:data.resourceAssignments |
            Where-Object { $_.resourceId -eq $script:brEngId } | ForEach-Object { $_.principalId })
    }

    It 'materialises the VPN membership the role grants, so no role holder reads as a gap' {
        $script:brEngHolders.Count | Should -BeGreaterThan 0
        foreach ($holder in $script:brEngHolders) {
            @($script:vpnHolders | Where-Object { $_.principalId -eq $holder }).Count | Should -Be 1
        }
    }

    It 'emits the role-derived memberships as Indirect, and only those' {
        $viaRole = @($script:vpnHolders | Where-Object { $script:brEngHolders -contains $_.principalId })
        $viaRole.Count | Should -Be $script:brEngHolders.Count
        foreach ($a in $viaRole) { $a.assignmentType | Should -Be 'Indirect' }
    }

    It 'keeps two Direct memberships held by people who do not hold the role' {
        $outside = @($script:vpnHolders | Where-Object { $script:brEngHolders -notcontains $_.principalId })
        $outside.Count | Should -Be 2
        foreach ($a in $outside) { $a.assignmentType | Should -Be 'Direct' }

        $princById = @{}
        foreach ($p in $script:data.principals) { $princById[$p.id] = $p }
        @($outside | ForEach-Object { $princById[$_.principalId].displayName } | Sort-Object) |
            Should -Be @('Victor Wang', 'Wendy Xu')
    }
}

Describe 'Demo dataset — vendor-neutral IGA (#705)' {

    It 'names the governance system generically, not after a vendor' {
        # A business role is the same concept from Omada, midPoint or SailPoint,
        # so the demo must not imply one vendor. (The real Omada crawler under
        # tools/crawlers/omada/ is a separate thing and is unaffected.)
        @($script:data.systems | Where-Object { $_.systemType -eq 'IGA' }).Count | Should -Be 1
        @($script:data.systems | Where-Object { $_.systemType -eq 'Omada' }).Count | Should -Be 0
        @($script:data.identityMembers | Where-Object { $_.accountType -eq 'Omada' }).Count | Should -Be 0
    }

    It 'sources every business role from the IGA system' {
        $igaSysId = ([array]::IndexOf(@($script:data.metadata.systemKeys.key), 'iga')) + 1
        $roles = @($script:data.resources | Where-Object { $_.resourceType -eq 'BusinessRole' })
        $roles.Count | Should -Be 5
        foreach ($r in $roles) { $r.systemId | Should -Be $igaSysId }
    }
}

Describe 'Demo dataset — system id remapping (#705)' {

    It 'publishes a systemKeys index parallel to the systems array' {
        # Systems.id is SERIAL, so the generator emits placeholders and
        # Ingest-DemoDataset.ps1 remaps them to the ids the API hands back.
        # The index must line up with the systems array for that remap to work.
        @($script:data.metadata.systemKeys).Count | Should -Be @($script:data.systems).Count
        for ($i = 0; $i -lt @($script:data.systems).Count; $i++) {
            $script:data.metadata.systemKeys[$i].systemType | Should -Be $script:data.systems[$i].systemType
            $script:data.metadata.systemKeys[$i].tenantId   | Should -Be $script:data.systems[$i].tenantId
        }
    }

    It 'references only placeholder system ids that exist' {
        $valid = 1..(@($script:data.systems).Count)
        foreach ($r in $script:data.resources)  { $valid | Should -Contain $r.systemId }
        foreach ($p in $script:data.principals) { $valid | Should -Contain $p.systemId }
    }
}

Describe 'Demo dataset — always regenerated for the built-in demo crawler (fresh Docker)' {

    # Start-DemoCrawler.ps1 regenerates the dataset on every run via
    # `Generate-DemoDataset.ps1 -OutputPath <datasetPath>` instead of trusting a
    # possibly-stale on-disk copy. A bundled demo-company.json predating
    # metadata.systemKeys crashed Ingest-DemoDataset.ps1 ("Cannot index into a
    # null array") and left fresh Docker installs with only a few systems loaded.
    # This pins the exact mechanism the crawler now relies on.
    It 'writes a complete, ingest-ready dataset to an explicit -OutputPath' {
        $out = Join-Path $TestDrive 'demo-regen.json'
        & $script:genScript -OutputPath $out | Out-Null

        Test-Path $out | Should -BeTrue
        $fresh = Get-Content $out -Raw | ConvertFrom-Json

        # The section whose absence broke the ingest: one systemKeys entry per
        # system, each carrying the `key` the ingest indexes to map system ids.
        @($fresh.metadata.systemKeys).Count | Should -Be @($fresh.systems).Count
        foreach ($sk in $fresh.metadata.systemKeys) { $sk.key | Should -Not -BeNullOrEmpty }
    }
}
