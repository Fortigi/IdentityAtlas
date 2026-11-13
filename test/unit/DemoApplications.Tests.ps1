#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester tests for the demo dataset's logical applications
    (test/demo-dataset/parts/DemoApplications.ps1).

.DESCRIPTION
    Regenerates the standard dataset and checks the application story the
    context pages are demonstrated with: which applications exist, what they
    hold, who answers for them — and, for those nobody answers for yet, that the
    ownership data really does (or really does not) produce the API's best guess.

    The best guess is recomputed here the way the API computes it
    (app/api/src/contexts/roleSuggestion.js OWNER_SQL): the holders of the
    ownership resources linked from a member, counted per distinct member, over
    all members, against a 40 % threshold. If the data drifts below the
    threshold the demo silently loses its suggestion; these tests are what
    notices.

.USAGE
    Invoke-Pester -Path test/unit/DemoApplications.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:demoDir    = Join-Path $script:repoRoot 'test' 'demo-dataset'
    $script:genScript  = Join-Path $script:demoDir 'Generate-DemoDataset.ps1'
    $script:outPath    = Join-Path ([System.IO.Path]::GetTempPath()) "demo-apps-$([guid]::NewGuid()).json"
    $script:outPath2   = Join-Path ([System.IO.Path]::GetTempPath()) "demo-apps-$([guid]::NewGuid()).json"

    & $script:genScript -OutputPath $script:outPath | Out-Null
    $script:data = Get-Content $script:outPath -Raw | ConvertFrom-Json

    $script:igaSystemId = 1 + [array]::IndexOf(@($script:data.metadata.systemKeys.key), 'iga')
    $script:hrSystemId  = 1 + [array]::IndexOf(@($script:data.metadata.systemKeys.key), 'hr')

    $script:ctxById = @{}
    foreach ($c in $script:data.contexts) { $script:ctxById[$c.id] = $c }
    $script:apps = @($script:data.contexts | Where-Object { $_.contextType -eq 'LogicalApplication' })
    $script:appByName = @{}
    foreach ($a in $script:apps) { $script:appByName[$a.displayName] = $a }

    $script:resById = @{}
    foreach ($r in $script:data.resources) { $script:resById[$r.id] = $r }
    $script:principalById = @{}
    foreach ($p in $script:data.principals) { $script:principalById[$p.id] = $p }

    $script:membersOf = @{}
    foreach ($m in $script:data.contextMembers) {
        if (-not $script:membersOf.ContainsKey($m.contextId)) { $script:membersOf[$m.contextId] = @() }
        $script:membersOf[$m.contextId] += $m
    }
    $script:rolesOf = @{}
    foreach ($r in $script:data.contextRoles) {
        if (-not $script:rolesOf.ContainsKey($r.contextId)) { $script:rolesOf[$r.contextId] = @() }
        $script:rolesOf[$r.contextId] += $r
    }

    # Ownership walk, as OWNER_SQL makes it: member -[HasOwnership|HasAppOwnership]->
    # ownership resource -[Direct assignment]-> holder.
    $ownershipTypes = @('GroupOwnership', 'ServicePrincipalOwnership', 'ApplicationOwnership')
    $script:ownersOfResource = @{}
    foreach ($rel in $script:data.resourceRelationships) {
        if ($rel.relationshipType -notin @('HasOwnership', 'HasAppOwnership')) { continue }
        if ($script:resById[$rel.childResourceId].resourceType -notin $ownershipTypes) { continue }
        $holders = @($script:data.resourceAssignments | Where-Object {
            $_.resourceId -eq $rel.childResourceId -and $_.assignmentType -eq 'Direct'
        } | ForEach-Object { $_.principalId })
        $script:ownersOfResource[$rel.parentResourceId] = @($script:ownersOfResource[$rel.parentResourceId]) + $holders | Where-Object { $_ }
    }

    # The best owner of an application's members: { Name, Count, Total, Share }.
    function Get-BestOwner {
        param([string]$ContextId)
        $members = @($script:membersOf[$ContextId] | Where-Object { $_.memberType -eq 'Resource' })
        $count = @{}
        foreach ($m in $members) {
            foreach ($holder in @($script:ownersOfResource[$m.memberId] | Select-Object -Unique)) {
                $count[$holder] = 1 + [int]$count[$holder]
            }
        }
        $best = $count.GetEnumerator() |
            Sort-Object -Property @{ Expression = 'Value'; Descending = $true }, @{ Expression = { $script:principalById[$_.Key].displayName } } |
            Select-Object -First 1
        if (-not $best) { return [pscustomobject]@{ Name = $null; Count = 0; Total = $members.Count; Share = 0 } }
        return [pscustomobject]@{
            Name  = $script:principalById[$best.Key].displayName
            Count = $best.Value
            Total = $members.Count
            Share = $best.Value / $members.Count
        }
    }

    function Get-RoleHolders {
        param([string]$AppName, [string]$Role)
        return @($script:rolesOf[$script:appByName[$AppName].id] | Where-Object { $_.role -eq $Role } |
            ForEach-Object { $script:principalById[$_.principalId].displayName } | Sort-Object)
    }
}

AfterAll {
    foreach ($p in @($script:outPath, $script:outPath2)) {
        if ($p -and (Test-Path $p)) { Remove-Item $p -Force }
    }
}

Describe 'Demo applications — the catalogue' {

    It 'adds seven applications, named as the demo story tells them' {
        @($script:apps.displayName | Sort-Object) | Should -Be @(
            'Customer Relationship Management', 'Employee Portal & Intranet', 'Engineering Platform',
            'IT Service Management', 'Privileged Access Management', 'SAP ERP', 'SAP ERP – Financial Accounting'
        )
    }

    It 'makes every application a synced resource context owned by the IGA system' {
        foreach ($a in $script:apps) {
            $a.targetType    | Should -Be 'Resource'
            $a.variant       | Should -Be 'synced'
            $a.scopeSystemId | Should -Be $script:igaSystemId
        }
        $script:igaSystemId | Should -Not -Be $script:hrSystemId
    }

    It 'gives every application its own catalogue reference and a description' {
        @($script:apps.externalId | Sort-Object -Unique).Count | Should -Be $script:apps.Count
        foreach ($a in $script:apps) {
            $a.externalId  | Should -Match '^APP-\d{4}$'
            $a.description | Should -Not -BeNullOrEmpty
        }
    }

    It 'nests the finance module under SAP ERP, and only that one' {
        $script:appByName['SAP ERP – Financial Accounting'].parentContextId | Should -Be $script:appByName['SAP ERP'].id
        @($script:apps | Where-Object { $_.PSObject.Properties.Name -contains 'parentContextId' }).Count | Should -Be 1
    }

    It 'gives every application 3 to 15 members, each an existing access-granting resource' {
        foreach ($a in $script:apps) {
            $members = @($script:membersOf[$a.id])
            $members.Count | Should -BeGreaterOrEqual 3 -Because $a.displayName
            $members.Count | Should -BeLessOrEqual 15 -Because $a.displayName
            foreach ($m in $members) {
                $m.memberType | Should -Be 'Resource'
                $script:resById.ContainsKey($m.memberId) | Should -BeTrue -Because "$($a.displayName) member $($m.memberId)"
                $script:resById[$m.memberId].resourceType | Should -Not -Be 'GroupOwnership'
            }
        }
    }

    It 'puts the SAP roles in SAP ERP and its finance module' {
        $sapRoles = @($script:data.resources | Where-Object { $_.resourceType -eq 'SAPRole' } | ForEach-Object { $_.id })
        $inSap = @(@($script:membersOf[$script:appByName['SAP ERP'].id]) + @($script:membersOf[$script:appByName['SAP ERP – Financial Accounting'].id]) |
            ForEach-Object { $_.memberId })
        foreach ($id in $sapRoles) { $inSap -contains $id | Should -BeTrue }
    }
}

Describe 'Demo applications — who answers for them' {

    It 'sets an Accountable on exactly three applications' {
        @(Get-RoleHolders 'SAP ERP' 'Accountable')                          | Should -Be @('Clara Dijkstra')
        @(Get-RoleHolders 'Customer Relationship Management' 'Accountable') | Should -Be @('David El-Amin')
        @(Get-RoleHolders 'Engineering Platform' 'Accountable')             | Should -Be @('Bob Chen')
        @($script:data.contextRoles | Where-Object { $_.role -eq 'Accountable' }).Count | Should -Be 3
    }

    It 'gives each of those one or two Responsible' {
        @(Get-RoleHolders 'SAP ERP' 'Responsible')                          | Should -Be @('Victor Wang')
        @(Get-RoleHolders 'Customer Relationship Management' 'Responsible') | Should -Be @('Paul Quinn')
        @(Get-RoleHolders 'Engineering Platform' 'Responsible')             | Should -Be @('Fatih Gunay', 'Victor Wang')
    }

    It 'points every role at an existing Entra account and an application context' {
        foreach ($r in $script:data.contextRoles) {
            $script:principalById.ContainsKey($r.principalId) | Should -BeTrue
            $script:principalById[$r.principalId].principalType | Should -Be 'User'
            $script:ctxById[$r.contextId].contextType | Should -Be 'LogicalApplication'
        }
    }

    It 'never sets roles on the applications left for the best guess or the empty state' {
        foreach ($name in @('SAP ERP – Financial Accounting', 'IT Service Management', 'Privileged Access Management', 'Employee Portal & Intranet')) {
            $script:rolesOf.ContainsKey($script:appByName[$name].id) | Should -BeFalse -Because $name
        }
    }
}

Describe 'Demo applications — the best-guess owner' {

    It 'suggests Maria Novak for the finance module: she owns 2 of its 4 resources' {
        $best = Get-BestOwner $script:appByName['SAP ERP – Financial Accounting'].id
        $best.Name  | Should -Be 'Maria Novak'
        $best.Count | Should -Be 2
        $best.Total | Should -Be 4
        $best.Share | Should -BeGreaterOrEqual 0.4
    }

    It 'suggests Eva Fischer for IT Service Management: 3 of 5, ahead of the second owner' {
        $best = Get-BestOwner $script:appByName['IT Service Management'].id
        $best.Name  | Should -Be 'Eva Fischer'
        $best.Count | Should -Be 3
        $best.Total | Should -Be 5
        # Wendy Xu owns one group there too: the guess has a runner-up to beat.
        $monitoring = @($script:data.resources | Where-Object { $_.displayName -eq 'SG-Monitoring-Tools' -and $_.resourceType -eq 'Group' })[0].id
        @($script:ownersOfResource[$monitoring] | ForEach-Object { $script:principalById[$_].displayName }) | Should -Be @('Wendy Xu')
    }

    It 'finds an owner for Privileged Access Management, but below the threshold' {
        $best = Get-BestOwner $script:appByName['Privileged Access Management'].id
        $best.Count | Should -Be 1
        $best.Share | Should -BeLessThan 0.4
    }

    It 'finds no owner at all for the Employee Portal & Intranet (the empty state)' {
        $best = Get-BestOwner $script:appByName['Employee Portal & Intranet'].id
        $best.Count | Should -Be 0
        $best.Total | Should -BeGreaterThan 0
    }

    It 'owns the new groups through the ownership model: a GroupOwnership resource, HasOwnership, a Direct assignment' {
        foreach ($name in @('SG-Finance-Reports', 'SG-Servicedesk-Tools', 'SG-Servicedesk-KB', 'SG-Servicedesk-Admin', 'SG-Monitoring-Tools')) {
            $own = @($script:data.resources | Where-Object { $_.displayName -eq $name -and $_.resourceType -eq 'GroupOwnership' })
            $own.Count | Should -Be 1 -Because $name
            $group = @($script:data.resources | Where-Object { $_.displayName -eq $name -and $_.resourceType -eq 'Group' })[0]
            $own[0].extendedAttributes.ownedResourceId | Should -Be $group.id
            @($script:data.resourceRelationships | Where-Object {
                $_.parentResourceId -eq $group.id -and $_.childResourceId -eq $own[0].id -and $_.relationshipType -eq 'HasOwnership'
            }).Count | Should -Be 1
            @($script:data.resourceAssignments | Where-Object {
                $_.resourceId -eq $own[0].id -and $_.assignmentType -eq 'Direct' -and $_.resourceType -eq 'GroupOwnership'
            }).Count | Should -Be 1
        }
    }
}

Describe 'Demo applications — the Security Team as its resources' {

    BeforeAll {
        $script:people  = @($script:data.contexts | Where-Object { $_.displayName -eq 'Security Team' })[0]
        $script:variant = @($script:data.contexts | Where-Object { $_.displayName -eq 'Security Team (resources)' })[0]
    }

    It 'is an organizational unit that holds resources, owned by the HR system' {
        $script:variant.contextType   | Should -Be 'Team'
        $script:variant.targetType    | Should -Be 'Resource'
        $script:variant.scopeSystemId | Should -Be $script:hrSystemId
        $names = @($script:membersOf[$script:variant.id] | ForEach-Object { $script:resById[$_.memberId].displayName } | Sort-Object)
        $names | Should -Be @('Global Administrator', 'SG-Admin-Tier0', 'SG-PAM-Users')
    }

    It 'is linked SameUnitAs to the people context, and that is the only link' {
        @($script:data.contextRelationships).Count | Should -Be 1
        $link = $script:data.contextRelationships[0]
        $link.relationshipType | Should -Be 'SameUnitAs'
        $link.contextId        | Should -Be $script:people.id
        $link.relatedContextId | Should -Be $script:variant.id
        $script:people.targetType | Should -Be 'Principal'
    }
}

Describe 'Demo applications — determinism and counts' {

    It 'generates the same contexts, members and roles on every run' {
        & $script:genScript -OutputPath $script:outPath2 | Out-Null
        $again = Get-Content $script:outPath2 -Raw | ConvertFrom-Json
        foreach ($section in @('contexts', 'contextMembers', 'contextRoles', 'contextRelationships', 'resources')) {
            ($again.$section | ConvertTo-Json -Depth 10 -Compress) | Should -Be ($script:data.$section | ConvertTo-Json -Depth 10 -Compress) -Because $section
        }
    }

    It 'reports the new sections in the metadata counts' {
        $script:data.metadata.entityCounts.contexts             | Should -Be 17
        $script:data.metadata.entityCounts.contextRoles         | Should -Be 7
        $script:data.metadata.entityCounts.contextRelationships | Should -Be 1
    }
}

Describe 'Get-DemoResourceIdByName' {

    BeforeAll {
        $parts = Join-Path $script:demoDir 'parts'
        . (Join-Path $parts 'DemoState.ps1')
        . (Join-Path $parts 'DemoApplications.ps1')
        $script:state = New-DemoState
        $null = Add-DemoResource $script:state -Id 'g1' -DisplayName 'SG-X' -ResourceType 'Group' -SystemId 1
        $null = Add-DemoResource $script:state -Id 'o1' -DisplayName 'SG-X' -ResourceType 'GroupOwnership' -SystemId 1
        $null = Add-DemoResource $script:state -Id 'd1' -DisplayName 'Dup' -ResourceType 'Group' -SystemId 1
        $null = Add-DemoResource $script:state -Id 'd2' -DisplayName 'Dup' -ResourceType 'AppRole' -SystemId 1
    }

    It 'returns the group, not the ownership resource named after it' {
        Get-DemoResourceIdByName $script:state 'SG-X' | Should -Be 'g1'
    }

    It 'matches the name case-sensitively' {
        { Get-DemoResourceIdByName $script:state 'sg-x' } | Should -Throw '*found 0*'
    }

    It 'stops the build on an unknown or an ambiguous name' {
        { Get-DemoResourceIdByName $script:state 'Nope' } | Should -Throw "*'Nope', found 0*"
        { Get-DemoResourceIdByName $script:state 'Dup' }  | Should -Throw "*'Dup', found 2*"
    }
}
